// SPDX-License-Identifier: Apache-2.0
// Provisions the `devtunnel` transport: a local relay server (relayServer.mjs) exposed publicly
// through a Microsoft Dev Tunnel, so the phone can reach it without any cloud relay account
// (Supabase/Web PubSub). This is the ONE place in Weft that shells out to the `devtunnel` CLI;
// everything downstream (shared/transport-relay.mjs, the mobile devtunnel branch in
// weftClient.ts) only ever sees a plain `wss://` URL and knows nothing about tunnels, tokens, or
// the CLI. Access is anonymous-connect: the tunnel URL is short-lived/pairing-scoped and travels
// inside the same QR as the (never-anonymous) end-to-end encryption keys, so — as transport.d.ts
// calls out for the "devtunnel" descriptor kind — embedding it is safe even though it's not a
// durable secret.
//
// SHARED ACROSS SESSIONS: Dev Tunnels are capped at 10 per account (a hard Microsoft quota), and
// every `/weft devtunnel` call used to provision a brand-new tunnel — a handful of crashed/killed
// sessions (which skip graceful shutdown) would leak tunnels toward that ceiling. So the actual
// relay + tunnel now lives in a DETACHED child process (relayServerProcess.mjs) that outlives any
// one CLI session, discoverable via a small registry file at ~/.weft/devtunnel.json (see
// registryFile.mjs). The first `/weft devtunnel` anywhere on the machine spawns it; every
// subsequent call (from this session or any other) just reuses it. Nothing here "owns" tearing it
// down — relayServerProcess.mjs watches its own room occupancy and self-deletes the tunnel once
// idle for a while, so no CLI session's shutdown (clean or crashed) needs to coordinate cleanup.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";
import { isPidAlive, readRegistry } from "./registryFile.mjs";

const execFileAsync = promisify(execFile);

export const DEVTUNNEL_REGISTRY_FILE = "devtunnel.json";
const RELAY_SERVER_PROCESS_PATH = fileURLToPath(new URL("./relayServerProcess.mjs", import.meta.url));
// First-ever provision on a machine has to: spawn the detached relay process, have IT shell out to
// `devtunnel host` (a real network call to Microsoft's tunnel service), and wait for that tunnel's
// URL to come back before the registry read here sees a healthy entry — 20s cut this close on a
// slow/loaded network. Bumped to 45s of headroom; still overridable per-machine via
// WEFT_DEVTUNNEL_TIMEOUT_MS for anyone on a particularly slow connection.
const PROVISION_TIMEOUT_MS = positiveIntFromEnv("WEFT_DEVTUNNEL_TIMEOUT_MS", 45_000);
const REGISTRY_POLL_MS = 100;

function positiveIntFromEnv(name, fallback) {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

// winget installs devtunnel.exe here without adding it to PATH until the shell is restarted —
// fall back to this well-known location so Weft works in the same session it was installed in.
function candidateBinaries() {
  const candidates = ["devtunnel"];
  if (process.env.WEFT_DEVTUNNEL_BIN) candidates.unshift(process.env.WEFT_DEVTUNNEL_BIN);
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    candidates.push(
      `${localAppData}\\Microsoft\\WinGet\\Packages\\Microsoft.devtunnel_Microsoft.Winget.Source_8wekyb3d8bbwe\\devtunnel.exe`,
    );
  }
  return candidates;
}

let cachedBin; // resolved once per process — the binary's location doesn't change mid-run.

/** Locate a working `devtunnel` binary, or null if none of the candidates run. */
export async function findDevTunnelBinary() {
  if (cachedBin !== undefined) return cachedBin;
  for (const candidate of candidateBinaries()) {
    try {
      if (candidate !== "devtunnel" && !existsSync(candidate)) continue;
      await execFileAsync(candidate, ["--version"], { shell: process.platform === "win32" });
      cachedBin = candidate;
      return cachedBin;
    } catch {
      // Try the next candidate.
    }
  }
  cachedBin = null;
  return null;
}

/** Run a `devtunnel` subcommand to completion and return its stdout. Exported for
 * relayServerProcess.mjs's use — this is the ONE shared exec helper for the CLI. */
export async function run(bin, args) {
  const { stdout } = await execFileAsync(bin, args, { shell: process.platform === "win32" });
  return stdout;
}

/**
 * Cross-platform-safe process-tree kill for a child that was spawned with shell:true on Windows
 * (required to launch a .cmd/.bat shim directly; harmless for a real .exe too) — that wraps it in
 * a cmd.exe parent, so a plain child.kill() only kills the shell and leaves the actual process
 * (and anything IT spawned) running forever. `taskkill /t` kills the whole process tree by pid;
 * POSIX doesn't need this since there's no shell wrapper. Exported for relayServerProcess.mjs.
 */
export async function killProcessTree(child) {
  if (!child.pid) return;
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
    } catch {
      // best-effort — process may have already exited.
    }
    return;
  }
  try {
    child.kill();
  } catch {
    // best-effort
  }
}

/** Probe whether a relay server is actually accepting connections on 127.0.0.1:port — guards
 * against a stale/reused pid whose registry entry no longer corresponds to a live relay. */
function probeRelay(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.terminate();
      } catch {
        // best-effort
      }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    let socket;
    try {
      socket = new WebSocket(`ws://127.0.0.1:${port}/?channelId=__weft_healthcheck__`);
    } catch {
      clearTimeout(timer);
      resolve(false);
      return;
    }
    socket.once("open", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function healthyRegistryEntry(baseDir) {
  const entry = readRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir });
  if (!entry || !isPidAlive(entry.pid) || !entry.relayPort || !entry.baseUrl) return null;
  const alive = await probeRelay(entry.relayPort);
  return alive ? entry : null;
}

/**
 * Provision (or, in the common case, discover and reuse) the devtunnel transport for
 * `channelId`. Throws an actionable error if the CLI is missing or the user isn't logged in —
 * both are one-time, user-fixable setup steps, so `/weft devtunnel`'s caller is expected to
 * surface err.message directly rather than retry.
 */
export async function provisionDevTunnelTransport({ channelId, baseDir } = {}) {
  if (!channelId) throw new Error("Weft: provisionDevTunnelTransport requires a channelId");

  const existing = await healthyRegistryEntry(baseDir);
  if (existing) return descriptorFor(existing.baseUrl, channelId);

  const bin = await findDevTunnelBinary();
  if (!bin) {
    throw new Error(
      "Weft: the devtunnel CLI isn't installed. Run `winget install Microsoft.devtunnel`, " +
        "then `devtunnel user login -g`, and try /weft devtunnel again.",
    );
  }
  try {
    await run(bin, ["user", "show"]);
  } catch {
    // Not logged in (or the token expired) — `login -g` opens the user's default browser for a
    // GitHub device-code flow and blocks until they complete it, so just run it instead of making
    // the user retype the command themselves.
    try {
      await run(bin, ["user", "login", "-g"]);
    } catch {
      throw new Error(
        "Weft: automatic devtunnel login failed. Run `devtunnel user login -g` manually and try again.",
      );
    }
  }

  const entry = await spawnRelayServerProcess({ bin, baseDir });
  return descriptorFor(entry.baseUrl, channelId);
}

function descriptorFor(baseUrl, channelId) {
  return { kind: "devtunnel", url: `${baseUrl}?channelId=${encodeURIComponent(channelId)}` };
}

// Spawns relayServerProcess.mjs DETACHED (survives this process's exit) and waits for it to
// publish a healthy registry entry. A second caller racing this one (e.g. two `/weft devtunnel`
// calls on different machines' sessions at nearly the same moment) will each spawn their own
// process — a harmless, self-resolving race: relayServerProcess.mjs's own registry write is
// atomic, and either process type ends up as a temporarily-unused, soon-to-self-idle-out relay,
// not a correctness problem for pairing itself.
async function spawnRelayServerProcess({ bin, baseDir }) {
  const env = { ...process.env };
  if (baseDir) env.WEFT_HOME = baseDir;
  if (bin) env.WEFT_DEVTUNNEL_BIN = bin;
  const child = spawn(process.execPath, [RELAY_SERVER_PROCESS_PATH], {
    detached: true,
    stdio: "ignore",
    env,
  });
  child.unref();

  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const entry = await healthyRegistryEntry(baseDir);
    if (entry) return entry;
    await new Promise((r) => setTimeout(r, REGISTRY_POLL_MS));
  }
  throw new Error("Weft: timed out waiting for the shared devtunnel relay to come up");
}

/**
 * No-op by design: the shared relay + tunnel (relayServerProcess.mjs) is a DETACHED process that
 * outlives any single CLI session and tears itself down on its own idle timer (see that file) —
 * no session's shutdown owns or coordinates that lifecycle anymore. Kept exported so
 * extension.mjs's existing shutdown() call site doesn't need special-casing.
 */
export async function stopDevTunnel() {
  // Intentionally empty.
}

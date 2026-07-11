// SPDX-License-Identifier: Apache-2.0
// Provisions the `devtunnel` transport: a local relay server (relayServer.mjs) exposed publicly
// through a Microsoft Dev Tunnel, so the phone can reach it without any cloud relay account
// (Supabase/Web PubSub). This is the ONE place in Weft that shells out to the `devtunnel` CLI;
// everything downstream (shared/transport-relay.mjs, the mobile devtunnel branch in
// weftClient.ts) only ever sees a plain `wss://` URL and knows nothing about tunnels, tokens, or
// the CLI. Access is anonymous-connect: the relay's base URL is channel-agnostic and travels
// inside the same QR as the (never-anonymous) end-to-end encryption keys, so — as
// transport.d.ts calls out for the "devtunnel" descriptor kind — embedding it is safe even
// though it's not a durable secret.
//
// SHARED ACROSS SESSIONS + TERMINAL-OWNED LIFECYCLE: Dev Tunnels are capped at 10 per account (a
// hard Microsoft quota), so Weft provisions ONE shared relay + tunnel per machine, living in a
// child process (relayServerProcess.mjs) whose lifetime is tied to the terminal that ran
// `weft devtunnel start`. Every other consumer (`weft start`, `/weft` in a Copilot session)
// discovers it via a small registry file at ~/.weft/devtunnel.json (see registryFile.mjs).
// Close that terminal (or Ctrl+C, or `weft devtunnel stop` from anywhere) → relay dies, cloud
// tunnel is deleted, registry cleared. No idle self-teardown: the terminal is the visible,
// explicit owner, exactly like `ngrok` / `cloudflared tunnel` — nothing lingers in the
// background silently.
//
// The pairing path (`/weft`, `weft start` → resolveDevTunnelTransport) is symmetric with the
// Supabase transport: it just *uses* the relay, exactly like the Supabase client just uses a
// cloud project. It never spawns, never logs in, never waits. The USER brings the relay up
// explicitly via `weft devtunnel start` (which is the only caller of ensureDevTunnelRelay below);
// if it isn't running, pairing throws an actionable error pointing at that command.
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import WebSocket from "ws";
import { clearRegistry, isPidAlive, readRegistry } from "./registryFile.mjs";

const execFileAsync = promisify(execFile);

export const DEVTUNNEL_REGISTRY_FILE = "devtunnel.json";
// Interim "still working on it" file: relayServerProcess.mjs updates this at each provisioning
// stage (see STAGE_LABELS below) BEFORE the final healthy entry lands in DEVTUNNEL_REGISTRY_FILE,
// so a poller here can show real progress instead of silence for the whole provisioning window.
export const DEVTUNNEL_STATUS_FILE = "devtunnel-status.json";
const RELAY_SERVER_PROCESS_PATH = fileURLToPath(new URL("./relayServerProcess.mjs", import.meta.url));
// First-ever provision on a machine has to: spawn the relay child process, have IT shell out to
// `devtunnel host` (a real network call to Microsoft's tunnel service), and wait for that tunnel's
// URL to come back before the registry read here sees a healthy entry — 20s cut this close on a
// slow/loaded network. Bumped to 45s of headroom; still overridable per-machine via
// WEFT_DEVTUNNEL_TIMEOUT_MS for anyone on a particularly slow connection. On top of that, the
// whole provision now auto-retries (see ensureDevTunnelRelay) rather than hard-failing the
// instant one cycle elapses — WEFT_DEVTUNNEL_MAX_WAIT_MS caps how long that retrying continues
// before finally giving up and pointing the user at the standalone `weft devtunnel` CLI. These
// only apply to the explicit `weft devtunnel start` path; the pairing path never waits.
const PROVISION_TIMEOUT_MS = positiveIntFromEnv("WEFT_DEVTUNNEL_TIMEOUT_MS", 45_000);
const MAX_WAIT_MS = positiveIntFromEnv("WEFT_DEVTUNNEL_MAX_WAIT_MS", 120_000);
const REGISTRY_POLL_MS = 100;

// Ordered, human-readable labels for each stage relayServerProcess.mjs reports through
// DEVTUNNEL_STATUS_FILE. Shared by extension.mjs (session.log) and bin/weft.mjs (CLI status line)
// so both surfaces describe the exact same provisioning step identically.
export const STAGE_LABELS = {
  "starting-relay": "starting the local relay server…",
  "creating-tunnel": "creating the dev tunnel…",
  "creating-port": "configuring the tunnel port…",
  "creating-access": "setting anonymous access on the tunnel…",
  hosting: "hosting the tunnel (devtunnel host)…",
  "waiting-for-url": "waiting for the tunnel's public URL…",
};

/** Human-readable label for a provisioning stage, or the raw stage string if unrecognized. */
export function describeStage(stage) {
  return STAGE_LABELS[stage] ?? stage;
}

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
 * against a stale/reused pid whose registry entry no longer corresponds to a live relay. Exported
 * for bin/weft.mjs's standalone `weft devtunnel status` command. */
export function probeRelay(port, timeoutMs = 1500) {
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

/** Reads DEVTUNNEL_REGISTRY_FILE and confirms it's a live, connectable relay (not a stale entry
 * from a pid that's since exited or a port nothing is listening on). Exported for the standalone
 * `weft devtunnel status` CLI command. */
export async function healthyRegistryEntry(baseDir) {
  const entry = readRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir });
  if (!entry || !isPidAlive(entry.pid) || !entry.relayPort || !entry.baseUrl) return null;
  const alive = await probeRelay(entry.relayPort);
  return alive ? entry : null;
}

/**
 * Provisions (or discovers and attaches to) the shared devtunnel relay itself — no channelId
 * required, since the relay/tunnel is a single machine-wide resource shared across every pairing
 * session (see the SHARED ACROSS SESSIONS note at the top of this file). Returns
 * `{ baseUrl, child }` where `child` is the spawned relay ChildProcess if this call brought the
 * relay up (so the caller owns its lifetime — `weft devtunnel start` blocks on `child.exit`), or
 * `null` if a healthy relay was already running (so the caller is just watching, and should not
 * kill anything on its own Ctrl+C). Throws an actionable error if the CLI is missing or the user
 * isn't logged in — both are one-time, user-fixable setup steps, so callers are expected to
 * surface err.message directly rather than retry.
 *
 * `onProgress(stage)` fires whenever the relay child's reported provisioning stage changes (see
 * STAGE_LABELS) — lets a caller (the standalone CLI's live status line) show real progress
 * instead of silence. `onRetry(attempt, maxAttempts)` fires each time one PROVISION_TIMEOUT_MS
 * cycle elapses without success and another begins (see MAX_WAIT_MS) — the child process itself
 * is NOT respawned on retry, only re-polled, since it keeps running/working regardless of how
 * long we watch it.
 */
export async function ensureDevTunnelRelay({ baseDir, onProgress, onRetry } = {}) {
  const existing = await healthyRegistryEntry(baseDir);
  if (existing) return { baseUrl: existing.baseUrl, child: null };

  const bin = await findDevTunnelBinary();
  if (!bin) {
    throw new Error(
      "Weft: the devtunnel CLI isn't installed. Run `winget install Microsoft.devtunnel`, " +
        "then `devtunnel user login -g`, and try `weft devtunnel start` again.",
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

  // Spawn the relay child exactly once, no matter how many PROVISION_TIMEOUT_MS cycles the retry
  // loop below runs — it keeps working regardless of how long we poll for its registry entry, so
  // a later cycle just needs to re-poll, not re-spawn.
  const child = spawnRelayServerProcess({ bin, baseDir });

  const maxAttempts = Math.max(1, Math.ceil(MAX_WAIT_MS / PROVISION_TIMEOUT_MS));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const entry = await pollForHealthyEntry({ baseDir, onProgress });
      return { baseUrl: entry.baseUrl, child };
    } catch (err) {
      if (attempt >= maxAttempts) {
        // Exhaust path: the child never published a healthy registry entry. Tear it (and any
        // half-provisioned cloud tunnel) down before throwing, otherwise the attached child
        // would keep our parent's event loop alive forever after the CLI already gave up.
        await forceStopDevTunnel({ baseDir }).catch(() => {});
        try { child.kill(); } catch { /* best-effort */ }
        throw new Error(
          "Weft: devtunnel is taking longer than usual to come up on this machine. Check your " +
            "network + `devtunnel user login -g`, then re-run `weft devtunnel start`.",
        );
      }
      onRetry?.(attempt, maxAttempts);
    }
  }
  // Unreachable (loop always returns or throws), but keeps this function's return type honest.
  throw new Error("Weft: timed out waiting for the shared devtunnel relay to come up");
}

/**
 * Read-only lookup for the pairing path: returns a devtunnel transport descriptor if a healthy
 * shared relay is already running on this machine (i.e. the user ran `weft devtunnel start`
 * earlier), or throws an actionable error pointing at that command if not. Fully symmetric with
 * the Supabase transport: descriptor carries connection info only (`{kind, url: baseUrl}`), never
 * a channelId — channel/room selection happens at socket-construction time in
 * createTransportFromDescriptor (extension) / weftClient.ts (mobile), exactly like Supabase's
 * `createSupabaseTransport({client, channelId})`. Does NOT shell out to the `devtunnel` CLI,
 * spawn any process, or wait — for that, use ensureDevTunnelRelay() (only the standalone
 * `weft devtunnel start` CLI should).
 */
export async function resolveDevTunnelTransport({ baseDir } = {}) {
  const entry = await healthyRegistryEntry(baseDir);
  if (!entry) {
    throw new Error(
      "Weft: no devtunnel relay is running on this machine. Run `weft devtunnel start` first, " +
        "then retry. (`weft devtunnel status` shows the current state.)",
    );
  }
  return { kind: "devtunnel", url: entry.baseUrl };
}

// Spawns relayServerProcess.mjs as an ATTACHED child (NOT detached): its lifetime is tied to
// this Node process, whose lifetime in turn is tied to the terminal that ran `weft devtunnel
// start`. stdio is fully ignored — the parent CLI prints its own status line (see bin/weft.mjs's
// devtunnelStart), so the child's own progress goes through DEVTUNNEL_STATUS_FILE, not stdout,
// and any host-process output stays out of the user's terminal. A second caller racing this one
// (e.g. two `weft devtunnel start` terminals opened simultaneously) will each spawn their own
// child — a harmless race: relayServerProcess.mjs's own registry write is atomic, and the loser
// ends up as a temporarily-unused relay that the parent kills on Ctrl+C, not a correctness
// problem for pairing itself.
function spawnRelayServerProcess({ bin, baseDir }) {
  const env = { ...process.env };
  if (baseDir) env.WEFT_HOME = baseDir;
  if (bin) env.WEFT_DEVTUNNEL_BIN = bin;
  return spawn(process.execPath, [RELAY_SERVER_PROCESS_PATH], {
    stdio: "ignore",
    env,
  });
}

/** Polls for up to PROVISION_TIMEOUT_MS for a healthy registry entry, calling `onProgress(stage)`
 * whenever the interim DEVTUNNEL_STATUS_FILE's reported stage changes. Throws on timeout — the
 * caller (ensureDevTunnelRelay's retry loop) decides whether to give up or poll again. */
async function pollForHealthyEntry({ baseDir, onProgress }) {
  let lastStage;
  const deadline = Date.now() + PROVISION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const entry = await healthyRegistryEntry(baseDir);
    if (entry) return entry;
    const status = readRegistry(DEVTUNNEL_STATUS_FILE, { baseDir });
    if (status?.stage && status.stage !== lastStage) {
      lastStage = status.stage;
      onProgress?.(status.stage);
    }
    await new Promise((r) => setTimeout(r, REGISTRY_POLL_MS));
  }
  throw new Error("Weft: timed out waiting for the shared devtunnel relay to come up");
}

/**
 * Force-tears-down the shared relay + tunnel right now: kills the relay process tree (if its
 * registered pid is alive), best-effort deletes the cloud tunnel, and clears both registry files.
 * This is both the standalone `weft devtunnel stop` CLI command AND the primary cleanup path
 * `weft devtunnel start`'s own Ctrl+C handler runs — uniform across platforms because it uses
 * taskkill/process.kill directly rather than trying to deliver a signal the child can handle
 * (Windows has no POSIX signals, so a forwarded SIGTERM would just force-kill the child without
 * running its cleanup handlers anyway).
 */
export async function forceStopDevTunnel({ baseDir } = {}) {
  const entry = readRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir });
  if (!entry) {
    clearRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir });
    clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir });
    return { stopped: false };
  }
  if (isPidAlive(entry.pid)) {
    if (process.platform === "win32") {
      try {
        await execFileAsync("taskkill", ["/pid", String(entry.pid), "/t", "/f"]);
      } catch {
        // best-effort — process may have already exited.
      }
    } else {
      try {
        process.kill(entry.pid);
      } catch {
        // best-effort
      }
    }
  }
  if (entry.tunnelId) {
    const bin = await findDevTunnelBinary();
    if (bin) {
      try {
        await run(bin, ["delete", entry.tunnelId, "--force"]);
      } catch {
        // best-effort — an orphaned tunnel just expires after 30 days.
      }
    }
  }
  clearRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir });
  clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir });
  return { stopped: true, entry };
}

/**
 * No-op by design: `/weft` in a Copilot session (extension.mjs) never owns the shared relay —
 * only the terminal that ran `weft devtunnel start` does. Kept exported so extension.mjs's
 * existing shutdown() call site doesn't need special-casing; delete both together if you ever do.
 */
export async function stopDevTunnel() {
  // Intentionally empty.
}

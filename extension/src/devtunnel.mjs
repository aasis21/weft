// SPDX-License-Identifier: Apache-2.0
// Provisions the `devtunnel` transport: a local relay server (relayServer.mjs) exposed publicly
// through a Microsoft Dev Tunnel, so the phone can reach it without any cloud relay account
// (Supabase/Web PubSub) — see the design discussion this followed. This is the ONE place in Helm
// that shells out to the `devtunnel` CLI; everything downstream (shared/transport-relay.mjs, the
// mobile devtunnel branch in helmClient.ts) only ever sees a plain `wss://` URL and knows nothing
// about tunnels, tokens, or the CLI. Access is anonymous-connect (like the reference e2e test run
// during development): the tunnel URL is short-lived/pairing-scoped and travels inside the same
// QR as the (never-anonymous) end-to-end encryption keys, so — as transport.d.ts calls out for the
// "devtunnel" descriptor kind — embedding it is safe even though it's not a durable secret.
import { spawn, execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { startRelayServer } from "./relayServer.mjs";

const execFileAsync = promisify(execFile);

// winget installs devtunnel.exe here without adding it to PATH until the shell is restarted —
// fall back to this well-known location so Helm works in the same session it was installed in.
function candidateBinaries() {
  const candidates = ["devtunnel"];
  if (process.env.HELM_DEVTUNNEL_BIN) candidates.unshift(process.env.HELM_DEVTUNNEL_BIN);
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

async function run(bin, args) {
  const { stdout } = await execFileAsync(bin, args, { shell: process.platform === "win32" });
  return stdout;
}

// Reused across `/helm devtunnel` calls within one laptop process — one relay server + one tunnel
// is plenty (rooms are keyed by channelId, so a fresh pairing channel doesn't need a fresh tunnel).
let provisioned = null;

/**
 * Provision (or reuse) the devtunnel transport for `channelId`. Throws an actionable error if the
 * CLI is missing or the user isn't logged in — both are one-time, user-fixable setup steps, so
 * `/helm devtunnel`'s caller is expected to surface err.message directly rather than retry.
 */
export async function provisionDevTunnelTransport({ channelId }) {
  if (!channelId) throw new Error("Helm: provisionDevTunnelTransport requires a channelId");

  const bin = await findDevTunnelBinary();
  if (!bin) {
    throw new Error(
      "Helm: the devtunnel CLI isn't installed. Run `winget install Microsoft.devtunnel`, " +
        "then `devtunnel user login -g`, and try /helm devtunnel again.",
    );
  }

  if (!provisioned) {
    try {
      await run(bin, ["user", "show"]);
    } catch {
      throw new Error("Helm: not logged in to devtunnel. Run `devtunnel user login -g` and try again.");
    }
    provisioned = await createTunnelAndHost(bin);
  }

  const url = `${provisioned.baseUrl}?channelId=${encodeURIComponent(channelId)}`;
  return { kind: "devtunnel", url };
}

async function createTunnelAndHost(bin) {
  const relay = startRelayServer();
  await relay.ready;

  let tunnelId;
  try {
    const createOut = await run(bin, ["create", "--json"]);
    tunnelId = JSON.parse(createOut).tunnel.tunnelId;
    await run(bin, ["port", "create", tunnelId, "-p", String(relay.port), "--protocol", "http"]);
    await run(bin, ["access", "create", tunnelId, "--anonymous", "--scopes", "connect"]);
  } catch (err) {
    await relay.close();
    throw new Error(`Helm: devtunnel setup failed: ${err?.message ?? err}`);
  }

  const host = spawn(bin, ["host", tunnelId], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  const baseUrl = await new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk.toString();
      const match = buffer.match(/https:\/\/\S+\.devtunnels\.ms/);
      if (match) {
        host.stdout.off("data", onData);
        resolve(match[0].replace(/^https:/, "wss:"));
      }
    };
    host.stdout.on("data", onData);
    host.once("error", reject);
    host.once("exit", (code) => reject(new Error(`Helm: devtunnel host exited early (code ${code})`)));
    setTimeout(() => reject(new Error("Helm: timed out waiting for devtunnel host to come up")), 20_000);
  });

  return { tunnelId, host, relay, baseUrl };
}

/** Tear down the hosted tunnel + relay server + cloud tunnel (best-effort). Call on shutdown. */
export async function stopDevTunnel() {
  if (!provisioned) return;
  const { host, relay, tunnelId } = provisioned;
  provisioned = null;
  await killProcessTree(host);
  await relay.close().catch(() => {});
  const bin = await findDevTunnelBinary();
  if (bin) {
    try {
      await run(bin, ["delete", tunnelId, "--force"]);
    } catch {
      // best-effort — an orphaned tunnel just expires after 30 days.
    }
  }
}

// `host` was spawned with shell:true on Windows (required to launch a .cmd/.bat shim directly;
// harmless for a real .exe too) — that wraps it in a cmd.exe parent, so a plain host.kill() only
// kills the shell and leaves the actual devtunnel process (and anything IT spawned) running
// forever, which in turn keeps the extension process alive past session shutdown. `taskkill /t`
// kills the whole process tree by pid; POSIX doesn't need this since there's no shell wrapper.
async function killProcessTree(child) {
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

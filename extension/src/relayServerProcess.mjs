// SPDX-License-Identifier: Apache-2.0
// Entry point for the SHARED devtunnel relay: spawned DETACHED by devtunnel.mjs's
// provisionDevTunnelTransport() the first time any Weft CLI session on this machine requests the
// `devtunnel` transport, and reused by every session (this one or any other) after that via the
// registry file it publishes at ~/.weft/devtunnel.json. It owns the full lifecycle of ONE relay
// server + ONE Dev Tunnel + the `devtunnel host` process:
//   - starts the local WS relay (relayServer.mjs)
//   - creates + ports + hosts a Dev Tunnel pointed at that relay
//   - publishes {pid, relayPort, tunnelId, baseUrl, startedAt} so other processes can find it
//   - watches its own room occupancy; once nobody has been connected for IDLE_TIMEOUT_MS, deletes
//     the cloud tunnel, clears the registry file, and exits
// No CLI session's shutdown owns tearing this down — it tears itself down. This keeps Weft's
// no-daemon philosophy intact in spirit: nothing is started eagerly or run as an installed
// service, it's just a plain child process that happens to detach and self-manage its own exit.
import { fileURLToPath } from "node:url";
import { startRelayServer } from "./relayServer.mjs";
import { findDevTunnelBinary, killProcessTree, run, DEVTUNNEL_REGISTRY_FILE } from "./devtunnel.mjs";
import { clearRegistry, writeRegistryAtomic } from "./registryFile.mjs";
import { spawn } from "node:child_process";

const IDLE_TIMEOUT_MS = Number(process.env.WEFT_DEVTUNNEL_IDLE_MS) || 5 * 60_000;
const IDLE_CHECK_MS = Number(process.env.WEFT_DEVTUNNEL_CHECK_MS) || 30_000;
const HOST_STARTUP_TIMEOUT_MS = 20_000;

export async function main() {
  const bin = await findDevTunnelBinary();
  if (!bin) {
    process.exitCode = 1;
    return;
  }

  const relay = startRelayServer();
  await relay.ready;

  let tunnelId;
  let host;
  let idleTimer;
  let lastNonIdleAt = Date.now();

  const teardown = async () => {
    if (idleTimer) clearInterval(idleTimer);
    if (host) await killProcessTree(host);
    await relay.close().catch(() => {});
    if (tunnelId) {
      try {
        await run(bin, ["delete", tunnelId, "--force"]);
      } catch {
        // best-effort — an orphaned tunnel just expires after 30 days.
      }
    }
    clearRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir: process.env.WEFT_HOME });
  };

  try {
    const createOut = await run(bin, ["create", "--json"]);
    tunnelId = JSON.parse(createOut).tunnel.tunnelId;
    await run(bin, ["port", "create", tunnelId, "-p", String(relay.port), "--protocol", "http"]);
    await run(bin, ["access", "create", tunnelId, "--anonymous", "--scopes", "connect"]);
  } catch {
    await relay.close().catch(() => {});
    process.exitCode = 1;
    return;
  }

  host = spawn(bin, ["host", tunnelId], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  let baseUrl;
  try {
    baseUrl = await new Promise((resolve, reject) => {
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
      host.once("exit", (code) => reject(new Error(`devtunnel host exited early (code ${code})`)));
      setTimeout(() => reject(new Error("timed out waiting for devtunnel host")), HOST_STARTUP_TIMEOUT_MS);
    });
  } catch {
    await teardown();
    process.exitCode = 1;
    return;
  }

  writeRegistryAtomic(
    DEVTUNNEL_REGISTRY_FILE,
    { pid: process.pid, relayPort: relay.port, tunnelId, baseUrl, startedAt: Date.now() },
    { baseDir: process.env.WEFT_HOME },
  );

  idleTimer = setInterval(() => {
    if (relay.totalConnections() > 0) {
      lastNonIdleAt = Date.now();
      return;
    }
    if (Date.now() - lastNonIdleAt >= IDLE_TIMEOUT_MS) {
      void teardown().then(() => process.exit(0));
    }
  }, IDLE_CHECK_MS);
  idleTimer.unref?.();

  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      void teardown().then(() => process.exit(0));
    });
  }
}

// Only run when invoked directly as the process entry point (spawned by devtunnel.mjs) — not
// when merely imported (e.g. so a future test can import shared pieces without side effects).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main();
}

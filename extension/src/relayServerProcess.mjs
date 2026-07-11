// SPDX-License-Identifier: Apache-2.0
// Entry point for the SHARED devtunnel relay: spawned as an ATTACHED child by devtunnel.mjs's
// ensureDevTunnelRelay() when a user runs `weft devtunnel start` on this machine, and reused by
// every subsequent pairing session (this one or any other) via the registry file it publishes at
// ~/.weft/devtunnel.json. It owns the full lifecycle of ONE relay server + ONE Dev Tunnel + the
// `devtunnel host` process:
//   - starts the local WS relay (relayServer.mjs)
//   - creates + ports + hosts a Dev Tunnel pointed at that relay
//   - publishes {pid, relayPort, tunnelId, baseUrl, startedAt} so other processes can find it
//   - lives as long as its parent `weft devtunnel start` terminal is open; on SIGINT/SIGTERM
//     (Ctrl+C, terminal close, or `weft devtunnel stop` from anywhere) tears down the cloud
//     tunnel, clears the registry files, and exits
// The parent CLI is the primary owner (see devtunnel.mjs's forceStopDevTunnel — that's what the
// parent's Ctrl+C handler calls); these signal handlers are the POSIX safety net for the case
// where the parent dies uncleanly (kill -9) and the OS delivers SIGHUP down the process group.
import { fileURLToPath } from "node:url";
import { startRelayServer } from "./relayServer.mjs";
import { findDevTunnelBinary, killProcessTree, run, DEVTUNNEL_REGISTRY_FILE, DEVTUNNEL_STATUS_FILE } from "./devtunnel.mjs";
import { clearRegistry, writeRegistryAtomic } from "./registryFile.mjs";
import { spawn } from "node:child_process";

const HOST_STARTUP_TIMEOUT_MS = 20_000;

// Publishes the current provisioning stage to DEVTUNNEL_STATUS_FILE (see devtunnel.mjs's
// STAGE_LABELS) so devtunnel.mjs's poller — and through it, extension.mjs / the standalone CLI —
// can show real progress instead of silence while this process works through its startup steps.
function publishStage(stage) {
  writeRegistryAtomic(DEVTUNNEL_STATUS_FILE, { pid: process.pid, stage, updatedAt: Date.now() }, { baseDir: process.env.WEFT_HOME });
}

export async function main() {
  publishStage("starting-relay");
  const bin = await findDevTunnelBinary();
  if (!bin) {
    clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir: process.env.WEFT_HOME });
    process.exitCode = 1;
    return;
  }

  const relay = startRelayServer();
  await relay.ready;

  let tunnelId;
  let host;

  const teardown = async () => {
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
    clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir: process.env.WEFT_HOME });
  };

  try {
    publishStage("creating-tunnel");
    const createOut = await run(bin, ["create", "--json"]);
    tunnelId = JSON.parse(createOut).tunnel.tunnelId;
    publishStage("creating-port");
    await run(bin, ["port", "create", tunnelId, "-p", String(relay.port), "--protocol", "http"]);
    publishStage("creating-access");
    await run(bin, ["access", "create", tunnelId, "--anonymous", "--scopes", "connect"]);
  } catch {
    await relay.close().catch(() => {});
    clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir: process.env.WEFT_HOME });
    process.exitCode = 1;
    return;
  }

  publishStage("hosting");
  host = spawn(bin, ["host", tunnelId], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  let baseUrl;
  try {
    publishStage("waiting-for-url");
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
  clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir: process.env.WEFT_HOME });

  // Safety-net signal handlers: the parent CLI's Ctrl+C handler is the primary teardown path
  // (it calls devtunnel.mjs's forceStopDevTunnel — which taskkills this process and does the
  // same cleanup itself, needed on Windows where forwarded signals aren't real). These fire
  // only when the OS delivers a signal directly (POSIX SIGHUP from a dying parent terminal,
  // or a graceful `kill <pid>`), so we can still exit cleanly instead of leaving orphans.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
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

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
import { clearRegistry, readRegistry, writeRegistryAtomic } from "./registryFile.mjs";
import { isPersistentPairingEnabled } from "./transportConfig.mjs";
import { spawn } from "node:child_process";

const HOST_STARTUP_TIMEOUT_MS = 20_000;

// Publishes the current provisioning stage to DEVTUNNEL_STATUS_FILE (see devtunnel.mjs's
// STAGE_LABELS) so devtunnel.mjs's poller — and through it, extension.mjs / the standalone CLI —
// can show real progress instead of silence while this process works through its startup steps.
function publishStage(stage) {
  writeRegistryAtomic(DEVTUNNEL_STATUS_FILE, { pid: process.pid, stage, updatedAt: Date.now() }, { baseDir: process.env.WEFT_HOME });
}

export async function main() {
  const baseDir = process.env.WEFT_HOME;
  publishStage("starting-relay");
  const bin = await findDevTunnelBinary();
  if (!bin) {
    clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir });
    process.exitCode = 1;
    return;
  }

  // PERSISTENT TUNNEL: when the user opted into persistent pairing (`weft set-pairing persistent`),
  // a prior run left its tunnel identity behind in devtunnel.json (see teardown below) instead of
  // deleting it. Reusing that same tunnelId + local relayPort reproduces the exact same public URL
  // (wss://<host>-<port>.<cluster>.devtunnels.ms) so an already-paired phone reconnects with no
  // re-scan. In ephemeral mode `prior` stays null and everything below is byte-for-byte as before:
  // a brand-new tunnel each run, deleted on teardown.
  const persistent = isPersistentPairingEnabled({ baseDir });
  const prior = persistent ? readRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir }) : null;
  let reuseTunnelId = prior?.tunnelId ?? null;
  const desiredPort = Number.isInteger(prior?.relayPort) ? prior.relayPort : null;

  // The remembered tunnel may have been deleted out-of-band or expired (Dev Tunnels auto-expire
  // after 30 days idle) — probe it before committing to reuse, and fall back to a fresh create if
  // it's gone.
  if (reuseTunnelId) {
    try {
      await run(bin, ["show", reuseTunnelId]);
    } catch {
      reuseTunnelId = null;
    }
  }

  // Prefer the remembered local port so the public URL is unchanged. If it's occupied by something
  // else, fall back to an OS-assigned port — the URL's port suffix then changes (see the rescan
  // warning the CLI prints when it detects the baseUrl moved).
  let relay;
  if (reuseTunnelId && desiredPort) {
    try {
      relay = startRelayServer({ port: desiredPort });
      await relay.ready;
    } catch {
      relay = startRelayServer({ port: 0 });
      await relay.ready;
    }
  } else {
    relay = startRelayServer();
    await relay.ready;
  }

  let tunnelId = reuseTunnelId;
  let baseUrl;
  let host;

  const teardown = async () => {
    if (host) await killProcessTree(host);
    await relay.close().catch(() => {});
    // Persistent mode: KEEP the cloud tunnel and its identity so the next start reproduces the same
    // URL — just record that the relay is no longer alive (pid dropped) so pairing/status correctly
    // see it as down. Ephemeral mode: delete the tunnel and clear the registry, exactly as before.
    if (persistent && tunnelId && baseUrl) {
      writeRegistryAtomic(
        DEVTUNNEL_REGISTRY_FILE,
        { relayPort: relay.port, tunnelId, baseUrl, alive: false, stoppedAt: Date.now() },
        { baseDir },
      );
    } else {
      if (tunnelId) {
        try {
          await run(bin, ["delete", tunnelId, "--force"]);
        } catch {
          // best-effort — an orphaned tunnel just expires after 30 days.
        }
      }
      clearRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir });
    }
    clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir });
  };

  try {
    if (reuseTunnelId) {
      // Reuse the existing tunnel. Keep exactly ONE port mapping (the URL parser below grabs the
      // first devtunnels.ms URL host emits, so a stale second port would make the extracted URL
      // ambiguous): if our bound port differs from the remembered one, drop the stale mapping
      // first. port/access create are idempotent — "already exists" is fine, so ignore failures.
      if (relay.port !== desiredPort) {
        publishStage("creating-port");
        try {
          await run(bin, ["port", "delete", tunnelId, "-p", String(desiredPort)]);
        } catch {
          // best-effort — the stale mapping may already be gone.
        }
      }
      publishStage("creating-port");
      try {
        await run(bin, ["port", "create", tunnelId, "-p", String(relay.port), "--protocol", "http"]);
      } catch {
        // already mapped — fine.
      }
      publishStage("creating-access");
      try {
        await run(bin, ["access", "create", tunnelId, "--anonymous", "--scopes", "connect"]);
      } catch {
        // already granted — fine.
      }
    } else {
      publishStage("creating-tunnel");
      const createOut = await run(bin, ["create", "--json"]);
      tunnelId = JSON.parse(createOut).tunnel.tunnelId;
      publishStage("creating-port");
      await run(bin, ["port", "create", tunnelId, "-p", String(relay.port), "--protocol", "http"]);
      publishStage("creating-access");
      await run(bin, ["access", "create", tunnelId, "--anonymous", "--scopes", "connect"]);
    }
  } catch {
    await relay.close().catch(() => {});
    clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir });
    process.exitCode = 1;
    return;
  }

  publishStage("hosting");
  host = spawn(bin, ["host", tunnelId], { stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
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
    { pid: process.pid, relayPort: relay.port, tunnelId, baseUrl, startedAt: Date.now(), alive: true },
    { baseDir },
  );
  clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir });

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

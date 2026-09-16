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
import { findDevTunnelBinary, killProcessTree, run, spawnDevTunnelHost, DEVTUNNEL_REGISTRY_FILE, DEVTUNNEL_STATUS_FILE } from "./devtunnel.mjs";
import { clearRegistry, readRegistry, writeRegistryAtomic } from "./registryFile.mjs";
import { isPersistentPairingEnabled } from "./transportConfig.mjs";

const HOST_STARTUP_TIMEOUT_MS = 20_000;

// Publishes the current provisioning stage to DEVTUNNEL_STATUS_FILE (see devtunnel.mjs's
// STAGE_LABELS) so devtunnel.mjs's poller — and through it, extension.mjs / the standalone CLI —
// can show real progress instead of silence while this process works through its startup steps.
function publishStage(stage) {
  writeRegistryAtomic(DEVTUNNEL_STATUS_FILE, { pid: process.pid, stage, updatedAt: Date.now() }, { baseDir: process.env.WEFT_HOME });
}

function publishFailure(error) {
  writeRegistryAtomic(
    DEVTUNNEL_STATUS_FILE,
    {
      pid: process.pid,
      stage: "failed",
      error: error?.message ?? String(error),
      updatedAt: Date.now(),
    },
    { baseDir: process.env.WEFT_HOME },
  );
}

export function parseTunnelPorts(output) {
  const parsed = JSON.parse(output);
  const values = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed?.ports)
      ? parsed.ports
      : Array.isArray(parsed?.tunnelPorts)
        ? parsed.tunnelPorts
        : [];
  return values.map((value) => ({
    port: Number(value?.portNumber ?? value?.port),
    protocol: String(value?.protocol ?? "").toLowerCase(),
  })).filter(({ port }) => Number.isSafeInteger(port) && port > 0);
}

export async function reconcileTunnelPort({
  bin,
  tunnelId,
  relayPort,
  runCommand = run,
}) {
  const list = async () => parseTunnelPorts(
    await runCommand(bin, ["port", "list", tunnelId, "--json"]),
  );
  const existing = await list();
  for (const mapping of existing) {
    if (mapping.port !== relayPort || (mapping.protocol && mapping.protocol !== "http")) {
      await runCommand(bin, ["port", "delete", tunnelId, "-p", String(mapping.port)]);
    }
  }
  if (!existing.some(({ port, protocol }) =>
    port === relayPort && (!protocol || protocol === "http")
  )) {
    await runCommand(bin, ["port", "create", tunnelId, "-p", String(relayPort), "--protocol", "http"]);
  }
  const final = await list();
  if (final.length !== 1 || final[0].port !== relayPort || (final[0].protocol && final[0].protocol !== "http")) {
    throw new Error(`devtunnel port reconciliation failed for ${tunnelId}`);
  }
  return final[0];
}

export function selectTunnelBaseUrl(output, relayPort) {
  const urls = [...String(output ?? "").matchAll(/https:\/\/\S+?\.devtunnels\.ms\/?/g)]
    .map(([url]) => url.replace(/\/$/, ""));
  const matching = urls.find((url) => new URL(url).hostname.includes(`-${relayPort}.`));
  const selected = matching ?? (urls.length === 1 ? urls[0] : null);
  return selected?.replace(/^https:/, "wss:") ?? null;
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

  // PERSISTENT TUNNEL: in the default persistent pairing mode, a prior run leaves its tunnel
  // identity behind in devtunnel.json (see teardown below) instead of deleting it. Reusing that
  // same tunnelId + local relayPort reproduces the exact same public URL
  // (wss://<host>-<port>.<cluster>.devtunnels.ms) so an already-paired phone reconnects with no
  // re-scan. In explicitly selected ephemeral mode, `prior` stays null: a brand-new tunnel is
  // created each run and deleted on teardown.
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
  const publishDurableTunnelIntent = () => {
    if (!persistent || !tunnelId) return;
    writeRegistryAtomic(
      DEVTUNNEL_REGISTRY_FILE,
      {
        relayPort: relay.port,
        tunnelId,
        ...(tunnelId === prior?.tunnelId && relay.port === prior?.relayPort && prior?.baseUrl
          ? { baseUrl: prior.baseUrl }
          : {}),
        alive: false,
        provisioningAt: Date.now(),
      },
      { baseDir },
    );
  };

  // Spawns `devtunnel host <id>` and resolves with the public wss:// URL it prints. Rejects as
  // soon as the host process exits (the CLI reports fatal problems — unauthorized, tunnel gone —
  // by exiting, so waiting out the full timeout would just be dead time).
  const startHost = async (id) => {
    publishStage("hosting");
    host = spawnDevTunnelHost(bin, id);
    publishStage("waiting-for-url");
    return await new Promise((resolve, reject) => {
      let buffer = "";
      let stderr = "";
      let settled = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        host.stdout.off("data", onData);
        host.off("error", onError);
        host.off("exit", onExit);
        if (error) reject(error);
        else resolve(value);
      };
      const onData = (chunk) => {
        buffer += chunk.toString();
        const selected = selectTunnelBaseUrl(buffer, relay.port);
        if (selected) finish(null, selected);
      };
      const onError = (error) => finish(error);
      const onExit = (code) =>
        finish(new Error(`devtunnel host exited early (code ${code})${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
      host.stdout.on("data", onData);
      host.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      host.once("error", onError);
      host.once("exit", onExit);
      const timer = setTimeout(
        () => finish(new Error("timed out waiting for devtunnel host")),
        HOST_STARTUP_TIMEOUT_MS,
      );
    });
  };

  // Creates a brand-new tunnel, maps it to the local relay port, and opens anonymous connect
  // access. Used for the normal (ephemeral / first-run) path and as the fallback when a
  // remembered tunnel turns out to be unusable.
  const createFreshTunnel = async () => {
    publishStage("creating-tunnel");
    const createOut = await run(bin, ["create", "--json"]);
    const created = JSON.parse(createOut).tunnel.tunnelId;
    tunnelId = created;
    publishStage("creating-port");
    await run(bin, ["port", "create", created, "-p", String(relay.port), "--protocol", "http"]);
    publishStage("creating-access");
    await run(bin, ["access", "create", created, "--anonymous", "--scopes", "connect"]);
    return created;
  };

  const deleteCloudTunnel = async (id) => {
    if (!id) return;
    try {
      await run(bin, ["delete", id, "--force"]);
    } catch {
      // Best-effort cleanup: the service also expires abandoned tunnels.
    }
  };

  const teardown = async ({ preserveTunnel = persistent } = {}) => {
    const relayPort = relay.port;
    if (host) await killProcessTree(host);
    await relay.close().catch(() => {});
    // Persistent mode: KEEP the cloud tunnel and its identity so the next start reproduces the same
    // URL — just record that the relay is no longer alive (pid dropped) so pairing/status correctly
    // see it as down. Ephemeral mode: delete the tunnel and clear the registry, exactly as before.
    if (preserveTunnel && tunnelId) {
      writeRegistryAtomic(
        DEVTUNNEL_REGISTRY_FILE,
        {
          relayPort,
          tunnelId,
          ...(baseUrl ? { baseUrl } : {}),
          alive: false,
          stoppedAt: Date.now(),
        },
        { baseDir },
      );
    } else {
      await deleteCloudTunnel(tunnelId);
      clearRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir });
    }
    clearRegistry(DEVTUNNEL_STATUS_FILE, { baseDir });
  };

  try {
    if (reuseTunnelId) {
      publishStage("creating-port");
      await reconcileTunnelPort({ bin, tunnelId, relayPort: relay.port });
      publishDurableTunnelIntent();
      publishStage("creating-access");
      try {
        await run(bin, ["access", "create", tunnelId, "--anonymous", "--scopes", "connect"]);
      } catch {
        // already granted — fine.
      }
    } else {
      tunnelId = await createFreshTunnel();
      publishDurableTunnelIntent();
    }
  } catch (error) {
    if (!reuseTunnelId && tunnelId) {
      await teardown({ preserveTunnel: false });
    } else {
      await relay.close().catch(() => {});
    }
    publishFailure(error);
    process.exitCode = 1;
    return;
  }

  try {
    baseUrl = await startHost(tunnelId);
  } catch (hostErr) {
    // Hosting a REMEMBERED tunnel can fail even though `devtunnel show` succeeded above: `show`
    // only needs connect scope while `host` needs host scope, so a tunnel created under a
    // different sign-in (e.g. the Microsoft account, before an auto `devtunnel user login -g`
    // switched this machine to the GitHub identity) fails here with "Unauthorized tunnel access
    // … expected [host]" — permanently, no matter how long the caller retries. Drop the
    // remembered identity and provision a fresh tunnel instead: the public URL changes (paired
    // phones re-scan) but the relay comes up, rather than hanging until the caller gives up.
    if (!reuseTunnelId) {
      await teardown();
      publishFailure(hostErr);
      process.exitCode = 1;
      return;
    }
    if (host) await killProcessTree(host);
    host = null;
    const abandonedTunnelId = tunnelId;
    await deleteCloudTunnel(abandonedTunnelId);
    if (tunnelId === abandonedTunnelId) tunnelId = null;
    clearRegistry(DEVTUNNEL_REGISTRY_FILE, { baseDir });
    try {
      tunnelId = await createFreshTunnel();
      publishDurableTunnelIntent();
    } catch (error) {
      await teardown({ preserveTunnel: false });
      publishFailure(error);
      process.exitCode = 1;
      return;
    }
    try {
      baseUrl = await startHost(tunnelId);
    } catch (error) {
      await teardown();
      publishFailure(error);
      process.exitCode = 1;
      return;
    }
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

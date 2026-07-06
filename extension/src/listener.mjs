// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { randomInt } from "node:crypto";
import {
  EVENT_TYPE,
  PAIR_KIND,
  SUBTYPE,
  SecureChannel,
  buildPairingPayload,
  deviceHeartbeat,
  exportKeyPair,
  generateKeyPair,
  listenForPeers,
  projectList,
  randomChannelId,
  spawnPairing,
  spawnResult,
} from "@aasis21/weft-shared";
import { createTransportFromDescriptor, resolveTransportForChannel } from "./transportFactory.mjs";
import { spawnCopilotSession } from "./spawn.mjs";
import * as projectsStore from "./projects.mjs";
import { getOrCreateDeviceId } from "./deviceIdentity.mjs";
import { isPidAlive, readRegistry, writeRegistryAtomic } from "./registryFile.mjs";

const ADJECTIVES = ["brave", "calm", "clever", "curious", "gentle", "quick", "sunny", "tidy"];
const ANIMALS = ["otter", "fox", "heron", "panda", "lynx", "wren", "seal", "yak"];
// Proactive DEVICE_HEARTBEAT cadence: independent of PROJECT_LIST_REQUEST/PROJECT_LIST, so an idle
// phone (not polling) can still tell the listener process is alive, not just that the transport
// socket is up.
const DEVICE_HEARTBEAT_MS = 120_000;

// A machine-wide, cross-session view of "which phone is bound to which live Weft listener right
// now", persisted at ~/.weft/connections.json (see registryFile.mjs — same atomic-write + pid
// liveness pattern as devtunnel.json). Diagnostic only: it never gates or changes pairing
// behavior (each listener still binds/rejects peers purely from its own in-memory boundPeerPub),
// it just makes that already-existing state observable across processes — e.g. a future
// `/weft status` or the mobile debug panel could show every session a given phone is paired to,
// and a listener could warn if the same phone is already bound live somewhere else.
const CONNECTIONS_REGISTRY_FILE = "connections.json";

/** Drop any registry entries whose owning process has exited — keeps the file self-cleaning
 * without a separate GC pass, the same way healthyRegistryEntry() does for devtunnel.json. */
function pruneDeadConnections(map) {
  const next = {};
  for (const [channelId, entry] of Object.entries(map ?? {})) {
    if (entry && isPidAlive(entry.pid)) next[channelId] = entry;
  }
  return next;
}

// NOTE: concurrent read-modify-write from multiple Weft sessions binding/unbinding at almost the
// exact same instant could race and drop one session's update — acceptable for a diagnostic-only,
// low-frequency (once per phone connect/disconnect, not the message hot path) view.
function upsertConnection(channelId, entry, baseDir) {
  const map = pruneDeadConnections(readRegistry(CONNECTIONS_REGISTRY_FILE, { baseDir }));
  map[channelId] = entry;
  writeRegistryAtomic(CONNECTIONS_REGISTRY_FILE, map, { baseDir });
}

function removeConnection(channelId, baseDir) {
  const map = pruneDeadConnections(readRegistry(CONNECTIONS_REGISTRY_FILE, { baseDir }));
  delete map[channelId];
  writeRegistryAtomic(CONNECTIONS_REGISTRY_FILE, map, { baseDir });
}

export function createListener({
  transport = null,
  transportDescriptor = null,
  keyPair = null,
  channelId = null,
  deviceId = null,
  heartbeatMs = DEVICE_HEARTBEAT_MS,
  spawnFn,
  projectsApi = projectsStore,
  log = console,
  // ~/.weft by default (see projects.mjs's weftHome()) — overridable so tests don't touch a real
  // user's Weft home when exercising the connections.json registry.
  connectionsHome = undefined,
  // Optional UI hooks so a host (e.g. weft-cli) can render a live connection/heartbeat indicator
  // without this module knowing anything about terminals or rendering.
  onDeviceConnected = null,
  onDeviceDisconnected = null,
  onHeartbeat = null,
  onSpawnRequest = null,
  onSpawnResult = null,
} = {}) {
  let listenerTransport = transport;
  // Resolved once from env (or caller-provided, e.g. tests supplying a matching descriptor
  // alongside a hand-built `transport`) — stamped into every pairing payload this listener
  // builds, both its own persistent QR and any spawn-flow pairing for a freshly-launched
  // session, since a spawned Copilot process inherits this listener's env and would resolve
  // the same descriptor anyway.
  let listenerTransportDescriptor = transportDescriptor;
  let listenerKeyPair = keyPair;
  let listenerChannelId = channelId;
  // Stable, non-secret device id (persisted across restarts) — see deviceIdentity.mjs. Independent
  // of listenerChannelId/listenerKeyPair, which stay ephemeral per run for forward secrecy.
  const listenerDeviceId = deviceId ?? getOrCreateDeviceId();
  let pairingPayload = null;
  let pairingStop = null;
  let controlUnsub = null;
  let boundPeerPub = null;
  let channel = null;
  let stopped = false;
  let started = false;
  let heartbeatTimer = null;

  const start = async () => {
    if (started) return api;
    started = true;
    stopped = false;
    listenerKeyPair ??= await generateKeyPair();
    listenerChannelId ??= randomChannelId();
    // Resolve the descriptor BEFORE building the transport (not the other way around) so a
    // persisted "devtunnel" default is expanded into a real, connectable URL exactly once here —
    // createTransportFromDescriptor then builds off that same resolved value instead of each
    // re-resolving independently (which used to risk two separate devtunnel provisions).
    listenerTransportDescriptor ??= await resolveTransportForChannel({ channelId: listenerChannelId });
    listenerTransport ??= createTransportFromDescriptor(listenerTransportDescriptor, { channelId: listenerChannelId });
    pairingPayload = buildPairingPayload({
      channelId: listenerChannelId,
      publicKeyB64: listenerKeyPair.publicKeyB64,
      transport: listenerTransportDescriptor,
      kind: PAIR_KIND.LISTENER,
    });
    const handle = await listenForPeers({
      transport: listenerTransport,
      keyPair: listenerKeyPair,
      connect: true,
      channelId: listenerChannelId,
      senderId: "weft-listener",
      senderName: hostname(),
      onPeer: bindPeer,
    });
    pairingStop = handle.stop;
    return api;
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopHeartbeat();
    try {
      controlUnsub?.();
    } catch {
      // best-effort
    }
    controlUnsub = null;
    try {
      pairingStop?.();
    } catch {
      // best-effort
    }
    pairingStop = null;
    const hadPeer = boundPeerPub !== null;
    boundPeerPub = null;
    channel = null;
    if (hadPeer) removeConnection(listenerChannelId, connectionsHome);
    try {
      await listenerTransport?.close?.();
    } catch {
      // best-effort
    }
    if (hadPeer) {
      try {
        onDeviceDisconnected?.();
      } catch {
        // best-effort UI hook
      }
    }
  };

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function bindPeer({ key, peer }) {
    if (stopped) return;
    if (boundPeerPub && peer.publicKeyB64 !== boundPeerPub) {
      log?.warn?.(`Weft Device Station: ignoring pairing from a different phone (${peer.senderName ?? peer.deviceId ?? "unknown"})`);
      return;
    }
    // The phone re-broadcasts HELLO on a short retry loop until it sees our ACK (see
    // listenForPeers in shared/pairing.mjs), so a retry can reach us again before the phone gives
    // up — even though we already ACKed and bound it. Since each run's keypair is ephemeral, the
    // same publicKeyB64 arriving again while already bound/connected means "duplicate hello",
    // never a fresh pairing — skip the rebind so we don't resend PROJECT_LIST / reset the
    // heartbeat timer for no reason.
    if (boundPeerPub === peer.publicKeyB64 && channel) return;
    boundPeerPub = peer.publicKeyB64;
    try {
      controlUnsub?.();
    } catch {
      // best-effort
    }
    stopHeartbeat();
    channel = new SecureChannel({
      transport: listenerTransport,
      key,
      identity: {
        channelId: listenerChannelId,
        senderId: "weft-listener",
        senderName: hostname(),
      },
    });
    controlUnsub = channel.onEvent(EVENT_TYPE.CONTROL, (envelope) => {
      void handleControl(envelope);
    });
    await sendProjectList();
    upsertConnection(
      listenerChannelId,
      {
        pid: process.pid,
        deviceId: listenerDeviceId,
        peerPublicKeyB64: peer.publicKeyB64,
        peerDeviceId: peer.deviceId ?? null,
        peerSenderName: peer.senderName ?? null,
        transportKind: listenerTransportDescriptor?.kind ?? null,
        boundAt: new Date().toISOString(),
      },
      connectionsHome,
    );
    try {
      onDeviceConnected?.(peer);
    } catch {
      // best-effort UI hook
    }
    // Proactive liveness beat: unlike PROJECT_LIST (request/reply), this fires on a fixed interval
    // so the phone can tell the listener process is alive even when it isn't actively polling.
    heartbeatTimer = setInterval(() => {
      void channel
        ?.send(deviceHeartbeat(listenerDeviceId))
        ?.then(() => {
          try {
            onHeartbeat?.();
          } catch {
            // best-effort UI hook
          }
        })
        ?.catch?.(() => {});
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  async function sendProjectList() {
    if (!channel || stopped) return;
    const projects = (await Promise.resolve(projectsApi.listProjects())).map((p) => ({
      name: p.name,
      path: p.path,
      isDefault: p.isDefault === true || p.default === true,
    }));
    await channel.send(projectList(projects, hostname(), listenerDeviceId));
  }

  async function handleControl(envelope) {
    if (stopped || envelope?.eventType !== EVENT_TYPE.CONTROL) return;
    if (envelope.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST_REQUEST) {
      await sendProjectList();
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.SPAWN_SESSION) {
      await handleSpawn(envelope.msg ?? {});
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.FORGET_DEVICE) {
      await stop();
    }
  }

  async function handleSpawn({ requestId, projectName, mode = "default", name }) {
    const id = requestId || `request-${Date.now()}`;
    try {
      onSpawnRequest?.({ requestId: id, projectName, mode, name });
    } catch {
      // best-effort UI hook
    }
    try {
      const project = await resolveProject(projectName);
      const sessionName = cleanSessionName(name) || friendlyName();
      const newChannelId = randomChannelId();
      const newKeyPair = await generateKeyPair();
      const { publicKeyB64, privateKeyJwk } = await exportKeyPair(newKeyPair);
      const result = spawnCopilotSession({
        project,
        name: sessionName,
        mode,
        identity: { channelId: newChannelId, publicKeyB64, privateKeyJwk },
        spawnFn,
      });
      if (!result.ok) {
        const error = result.error || "Could not spawn Copilot";
        await channel?.send(spawnResult(id, false, error));
        try {
          onSpawnResult?.({ requestId: id, ok: false, error, name: sessionName, projectName: project.name });
        } catch {
          // best-effort UI hook
        }
        return;
      }
      await channel?.send(
        spawnPairing(
          id,
          buildPairingPayload({
            channelId: newChannelId,
            publicKeyB64,
            transport: listenerTransportDescriptor ?? (await resolveTransportForChannel({ channelId: newChannelId })),
            kind: PAIR_KIND.SESSION,
          }),
          sessionName,
          project.name,
        ),
      );
      await channel?.send(spawnResult(id, true));
      try {
        onSpawnResult?.({ requestId: id, ok: true, name: sessionName, projectName: project.name });
      } catch {
        // best-effort UI hook
      }
    } catch (err) {
      const error = err?.message ?? String(err);
      await channel?.send(spawnResult(id, false, error));
      try {
        onSpawnResult?.({ requestId: id, ok: false, error, projectName });
      } catch {
        // best-effort UI hook
      }
    }
  }

  async function resolveProject(projectName) {
    const projects = await Promise.resolve(projectsApi.listProjects());
    const requested = cleanSessionName(projectName);
    if (requested) {
      const project = projects.find((p) => p.name === requested);
      if (!project) throw new Error(`Unknown project: ${requested}`);
      if (!existsSync(project.path) || !statSync(project.path).isDirectory()) {
        throw new Error(`Project path is missing or not a directory: ${project.path}`);
      }
      return project;
    }
    const defaultProject = projects.find((p) => p.default === true || p.isDefault === true);
    if (defaultProject) {
      if (!existsSync(defaultProject.path) || !statSync(defaultProject.path).isDirectory()) {
        throw new Error(`Project path is missing or not a directory: ${defaultProject.path}`);
      }
      return defaultProject;
    }
    // No project registered/selected as default yet (e.g. a fresh install with no
    // `weft-cli add-project` run) — rather than erroring out, fall back to the user's home
    // directory so the phone can still spawn a working session immediately.
    return { name: "home", path: homedir() };
  }

  const api = {
    start,
    stop,
    get channelId() {
      return listenerChannelId;
    },
    get deviceId() {
      return listenerDeviceId;
    },
    get pairingPayload() {
      return pairingPayload;
    },
    get heartbeatMs() {
      return heartbeatMs;
    },
  };
  return api;
}

function cleanSessionName(name) {
  const value = String(name ?? "").trim();
  return value || null;
}

function friendlyName() {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const animal = ANIMALS[randomInt(ANIMALS.length)];
  return `${adjective}-${animal}-${randomInt(1000, 9999)}`;
}

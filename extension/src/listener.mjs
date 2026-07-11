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
  deriveSessionKey,
  deviceHeartbeat,
  exportKeyPair,
  generateKeyPair,
  listenForPeers,
  projectList,
  randomChannelId,
  spawnPairing,
  spawnResult,
} from "@aasis21/weft-shared";
import { createTransportFromDescriptor, resolveTransport } from "./transportFactory.mjs";
import { spawnCopilotSession } from "./spawn.mjs";
import * as projectsStore from "./projects.mjs";
import { getOrCreateDeviceId } from "./deviceIdentity.mjs";
import { getOrCreatePersistedIdentity, markPersistedIdentityConnected } from "./pairingIdentity.mjs";
import { isPersistentPairingEnabled, loadDeviceName } from "./transportConfig.mjs";
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
  // Optional UI hooks so a host (e.g. weft) can render a live connection/heartbeat indicator
  // without this module knowing anything about terminals or rendering.
  onDeviceConnected = null,
  onDeviceDisconnected = null,
  onHeartbeat = null,
  // Persistent-pairing-only: fired the moment optimisticBind() opens the channel + starts
  // heartbeating from a REMEMBERED peer key, before this run's phone has said hello at all — see
  // optimisticBind's comment. Lets a host UI (weft start) show "connected"/heartbeat status
  // immediately instead of a "waiting/reconnecting" spinner, since we're not actually waiting on
  // anything from the phone in this case.
  onOptimisticBind = null,
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
  // Display name shown to phones (DEVICES list entry, senderName on every message this listener
  // sends). Prefers the user's own choice from `weft set-name` (set at install time or any time
  // after) over the raw OS hostname, which is what this fell back to unconditionally before.
  const listenerDeviceName = loadDeviceName() ?? hostname();
  let pairingPayload = null;
  let pairingStop = null;
  let controlUnsub = null;
  let boundPeerPub = null;
  // True while `boundPeerPub`/`channel` were set OPTIMISTICALLY (see optimisticBind) — i.e. from a
  // remembered peer key, before this run's phone has actually said hello. Flips to false the
  // moment a genuine hello confirms (or contradicts) the guess. Never true in ephemeral mode.
  let boundOptimistically = false;
  let channel = null;
  let stopped = false;
  let started = false;
  let heartbeatTimer = null;
  // Persistent-pairing-only: true if a phone had EVER bound to this exact persisted
  // channelId/keypair as of the moment this run started (see pairingIdentity.mjs's
  // everConnected). Snapshotted before this run's own bindPeer can flip it, so a host UI (weft
  // start's status line) can tell "first scan ever" from "reconnecting a known phone" before
  // anything has connected THIS run. Stays null in ephemeral mode (no persisted state exists).
  let listenerEverConnectedBeforeThisRun = null;

  const start = async () => {
    if (started) return api;
    started = true;
    stopped = false;
    // Remembered peer key from a previous persistent run (see optimisticBind below) — set only
    // when persistent pairing is on AND a phone has bound here before.
    let optimisticPeerPublicKeyB64 = null;
    if (!listenerKeyPair || !listenerChannelId) {
      // `weft set-pairing persistent` opts a device into reusing the same channelId + keypair
      // across every `weft start` run (see pairingIdentity.mjs) — the QR/pairing code stays
      // identical, so an already-paired phone reconnects without ever rescanning. Default
      // (unset) stays forward-secret: a brand-new identity is minted every run.
      if (isPersistentPairingEnabled()) {
        const persisted = await getOrCreatePersistedIdentity();
        listenerKeyPair ??= persisted.keyPair;
        listenerChannelId ??= persisted.channelId;
        listenerEverConnectedBeforeThisRun = persisted.everConnected;
        optimisticPeerPublicKeyB64 = persisted.peerPublicKeyB64;
      } else {
        listenerKeyPair ??= await generateKeyPair();
        listenerChannelId ??= randomChannelId();
      }
    }
    // Resolve the descriptor BEFORE building the transport (not the other way around) so a
    // persisted "devtunnel" default is expanded into a real, connectable URL exactly once here —
    // createTransportFromDescriptor then builds off that same resolved value instead of each
    // re-resolving independently (which used to risk two separate devtunnel provisions).
    listenerTransportDescriptor ??= await resolveTransport();
    listenerTransport ??= createTransportFromDescriptor(listenerTransportDescriptor, { channelId: listenerChannelId });
    pairingPayload = buildPairingPayload({
      channelId: listenerChannelId,
      publicKeyB64: listenerKeyPair.publicKeyB64,
      transport: listenerTransportDescriptor,
      kind: PAIR_KIND.LISTENER,
    });
    // Persistent mode + a known-returning phone: derive the shared key from the REMEMBERED peer
    // public key and open the encrypted channel + start heartbeating right away, instead of
    // sitting idle until this run's fresh hello arrives. The phone's own reconnect path
    // (mobile weftClient.ts's reconnectFromMaterial) fire-and-forgets a hello using that SAME
    // stored keypair, so the guess is correct the vast majority of the time; bindPeer() below
    // reconciles it either way once that hello actually shows up.
    if (optimisticPeerPublicKeyB64) await optimisticBind(optimisticPeerPublicKeyB64);
    const handle = await listenForPeers({
      transport: listenerTransport,
      keyPair: listenerKeyPair,
      connect: true,
      channelId: listenerChannelId,
      senderId: "weft-listener",
      senderName: listenerDeviceName,
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
    const hadPeer = boundPeerPub !== null && !boundOptimistically;
    boundPeerPub = null;
    boundOptimistically = false;
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

  // Proactive liveness beat: unlike PROJECT_LIST (request/reply), this fires on a fixed interval
  // so the phone can tell the listener process is alive even when it isn't actively polling.
  // Shared by both a genuine bindPeer() and the optimistic pre-bind below so heartbeating starts
  // the same way whichever path opened the channel.
  function startHeartbeat() {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      // Wrapped in try/catch + Promise.resolve().catch() as a hard safety net: a heartbeat
      // failure (dropped channel, transport error, etc.) must never crash the whole station —
      // it should just skip this beat and let the next one retry. A bare `channel?.send(...)
      // ?.then()?.catch?.()` chain has a narrow race where `channel` can become non-thenable or
      // get reassigned between call and resolution, letting a rejection slip past optional
      // chaining and surface as an unhandled rejection that kills the process (Node's default
      // --unhandled-rejections=throw behavior).
      try {
        Promise.resolve(channel?.send(deviceHeartbeat(listenerDeviceId)))
          .then(() => {
            try {
              onHeartbeat?.();
            } catch {
              // best-effort UI hook
            }
          })
          .catch(() => {
            // Best-effort beat: drop this failure silently, next interval tick retries.
          });
      } catch {
        // Synchronous throw from channel.send/deviceHeartbeat — same best-effort handling.
      }
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  // Persistent mode only: open the encrypted channel + start heartbeating using the LAST phone
  // public key we saw on this channel, before this run's phone has said hello at all. ECDH is
  // deterministic (same two keypairs always derive the same shared key — see
  // shared/crypto.mjs's deriveSessionKey), and the phone's own reconnect path reuses its stored
  // keypair too, so this is usually the correct key. It's provisional: bindPeer() below either
  // confirms it (matching hello arrives → just promote to a real connection) or corrects it (a
  // hello with a DIFFERENT key arrives → tear this down and bind for real), so a wrong guess
  // self-heals within one hello round-trip instead of wedging the listener.
  async function optimisticBind(peerPublicKeyB64) {
    try {
      const key = await deriveSessionKey(listenerKeyPair.privateKey, peerPublicKeyB64);
      if (stopped) return;
      boundPeerPub = peerPublicKeyB64;
      boundOptimistically = true;
      channel = new SecureChannel({
        transport: listenerTransport,
        key,
        identity: {
          channelId: listenerChannelId,
          senderId: "weft-listener",
          senderName: listenerDeviceName,
        },
      });
      controlUnsub = channel.onEvent(EVENT_TYPE.CONTROL, (envelope) => {
        void handleControl(envelope);
      });
      startHeartbeat();
      try {
        onOptimisticBind?.();
      } catch {
        // best-effort UI hook
      }
    } catch {
      // Couldn't derive the key from the remembered peer (shouldn't happen — corrupt/legacy
      // record) — fall back to the normal wait-for-hello path below.
      boundPeerPub = null;
      boundOptimistically = false;
    }
  }

  async function bindPeer({ key, peer }) {
    if (stopped) return;
    if (boundOptimistically && peer.publicKeyB64 !== boundPeerPub) {
      // Our optimistic guess didn't match this hello (e.g. the phone re-paired with a fresh
      // identity) — nothing genuine was ever exchanged over that provisional channel, so tear it
      // down quietly and fall through to a normal fresh bind using the real key below.
      stopHeartbeat();
      try {
        controlUnsub?.();
      } catch {
        // best-effort
      }
      controlUnsub = null;
      channel = null;
      boundPeerPub = null;
      boundOptimistically = false;
    } else if (boundPeerPub && peer.publicKeyB64 !== boundPeerPub) {
      log?.warn?.(`Weft Device Station: ignoring pairing from a different phone (${peer.senderName ?? peer.deviceId ?? "unknown"})`);
      return;
    } else if (boundPeerPub === peer.publicKeyB64) {
      if (boundOptimistically) {
        // A genuine hello confirms our optimistic guess — the encrypted channel + heartbeat are
        // already live, so we don't need to rebuild them. But this hello is still the PHONE's
        // first real contact THIS run (its own process just (re)started too), so it still needs
        // a fresh PROJECT_LIST — only skip the channel/heartbeat rebuild, not the reply.
        boundOptimistically = false;
        if (isPersistentPairingEnabled()) markPersistedIdentityConnected(listenerChannelId, peer.publicKeyB64);
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
        return;
      }
      // The phone re-broadcasts HELLO on a short retry loop until it sees our ACK (see
      // listenForPeers in shared/pairing.mjs), so a retry can reach us again before the phone
      // gives up — even though we already ACKed and bound it. Since each run's keypair is
      // ephemeral, the same publicKeyB64 arriving again while already truly bound/connected means
      // "duplicate hello", never a fresh pairing — skip the rebind so we don't resend
      // PROJECT_LIST / reset the heartbeat timer for no reason.
      if (channel) return;
    }
    boundPeerPub = peer.publicKeyB64;
    if (isPersistentPairingEnabled()) markPersistedIdentityConnected(listenerChannelId, peer.publicKeyB64);
    try {
      controlUnsub?.();
    } catch {
      // best-effort
    }
    channel = new SecureChannel({
      transport: listenerTransport,
      key,
      identity: {
        channelId: listenerChannelId,
        senderId: "weft-listener",
        senderName: listenerDeviceName,
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
    startHeartbeat();
  }

  async function sendProjectList() {
    if (!channel || stopped) return;
    const projects = (await Promise.resolve(projectsApi.listProjects())).map((p) => ({
      name: p.name,
      path: p.path,
      isDefault: p.isDefault === true || p.default === true,
    }));
    await channel.send(projectList(projects, listenerDeviceName, listenerDeviceId));
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
            transport: listenerTransportDescriptor ?? (await resolveTransport()),
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
    // `weft add-project` run) — rather than erroring out, fall back to the user's home
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
    get deviceName() {
      return listenerDeviceName;
    },
    get pairingPayload() {
      return pairingPayload;
    },
    get heartbeatMs() {
      return heartbeatMs;
    },
    // Persistent-pairing-only signal (null in ephemeral mode) — true if a phone had already
    // bound to this exact persisted channel/keypair before THIS run started, so a host UI can
    // show "reconnecting a known phone" instead of "waiting for the first scan".
    get everConnectedBeforeThisRun() {
      return listenerEverConnectedBeforeThisRun;
    },
    // True right after start() if optimisticBind() succeeded — i.e. the channel is open and
    // heartbeating from a remembered peer key, before this run's phone has said anything. Lets a
    // host UI (weft start) print accurate "already sending heartbeats" copy instead of
    // "waiting"/"reconnecting" wording implying we're blocked on the phone.
    get optimisticallyBound() {
      return boundOptimistically;
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

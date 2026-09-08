// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync, watch, mkdirSync } from "node:fs";
import { hostname, homedir } from "node:os";
import { randomInt } from "node:crypto";
import {
  DEVICE_CAPABILITY,
  EVENT_TYPE,
  PAIR_KIND,
  PAIRING_TTL_MS,
  SUBTYPE,
  SecureChannel,
  buildPairingPayload,
  createPairingGate,
  deviceHeartbeat,
  deviceSnapshot,
  exportKeyPair,
  generateKeyPair,
  listenForPeers,
  launchStatus,
  projectList,
  randomChannelId,
  sessionList,
  sessionOffers,
  spawnPairing,
  spawnResult,
} from "@aasis21/weft-shared";
import { createTransportFromDescriptor, resolveTransport } from "./transportFactory.mjs";
import { spawnCopilotSession } from "./spawn.mjs";
import * as projectsStore from "./projects.mjs";
import * as pendingStore from "./pendingSessions.mjs";
import * as sessionStore from "./store.mjs";
import * as attachedStore from "./attachedSessions.mjs";
import * as launchStore from "./launchOperations.mjs";
import { getOrCreateDeviceId } from "./deviceIdentity.mjs";
import { getOrCreatePersistedIdentity, markPersistedIdentityConnected } from "./pairingIdentity.mjs";
import { isPersistentPairingEnabled, loadDeviceName } from "./transportConfig.mjs";
import { isPidAlive, readRegistry, writeRegistryAtomic } from "./registryFile.mjs";
import { resolveVersion } from "./version.mjs";
import { createDeviceTelemetryCollector } from "./deviceTelemetry.mjs";
import { createTerminalHost } from "./terminalHost.mjs";

const ADJECTIVES = ["brave", "calm", "clever", "curious", "gentle", "quick", "sunny", "tidy"];
const ANIMALS = ["otter", "fox", "heron", "panda", "lynx", "wren", "seal", "yak"];
// Proactive DEVICE_HEARTBEAT cadence: independent of PROJECT_LIST_REQUEST/PROJECT_LIST, so an idle
// phone (not polling) can still tell the listener process is alive, not just that the transport
// socket is up.
const DEVICE_HEARTBEAT_MS = 120_000;
const DEVICE_MONITOR_INTERVAL_MS = 10_000;
const DEVICE_MONITOR_MIN_INTERVAL_MS = 5_000;
const DEVICE_MONITOR_MAX_INTERVAL_MS = 60_000;
const DEVICE_MONITOR_LEASE_MS = 45_000;
const DEVICE_MONITOR_MIN_LEASE_MS = 15_000;
const DEVICE_MONITOR_MAX_LEASE_MS = 120_000;

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
  telemetryApi = createDeviceTelemetryCollector(),
  monitoringLimits = {},
  allowTerminal = false,
  terminalHostFactory = createTerminalHost,
  spawnFn,
  projectsApi = projectsStore,
  // Pending in-session `/weft` offers registry (see pendingSessions.mjs) — injectable so tests can
  // supply a stub instead of touching the real ~/.weft/pending-sessions.json.
  pendingApi = pendingStore,
  // Read-only CLI session store access (see store.mjs) — injectable so tests can stub the
  // resumable-session list instead of reading the real ~/.copilot/session-store.db.
  sessionsApi = sessionStore,
  // Attached-session registry access (see attachedSessions.mjs) — injectable so tests can drive the
  // "already running" guard without spawning real CLI processes.
  attachedApi = attachedStore,
  launchApi = launchStore,
  log = console,
  // ~/.weft by default (see projects.mjs's weftHome()) — overridable so tests don't touch a real
  // user's Weft home when exercising the connections.json / pending-sessions.json registries.
  connectionsHome = undefined,
  // Optional UI hooks so a host (e.g. weft) can render a live connection/heartbeat indicator
  // without this module knowing anything about terminals or rendering.
  onDeviceConnected = null,
  onDeviceDisconnected = null,
  onHeartbeat = null,
  // Retained as a host compatibility hook. Secure pairing now waits for a fresh authenticated
  // hello on every process start, so this hook is intentionally no longer invoked.
  onOptimisticBind = null,
  onSpawnRequest = null,
  onSpawnResult = null,
  // Fired whenever the station relays the current SESSION_OFFERS set to the phone (offers arg) or
  // a phone claims one (SESSION_CLAIMED, channelId arg) — host-log hooks, best-effort.
  onSessionOffers = null,
  onSessionClaimed = null,
  onPairingPayloadChanged = null,
  pairingTtlMs = PAIRING_TTL_MS,
  // Fired at the top of handleControl for every decrypted control message a bound phone sends
  // (PROJECT_LIST_REQUEST, SPAWN_SESSION, SESSION_CLAIMED, FORGET_DEVICE) — lets a host (e.g. the
  // station log) record incoming phone traffic without this module knowing anything about logging.
  onControl = null,
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
  let pairingGate = null;
  let pairingStop = null;
  let controlUnsub = null;
  let boundPeerPub = null;
  // The phone's own stable id (localStorage-backed, survives rescans and app restarts), captured
  // from its hello. A rescan mints a FRESH keypair, so the public key alone cannot tell "the same
  // phone re-paired" apart from "a different phone showed up" — this can.
  let boundPeerDeviceId = null;
  let boundHandshakeNonce = null;
  let channel = null;
  let stopped = false;
  let started = false;
  let heartbeatTimer = null;
  let activeMonitor = null;
  let pairingGrantTimer = null;
  // Pending `/weft` session offers relayed to the phone (see pendingSessions.mjs). `claimedOffers`
  // suppresses re-advertising a session the phone already adopted (until its file entry is gone);
  // `lastOffersJson` dedupes redundant SESSION_OFFERS sends; `pendingWatcher`/`offersDebounce` drive
  // near-instant re-send when the on-disk pending set changes.
  const claimedOffers = new Set();
  let lastOffersJson = null;
  let pendingWatcher = null;
  let offersDebounce = null;
  let launchWatcher = null;
  let launchDebounce = null;
  const lastLaunchReplay = new Map();
  // Persistent-pairing-only: true if a phone had EVER bound to this exact persisted
  // channelId/keypair as of the moment this run started (see pairingIdentity.mjs's
  // everConnected). Snapshotted before this run's own bindPeer can flip it, so a host UI (weft
  // start's status line) can tell "first scan ever" from "reconnecting a known phone" before
  // anything has connected THIS run. Stays null in ephemeral mode (no persisted state exists).
  let listenerEverConnectedBeforeThisRun = null;
  const terminalHost = terminalHostFactory({
    allowTerminal, projectsApi,
    send: async (message) => {
      if (!channel || stopped) throw new Error("Phone disconnected.");
      await channel.send(message);
    },
    lifecycle: ({ event }) => log.info?.(`weft terminal: ${event}`),
  });

  const start = async () => {
    if (started) return api;
    started = true;
    stopped = false;
    await terminalHost.initialize();
    if (allowTerminal && terminalHost.supportError) log.warn?.(terminalHost.supportError);
    // A remembered peer key authorizes only that already-paired phone to reconnect. A different
    // phone requires an explicit identity rotation and fresh QR.
    let trustedPeerPublicKeyB64 = null;
    if (!listenerKeyPair || !listenerChannelId) {
      // Persistent pairing reuses the same channelId + keypair across every `weft start` run
      // (see pairingIdentity.mjs). The channel and ECDH identity stay stable so an already-paired
      // phone reconnects without rescanning; each displayed QR still gets a fresh expiring grant.
      // Users can explicitly opt into ephemeral mode to mint a brand-new identity every run.
      if (isPersistentPairingEnabled()) {
        const persisted = await getOrCreatePersistedIdentity();
        listenerKeyPair ??= persisted.keyPair;
        listenerChannelId ??= persisted.channelId;
        listenerEverConnectedBeforeThisRun = persisted.everConnected;
        trustedPeerPublicKeyB64 = persisted.peerPublicKeyB64;
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
      appVersion: resolveVersion(),
      expiresAt: Date.now() + pairingTtlMs,
    });
    pairingGate = createPairingGate({
      pairingToken: pairingPayload.token,
      expiresAt: pairingPayload.expiresAt,
      trustedPeerPublicKeyB64,
    });
    await installPairingListener({ connect: true });
    schedulePairingGrantRefresh();
    startPendingWatch();
    try {
      await Promise.resolve(launchApi.pruneLaunchOperations?.({ baseDir: connectionsHome }));
    } catch {
      // Best-effort retention cleanup.
    }
    startLaunchWatch();
    return api;
  };

  async function installPairingListener({ connect = false } = {}) {
    const handle = await listenForPeers({
      transport: listenerTransport,
      keyPair: listenerKeyPair,
      connect,
      channelId: listenerChannelId,
      senderId: "weft-listener",
      senderName: listenerDeviceName,
      pairingGate,
      onPeer: bindPeer,
    });
    pairingStop = handle.stop;
  }

  function schedulePairingGrantRefresh() {
    if (pairingGrantTimer) clearTimeout(pairingGrantTimer);
    pairingGrantTimer = null;
    if (stopped || boundPeerPub || !pairingPayload?.expiresAt) return;
    pairingGrantTimer = setTimeout(() => {
      pairingGrantTimer = null;
      void refreshPairingGrant();
    }, Math.max(0, pairingPayload.expiresAt - Date.now() + 50));
    pairingGrantTimer.unref?.();
  }

  async function refreshPairingGrant() {
    if (stopped || boundPeerPub) return;
    pairingPayload = buildPairingPayload({
      channelId: listenerChannelId,
      publicKeyB64: listenerKeyPair.publicKeyB64,
      transport: listenerTransportDescriptor,
      kind: PAIR_KIND.LISTENER,
      appVersion: resolveVersion(),
      expiresAt: Date.now() + pairingTtlMs,
    });
    pairingGate = createPairingGate({
      pairingToken: pairingPayload.token,
      expiresAt: pairingPayload.expiresAt,
      trustedPeerPublicKeyB64: pairingGate?.claimedPeerPublicKeyB64 ?? null,
    });
    pairingStop?.();
    await installPairingListener({ connect: false });
    try {
      onPairingPayloadChanged?.(pairingPayload);
    } catch {
      // best-effort host notification
    }
    schedulePairingGrantRefresh();
  }

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    let terminalStopError = null;
    try { await terminalHost.stop(); } catch (error) { terminalStopError = error; }
    if (pairingGrantTimer) clearTimeout(pairingGrantTimer);
    pairingGrantTimer = null;
    stopHeartbeat();
    stopMonitoring();
    stopPendingWatch();
    stopLaunchWatch();
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
    boundPeerDeviceId = null;
    boundHandshakeNonce = null;
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
    if (terminalStopError) throw terminalStopError;
  };

  /**
   * Swaps this listener onto a freshly-resolved transport WITHOUT changing its pairing identity
   * (same channelId + keypair), returning the rebuilt pairing payload so the host can re-render a
   * QR pointing at the new endpoint. Exists for one real case: the devtunnel relay a station owns
   * died and came back on a DIFFERENT URL (see `weft start`'s relay watchdog). That URL is baked
   * into the QR the phone scanned, so without this the station keeps running and looking healthy
   * while being completely unreachable — the only recovery was restarting `weft start` by hand.
   *
   * A bound phone is DROPPED rather than optimistically re-bound: it is still holding the dead URL
   * and cannot reach the new one until it re-scans, so heartbeating at it would only make the
   * status line claim a connection that no longer exists. Keeping the identity is what makes that
   * re-scan cheap — the channel/keys the phone already trusts still apply, only the endpoint moved.
   */
  const rebindTransport = async (descriptor = null) => {
    if (!started || stopped) return { changed: false, descriptor: listenerTransportDescriptor, pairingPayload };
    const next = descriptor ?? (await resolveTransport());
    if (JSON.stringify(next) === JSON.stringify(listenerTransportDescriptor)) {
      return { changed: false, descriptor: listenerTransportDescriptor, pairingPayload };
    }

    const hadPeer = boundPeerPub !== null;
    terminalHost.disconnectPhone();
    stopHeartbeat();
    stopMonitoring();
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
    channel = null;
    boundPeerPub = null;
    boundPeerDeviceId = null;
    boundHandshakeNonce = null;
    // Re-advertise offers to whoever binds next: lastOffersJson is a dedupe of what went out over
    // the OLD channel, which the next phone has never seen.
    lastOffersJson = null;
    try {
      await listenerTransport?.close?.();
    } catch {
      // best-effort
    }

    listenerTransportDescriptor = next;
    listenerTransport = createTransportFromDescriptor(next, { channelId: listenerChannelId });
    pairingPayload = buildPairingPayload({
      channelId: listenerChannelId,
      publicKeyB64: listenerKeyPair.publicKeyB64,
      transport: listenerTransportDescriptor,
      kind: PAIR_KIND.LISTENER,
      appVersion: resolveVersion(),
      expiresAt: Date.now() + pairingTtlMs,
    });
    pairingGate = createPairingGate({
      pairingToken: pairingPayload.token,
      expiresAt: pairingPayload.expiresAt,
      trustedPeerPublicKeyB64: pairingGate?.claimedPeerPublicKeyB64 ?? null,
    });
    await installPairingListener({ connect: true });
    schedulePairingGrantRefresh();
    if (hadPeer) {
      try {
        onDeviceDisconnected?.();
      } catch {
        // best-effort UI hook
      }
    }
    return { changed: true, descriptor: next, pairingPayload };
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

  function stopMonitoring(monitorId = null) {
    if (!activeMonitor || (monitorId && activeMonitor.id !== monitorId)) return false;
    if (activeMonitor.intervalTimer) clearInterval(activeMonitor.intervalTimer);
    if (activeMonitor.leaseTimer) clearTimeout(activeMonitor.leaseTimer);
    activeMonitor = null;
    return true;
  }

  function scheduleMonitorLease(monitor) {
    if (monitor.leaseTimer) clearTimeout(monitor.leaseTimer);
    monitor.leaseTimer = setTimeout(() => {
      stopMonitoring(monitor.id);
    }, Math.max(0, monitor.expiresAt - Date.now()));
    monitor.leaseTimer.unref?.();
  }

  function scheduleMonitorInterval(monitor) {
    if (monitor.intervalTimer) clearInterval(monitor.intervalTimer);
    monitor.intervalTimer = setInterval(() => {
      void sendDeviceSnapshot(monitor);
    }, monitor.intervalMs);
    monitor.intervalTimer.unref?.();
  }

  async function sendDeviceSnapshot(monitor) {
    if (
      stopped ||
      !channel ||
      activeMonitor !== monitor ||
      monitor.collecting ||
      Date.now() >= monitor.expiresAt
    ) {
      return;
    }
    monitor.collecting = true;
    try {
      let collected;
      try {
        collected = await telemetryApi.collectDeviceSnapshot();
      } catch {
        collected = {
          capturedAt: Date.now(),
          system: {},
          apps: [],
          observedAt: {},
          issues: [{ component: "system", code: "unavailable" }],
        };
      }
      if (stopped || !channel || activeMonitor !== monitor || Date.now() >= monitor.expiresAt) return;
      monitor.sequence += 1;
      await channel.send(deviceSnapshot({
        ...collected,
        monitorId: monitor.id,
        sequence: monitor.sequence,
        effectiveIntervalMs: monitor.intervalMs,
        leaseExpiresAt: monitor.expiresAt,
      }));
    } catch {
      // Best-effort telemetry: the next interval retries and lease expiry still cleans up.
    } finally {
      monitor.collecting = false;
    }
  }

  function startMonitoring({ monitorId, intervalMs, leaseMs } = {}) {
    const id = typeof monitorId === "string" ? monitorId.trim() : "";
    if (!id) return;
    const minIntervalMs = monitoringLimits.minIntervalMs ?? DEVICE_MONITOR_MIN_INTERVAL_MS;
    const maxIntervalMs = monitoringLimits.maxIntervalMs ?? DEVICE_MONITOR_MAX_INTERVAL_MS;
    const defaultIntervalMs = monitoringLimits.defaultIntervalMs ?? DEVICE_MONITOR_INTERVAL_MS;
    const configuredMinLeaseMs = monitoringLimits.minLeaseMs ?? DEVICE_MONITOR_MIN_LEASE_MS;
    const maxLeaseMs = monitoringLimits.maxLeaseMs ?? DEVICE_MONITOR_MAX_LEASE_MS;
    const defaultLeaseMs = monitoringLimits.defaultLeaseMs ?? DEVICE_MONITOR_LEASE_MS;
    const effectiveIntervalMs = Math.max(
      minIntervalMs,
      Math.min(maxIntervalMs, Number(intervalMs) || defaultIntervalMs),
    );
    const minLeaseMs = Math.max(configuredMinLeaseMs, effectiveIntervalMs * 2);
    const effectiveLeaseMs = Math.max(
      minLeaseMs,
      Math.min(maxLeaseMs, Number(leaseMs) || defaultLeaseMs),
    );

    if (activeMonitor?.id === id) {
      activeMonitor.expiresAt = Date.now() + effectiveLeaseMs;
      scheduleMonitorLease(activeMonitor);
      if (activeMonitor.intervalMs !== effectiveIntervalMs) {
        activeMonitor.intervalMs = effectiveIntervalMs;
        scheduleMonitorInterval(activeMonitor);
      }
      return;
    }

    stopMonitoring();
    const monitor = {
      id,
      intervalMs: effectiveIntervalMs,
      expiresAt: Date.now() + effectiveLeaseMs,
      sequence: 0,
      collecting: false,
      intervalTimer: null,
      leaseTimer: null,
    };
    activeMonitor = monitor;
    scheduleMonitorLease(monitor);
    scheduleMonitorInterval(monitor);
    void sendDeviceSnapshot(monitor);
  }

  async function bindPeer({ key, peer }) {
    if (stopped) return;
    if (boundPeerPub && peer.publicKeyB64 !== boundPeerPub) {
      log?.warn?.(`Weft Device Station: ignoring pairing from a different phone (${peer.senderName ?? peer.deviceId ?? "unknown"})`);
      return;
    }
    if (pairingGrantTimer) clearTimeout(pairingGrantTimer);
    pairingGrantTimer = null;
    if (
      boundPeerPub === peer.publicKeyB64 &&
      boundHandshakeNonce === peer.handshakeNonce &&
      channel
    ) {
      return;
    }
    if (channel) {
      terminalHost.disconnectPhone();
      stopHeartbeat();
      stopMonitoring();
      try {
        controlUnsub?.();
      } catch {
        // best-effort
      }
      controlUnsub = null;
      channel = null;
    }
    boundPeerPub = peer.publicKeyB64;
    boundPeerDeviceId = peer.deviceId ?? boundPeerDeviceId;
    boundHandshakeNonce = peer.handshakeNonce ?? null;
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
    await sendSessionOffers({ force: true });
    await sendLaunchReplays({ force: true });
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
    await channel.send(projectList(
      projects,
      listenerDeviceName,
      listenerDeviceId,
      [DEVICE_CAPABILITY.MONITOR_V1, ...(terminalHost.supported ? [DEVICE_CAPABILITY.TERMINAL_V1] : [])],
    ));
  }

  // Relay the current set of in-session `/weft` offers to the paired phone. `force` bypasses the
  // dedupe so a fresh bind always gets the full list. Best-effort throughout: a read/send failure
  // just skips this tick; the next bind, PROJECT_LIST_REQUEST, or file-change watch resends.
  async function sendSessionOffers({ force = false } = {}) {
    if (!channel || stopped) return;
    let pending = [];
    try {
      pending = (await Promise.resolve(pendingApi.listPendingSessions({ baseDir: connectionsHome }))) ?? [];
    } catch {
      pending = [];
    }
    // Once a session withdraws its own file entry (on pair/exit) it's gone from `pending`, so drop
    // it from the claimed-suppression set to keep that set bounded.
    const presentIds = new Set(pending.map((o) => o.channelId));
    for (const id of [...claimedOffers]) if (!presentIds.has(id)) claimedOffers.delete(id);
    const offers = pending.filter((o) => o && typeof o.channelId === "string" && !claimedOffers.has(o.channelId));
    const json = JSON.stringify(offers.map((o) => o.channelId));
    if (!force && json === lastOffersJson) return;
    lastOffersJson = json;
    try {
      await channel.send(sessionOffers(offers));
    } catch {
      lastOffersJson = null; // send didn't land — allow the next tick to resend the same set.
      return;
    }
    try {
      onSessionOffers?.(offers);
    } catch {
      // best-effort UI/log hook
    }
  }

  // Serve the phone's on-demand "Resume a session" list from the CLI session store. Unlike
  // sendProjectList()/sendSessionOffers(), this is NEVER pushed on bind or on a watch — the store is
  // large and rewritten on every turn of every session, so we read it only when the phone explicitly
  // asks (SESSION_LIST_REQUEST). Best-effort: any read/send failure just sends (or skips) an empty
  // list; the phone can pull again.
  async function sendSessionList(limit, cwd) {
    if (!channel || stopped) return;
    let sessions = [];
    let folders = null;
    try {
      sessions = (await Promise.resolve(sessionsApi.listSessions({ limit, cwd }))) ?? [];
    } catch {
      sessions = [];
    }
    try {
      folders = (await Promise.resolve(sessionsApi.listSessionFolders?.())) ?? null;
    } catch {
      folders = null;
    }
    try {
      await channel.send(sessionList(sessions, folders));
    } catch {
      // send didn't land — the phone will re-request on its next refresh.
    }
  }

  function startPendingWatch() {
    try {
      const dir = projectsStore.weftHome(connectionsHome);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        // best-effort — a missing dir just means no offers yet; watch may still attach lazily.
      }
      pendingWatcher = watch(dir, (_event, filename) => {
        // Atomic writes touch a temp file then rename to pending-sessions.json; both names include
        // the base filename. `filename` can be null on some platforms — react to any change then.
        if (filename && !String(filename).includes(pendingStore.PENDING_SESSIONS_FILE)) return;
        if (offersDebounce) clearTimeout(offersDebounce);
        offersDebounce = setTimeout(() => {
          offersDebounce = null;
          void sendSessionOffers();
        }, 150);
        offersDebounce.unref?.();
      });
      pendingWatcher.on?.("error", () => {
        // Watch failures are non-fatal — PROJECT_LIST_REQUEST polling + on-bind sends still refresh.
      });
      // Never let the watch handle by itself hold the process open (mirrors the heartbeat/debounce
      // unref); the station stays alive on its transport, and stop() closes this explicitly.
      pendingWatcher.unref?.();
    } catch {
      pendingWatcher = null;
    }
  }

  function stopPendingWatch() {
    if (offersDebounce) {
      clearTimeout(offersDebounce);
      offersDebounce = null;
    }
    try {
      pendingWatcher?.close?.();
    } catch {
      // best-effort
    }
    pendingWatcher = null;
  }

  function startLaunchWatch() {
    try {
      const dir = launchApi.launchOperationsDir({ baseDir: connectionsHome });
      launchWatcher = watch(dir, () => {
        if (launchDebounce) clearTimeout(launchDebounce);
        launchDebounce = setTimeout(() => {
          launchDebounce = null;
          void sendLaunchReplays();
        }, 75);
        launchDebounce.unref?.();
      });
      launchWatcher.on?.("error", () => {});
      launchWatcher.unref?.();
    } catch {
      launchWatcher = null;
    }
  }

  function stopLaunchWatch() {
    if (launchDebounce) {
      clearTimeout(launchDebounce);
      launchDebounce = null;
    }
    try {
      launchWatcher?.close?.();
    } catch {
      // Best-effort.
    }
    launchWatcher = null;
  }

  async function sendLaunchRecord(record, { force = false } = {}) {
    if (!channel || stopped || !record?.requestId) return;
    const signature = `${record.state}:${record.updatedAt ?? 0}`;
    if (!force && lastLaunchReplay.get(record.requestId) === signature) return;
    if (record.pairingPayload && record.state !== "accepted") {
      await channel.send(
        spawnPairing(record.requestId, record.pairingPayload, record.name ?? null, record.projectName ?? null),
      );
    }
    if (record.state === "failed" || record.state === "abandoned" || record.state === "superseded") {
      await channel.send(spawnResult(record.requestId, false, record.error || `Launch ${record.state}.`));
    } else if (record.state !== "accepted") {
      // Backward compatibility: ok:true means the launch was accepted/spawned, not that pairing
      // has completed. LAUNCH_STATUS carries the precise ready/claimed lifecycle for new phones.
      await channel.send(spawnResult(record.requestId, true));
    }
    await channel.send(launchStatus(record.requestId, record.state, launchApi.publicLaunchDetails(record)));
    lastLaunchReplay.set(record.requestId, signature);
  }

  async function sendLaunchReplays({ force = false } = {}) {
    if (!channel || stopped) return;
    let records = [];
    try {
      records = (await Promise.resolve(launchApi.listLaunchOperations({ baseDir: connectionsHome }))) ?? [];
    } catch {
      return;
    }
    for (const record of records) {
      try {
        await sendLaunchRecord(record, { force });
      } catch {
        lastLaunchReplay.delete(record.requestId);
      }
    }
  }

  async function handleControl(envelope) {
    if (stopped || envelope?.eventType !== EVENT_TYPE.CONTROL) return;
    // Private shell traffic never reaches generic device event or diagnostic hooks.
    if (envelope.eventSubtype === SUBTYPE.CONTROL.TERMINAL_REQUEST) {
      await terminalHost.handle(envelope.msg);
      return;
    }
    try {
      onControl?.({ subtype: envelope.eventSubtype ?? null });
    } catch {
      // best-effort UI/log hook
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST_REQUEST) {
      await sendProjectList();
      await sendSessionOffers();
      await sendLaunchReplays({ force: true });
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.DEVICE_MONITOR_START) {
      startMonitoring(envelope.msg ?? {});
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.DEVICE_MONITOR_STOP) {
      stopMonitoring(envelope.msg?.monitorId);
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.SPAWN_SESSION) {
      await handleSpawn(envelope.msg ?? {});
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.SESSION_LIST_REQUEST) {
      await sendSessionList(envelope.msg?.limit, envelope.msg?.cwd);
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.RESUME_SESSION) {
      await handleResume(envelope.msg ?? {});
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.SESSION_CLAIMED) {
      const claimedId = envelope.msg?.channelId;
      const requestId = envelope.msg?.requestId;
      if (typeof requestId === "string" && requestId) {
        try {
          const claimed = await launchApi.markLaunchClaimed(requestId, { baseDir: connectionsHome });
          if (claimed) await sendLaunchRecord(claimed, { force: true });
        } catch {
          // The spawned extension also records the claim; this station-side path is best-effort.
        }
      }
      if (typeof claimedId === "string" && claimedId) {
        claimedOffers.add(claimedId);
        try {
          pendingApi.removePendingSession(claimedId, { baseDir: connectionsHome });
        } catch {
          // best-effort — the owning session also withdraws its own entry when the phone pairs.
        }
        try {
          onSessionClaimed?.(claimedId);
        } catch {
          // best-effort UI/log hook
        }
        await sendSessionOffers({ force: true });
      }
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
    let operation;
    try {
      const begin = await launchApi.beginLaunchOperation(
        { requestId: id, operation: "new", projectName, mode, name },
        { baseDir: connectionsHome },
      );
      operation = begin.record;
      if (begin.kind === "conflict") {
        const error = "That requestId was already used with different launch fields.";
        await channel?.send(spawnResult(id, false, error));
        await channel?.send(launchStatus(id, "failed", { operation: "new", projectName, name, error }));
        return;
      }
      if (begin.kind !== "created") {
        await sendLaunchRecord(operation, { force: true });
        return;
      }
      await sendLaunchRecord(operation, { force: true });
      const project = await resolveProject(projectName);
      const sessionName = cleanSessionName(name) || friendlyName();
      const newChannelId = randomChannelId();
      const newKeyPair = await generateKeyPair();
      const { publicKeyB64, privateKeyJwk } = await exportKeyPair(newKeyPair);
      const payload = buildPairingPayload({
        channelId: newChannelId,
        publicKeyB64,
        transport: listenerTransportDescriptor ?? (await resolveTransport()),
        kind: PAIR_KIND.SESSION,
        appVersion: resolveVersion(),
      });
      operation = await launchApi.updateLaunchOperation(
        id,
        {
          projectName: project.name,
          name: sessionName,
          pairingPayload: payload,
          identityFile: launchApi.launchIdentityPath(id, { baseDir: connectionsHome }),
        },
        { baseDir: connectionsHome, ownerToken: operation.ownerToken },
      );
      const result = await spawnCopilotSession({
        project,
        name: sessionName,
        mode,
        identity: {
          channelId: newChannelId,
          publicKeyB64,
          privateKeyJwk,
          pairingToken: payload.token,
          pairingExpiresAt: payload.expiresAt,
        },
        operationId: id,
        operationOwnerToken: operation.ownerToken,
        baseDir: connectionsHome,
        spawnFn,
      });
      if (!result.ok) {
        const error = result.error || "Could not spawn Copilot";
        operation = await launchApi.updateLaunchOperation(
          id,
          { state: "failed", error },
          { baseDir: connectionsHome, ownerToken: operation.ownerToken },
        );
        await sendLaunchRecord(operation, { force: true });
        try {
          onSpawnResult?.({ requestId: id, ok: false, error, name: sessionName, projectName: project.name });
        } catch {
          // best-effort UI hook
        }
        return;
      }
      operation = await launchApi.updateLaunchOperation(
        id,
        { state: "launched", pid: result.pid, identityFile: result.identityFile },
        { baseDir: connectionsHome, ownerToken: operation.ownerToken },
      );
      await sendLaunchRecord(operation, { force: true });
      try {
        onSpawnResult?.({ requestId: id, ok: true, name: sessionName, projectName: project.name });
      } catch {
        // best-effort UI hook
      }
    } catch (err) {
      const error = err?.message ?? String(err);
      if (operation?.ownerToken) {
        operation = await launchApi.updateLaunchOperation(
          id,
          { state: "failed", error },
          { baseDir: connectionsHome, ownerToken: operation.ownerToken },
        );
      }
      if (operation) await sendLaunchRecord(operation, { force: true });
      else await channel?.send(spawnResult(id, false, error));
      try {
        onSpawnResult?.({ requestId: id, ok: false, error, projectName });
      } catch {
        // best-effort UI hook
      }
    }
  }

  // Resume an existing CLI session by id. Mirrors handleSpawn (mint identity → spawn → reply over
  // SPAWN_PAIRING/SPAWN_RESULT so the phone pairs digitally), but spawns `copilot --resume=<id>` in
  // the session's OWN cwd (read from the store) instead of a registered project. The cwd is
  // re-validated here even though listSessions() already filtered dead ones, in case the folder
  // vanished between listing and resuming.
  async function handleResume({ requestId, sessionId, mode = "default", force = false }) {
    const id = requestId || `request-${Date.now()}`;
    const cleanSessionId = typeof sessionId === "string" ? sessionId.trim() : "";
    try {
      onSpawnRequest?.({ requestId: id, sessionId: cleanSessionId, mode, resume: true });
    } catch {
      // best-effort UI hook
    }
    let operation;
    const failResume = async (error) => {
      if (operation?.ownerToken) {
        operation = await launchApi.updateLaunchOperation(
          id,
          { state: "failed", error },
          { baseDir: connectionsHome, ownerToken: operation.ownerToken },
        );
      }
      if (operation) await sendLaunchRecord(operation, { force: true });
      else await channel?.send(spawnResult(id, false, error));
      try {
        onSpawnResult?.({ requestId: id, ok: false, error, sessionId: cleanSessionId, resume: true });
      } catch {
        // best-effort UI hook
      }
    };
    try {
      const begin = await launchApi.beginLaunchOperation(
        { requestId: id, operation: "resume", sessionId: cleanSessionId, mode, force },
        { baseDir: connectionsHome },
      );
      operation = begin.record;
      if (begin.kind === "conflict") {
        const error = "That requestId was already used with different launch fields.";
        await channel?.send(spawnResult(id, false, error));
        await channel?.send(launchStatus(id, "failed", { operation: "resume", sessionId: cleanSessionId, error }));
        return;
      }
      if (begin.kind !== "created") {
        await sendLaunchRecord(operation, { force: true });
        return;
      }
      await sendLaunchRecord(operation, { force: true });
      if (!cleanSessionId) {
        await failResume("No session id to resume.");
        return;
      }
      const cwd = await Promise.resolve(sessionsApi.readSessionCwd(cleanSessionId));
      if (!cwd) {
        await failResume("That session is no longer in the CLI session store.");
        return;
      }
      if (!existsSync(cwd) || !statSync(cwd).isDirectory()) {
        await failResume(`The session's folder no longer exists: ${cwd}`);
        return;
      }
      // Don't fork a second `copilot --resume` onto a session that is already running and paired:
      // both processes would write the same session-store entry. The phone catches the cases it can
      // see, but it only knows sessions it holds a card for — a session paired to a DIFFERENT phone,
      // or one whose card was deleted, is invisible to it and can only be caught here.
      //
      // Health controls the user-facing explanation, but liveness controls writer safety. Even a
      // wedged attachment is still a live process touching this session store, so it must be
      // explicitly terminated and confirmed gone before a replacement is spawned.
      const attached = attachedApi.findAttachedSession(cleanSessionId, { baseDir: connectionsHome });
      if (attached && !force) {
        await failResume(
          attached.healthy
            ? "That session is already running on this laptop and connected to a phone. Resume again to close it and take it over."
            : "That session still has a running Copilot writer. Use force takeover to close it before resuming.",
        );
        return;
      }
      if (attached && force) {
        // Explicitly asked for. Close the old process rather than leaving it running alongside —
        // two CLIs on one session store entry is the thing this whole guard exists to prevent.
        const terminated = await attachedApi.terminateAttachedSession?.(cleanSessionId, {
          baseDir: connectionsHome,
          expectedPid: attached.pid,
          expectedChannelId: attached.channelId,
          // The user explicitly confirmed takeover because this writer stopped reporting healthy.
          // PID + channel ownership checks still prevent terminating a different registry owner.
          requireHealthy: false,
        });
        if (!terminated?.ok) {
          await failResume(
            terminated?.error ?? "Could not prove the prior Copilot process stopped; resume was cancelled for safety.",
          );
          return;
        }
        log?.info?.(`weft: closed the session already attached on pid ${attached.pid} before resuming.`);
      }
      const newChannelId = randomChannelId();
      const newKeyPair = await generateKeyPair();
      const { publicKeyB64, privateKeyJwk } = await exportKeyPair(newKeyPair);
      const payload = buildPairingPayload({
        channelId: newChannelId,
        publicKeyB64,
        transport: listenerTransportDescriptor ?? (await resolveTransport()),
        kind: PAIR_KIND.SESSION,
        appVersion: resolveVersion(),
      });
      operation = await launchApi.updateLaunchOperation(
        id,
        {
          pairingPayload: payload,
          identityFile: launchApi.launchIdentityPath(id, { baseDir: connectionsHome }),
        },
        { baseDir: connectionsHome, ownerToken: operation.ownerToken },
      );
      const result = await spawnCopilotSession({
        project: { name: "resume", path: cwd },
        mode,
        identity: {
          channelId: newChannelId,
          publicKeyB64,
          privateKeyJwk,
          pairingToken: payload.token,
          pairingExpiresAt: payload.expiresAt,
        },
        resumeSessionId: cleanSessionId,
        operationId: id,
        operationOwnerToken: operation.ownerToken,
        baseDir: connectionsHome,
        spawnFn,
      });
      if (!result.ok) {
        await failResume(result.error || "Could not resume Copilot");
        return;
      }
      operation = await launchApi.updateLaunchOperation(
        id,
        { state: "launched", pid: result.pid, identityFile: result.identityFile },
        { baseDir: connectionsHome, ownerToken: operation.ownerToken },
      );
      await sendLaunchRecord(operation, { force: true });
      try {
        onSpawnResult?.({ requestId: id, ok: true, sessionId: cleanSessionId, resume: true });
      } catch {
        // best-effort UI hook
      }
    } catch (err) {
      await failResume(err?.message ?? String(err));
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
    // Point this listener at a new endpoint mid-run without re-pairing from scratch — see
    // rebindTransport above. Returns `{changed, descriptor, pairingPayload}`; `changed:false`
    // means the resolved transport was identical and nothing was touched.
    rebindTransport,
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
    // The resolved transport descriptor (kind + endpoint) this station is listening on — surfaced
    // on the `weft start` banner (and mirrored on the phone) so both ends show the same relay.
    get transportDescriptor() {
      return listenerTransportDescriptor;
    },
    // Persistent-pairing-only signal (null in ephemeral mode) — true if a phone had already
    // bound to this exact persisted channel/keypair before THIS run started, so a host UI can
    // show "reconnecting a known phone" instead of "waiting for the first scan".
    get everConnectedBeforeThisRun() {
      return listenerEverConnectedBeforeThisRun;
    },
    // Kept for older hosts that inspect this property.
    get optimisticallyBound() {
      return false;
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

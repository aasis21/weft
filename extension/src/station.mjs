// SPDX-License-Identifier: Apache-2.0
//
// Device Station: the laptop's one background worker for the phone (LLD §5.4).
//   * device channel: projects, saved sessions, utilities, terminal, pairing offers;
//   * v3 open requests (openSession.mjs) and their status, cancel and takeover;
//   * the supervisor: probes every live session, classifies it with the shared sessionHealth()
//     projection, repairs stuck links in place, and answers session_health.
// Station never writes a session's record; its observations live in memory only.
import { watch, mkdirSync, existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEVICE_CAPABILITY,
  EVENT_TYPE,
  PAIR_KIND,
  PAIRING_TTL_MS,
  SUBTYPE,
  SecureChannel,
  buildPairingPayload,
  createPairingGate,
  clipboardResult,
  clipboardTextError,
  deviceHeartbeat,
  deviceSnapshot,
  exportKeyPair,
  generateKeyPair,
  ATTENTION_CAPABILITY,
  watchState,
  keepAwakeStatus,
  lifecycleStatus,
  projectList,
  randomChannelId,
  normalizeKeepAwakeDuration,
  sessionHealth,
  sessionHealthMsg,
  endpointUpdate,
  updateRequired,
  sessionList,
  sessionOffers,
} from "@aasis21/weft-shared";
import { createTransportFromDescriptor, resolveTransport } from "./transportFactory.mjs";
import * as projectsStore from "./projects.mjs";
import * as sessionStore from "./store.mjs";
import { getOrCreateDeviceId } from "./deviceIdentity.mjs";
import { getOrCreatePersistedIdentity, markPersistedIdentityConnected } from "./pairingIdentity.mjs";
import {
  isPersistentPairingEnabled,
  loadDefaultPermissionMode,
  loadDeviceName,
} from "./transportConfig.mjs";
import { isPidAlive, readRegistry, writeRegistryAtomic } from "./registryFile.mjs";
import { resolveVersion } from "./version.mjs";
import { createDeviceTelemetryCollector } from "./deviceTelemetry.mjs";
import { createTerminalHost } from "./terminalHost.mjs";
import { createDeviceClipboard } from "./deviceClipboard.mjs";
import { createDeviceKeepAwakeController, validUtilityId } from "./deviceKeepAwake.mjs";
import {
  LIVE_DIR,
  createCachedVerifier,
  deriveStoreAuthority,
  liveOffers,
  ownerOf,
  scanSessions,
} from "./sessionRegistry.mjs";
import { createSessionControlClient } from "./sessionControl.mjs";
import { createOpenRequests } from "./openRequests.mjs";
import { createOpenSession } from "./openSession.mjs";
import { launchCopilotSession } from "./terminalLauncher.mjs";
import { verifyProcessIdentity } from "./processIdentity.mjs";
import { createAttentionLease, openPairedEndpoint } from "./pairedEndpoint.mjs";
import { appendStationLog } from "./stationLog.mjs";
import { createTrafficLog } from "./trafficLog.mjs";

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
const CONTROL_SUBTYPES = new Set(Object.values(SUBTYPE.CONTROL));

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

// ---- supervisor (LLD §5.4) ------------------------------------------------------------------------

export const SWEEP_INTERVAL_MS = 15_000;
export const PROBE_TIMEOUT_MS = 5_000;
export const MAX_CONCURRENT_PROBES = 4;
/** Timer drift beyond this (laptop sleep) makes the next sweep observe-only. */
export const DRIFT_GRACE_MS = 60_000;
export const REPAIRS_PER_EPISODE = 2;

/**
 * Observe every live session (including `/weft`-only ones), classify it with the shared
 * sessionHealth() projection, and act: repair link-stuck sessions in place (≤ 2 per episode),
 * handle an all-sessions outage with one shared check, and only REPORT unresponsive sessions.
 * Everything it learns stays in memory.
 */
export function createSupervisor({
  scan,
  control,
  now = Date.now,
  log = () => {},
  intervalMs = SWEEP_INTERVAL_MS,
  probeTimeoutMs = PROBE_TIMEOUT_MS,
  maxConcurrent = MAX_CONCURRENT_PROBES,
  onSharedOutage = async () => {},
  randomId = randomUUID,
  setTimer = (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimer = (handle) => clearInterval(handle),
} = {}) {
  const observations = new Map();
  let lastScan = { live: [], foreign: [], unverified: [], sessions: [], legacyOwners: [] };
  let lastSweepAt = null;
  let chain = Promise.resolve();
  let running = null;
  let timer = null;
  let outageActive = false;

  function observe(record) {
    const id = record.run.runtimeId;
    let entry = observations.get(id);
    if (!entry) {
      entry = { record, probe: null, episode: null, class: null, health: null, sharedOutage: false, ownerConflict: false };
      observations.set(id, entry);
    }
    entry.record = record;
    return entry;
  }

  function observationOf(entry) {
    return {
      observer: "station",
      processAlive: true,
      ...(entry.probe ? { probe: { at: entry.probe.at ?? null, misses: entry.probe.misses ?? 0 } } : {}),
      ...(entry.episode ? { episode: { exhausted: entry.episode.exhausted === true } } : {}),
      ...(entry.sharedOutage ? { sharedOutage: true } : {}),
      ...(entry.ownerConflict ? { ownerConflict: true } : {}),
    };
  }

  async function probeOne(entry) {
    try {
      const result = await control(entry.record).command("probe", null, { timeoutMs: probeTimeoutMs });
      entry.probe = { at: now(), misses: 0 };
      // The probe answers with the session's current link facts: fresher than its throttled file.
      if (result?.link && typeof result.link === "object") {
        entry.record = { ...entry.record, link: { ...entry.record.link, ...result.link } };
      }
      entry.controllerName = result?.controllerName ?? null;
    } catch {
      entry.probe = { at: entry.probe?.at ?? null, misses: (entry.probe?.misses ?? 0) + 1, failedAt: now() };
    }
  }

  async function pool(items, fn) {
    let index = 0;
    const workers = Array.from({ length: Math.min(maxConcurrent, items.length) }, async () => {
      while (index < items.length) {
        const item = items[index];
        index += 1;
        await fn(item);
      }
    });
    await Promise.all(workers);
  }

  function classify(entry, at) {
    entry.health = sessionHealth(entry.record, observationOf(entry), at);
    const value = entry.health.reason ?? entry.health.label;
    if (value !== entry.class) {
      log("supervisor.classified", { runtimeId: entry.record.run.runtimeId, class: value });
      entry.class = value;
    }
    return entry.health;
  }

  async function repair(entry) {
    const link = entry.record.link;
    entry.episode ??= { repairs: 0, exhausted: false, generation: link.generation, lastRepair: null };
    if (entry.episode.repairs >= REPAIRS_PER_EPISODE) {
      entry.episode.exhausted = true;
      return;
    }
    entry.episode.repairs += 1;
    let result;
    try {
      const answer = await control(entry.record).command("resetLink", {
        opId: randomId(), expectGeneration: link.generation, by: "station",
      }, { timeoutMs: probeTimeoutMs });
      result = answer?.result ?? "reset";
    } catch (error) {
      result = error?.timeout ? "timeout" : "failed";
    }
    entry.episode.lastRepair = { at: now(), result };
    log("supervisor.repair", { runtimeId: entry.record.run.runtimeId, attempt: entry.episode.repairs, result });
  }

  async function runSweep({ grace = false, only = null } = {}) {
    const at = now();
    const previousSweepAt = lastSweepAt;
    const drifted = !only && previousSweepAt !== null && at - previousSweepAt - intervalMs > DRIFT_GRACE_MS;
    if (!only) lastSweepAt = at;
    const observeOnly = grace || drifted;
    const scanned = await scan();
    lastScan = scanned;
    const liveIds = new Set(scanned.live.map((record) => record.run.runtimeId));
    for (const id of observations.keys()) if (!liveIds.has(id)) observations.delete(id);
    const conflicted = new Set(scanned.sessions.filter((group) => group.ownerConflict)
      .flatMap((group) => group.runtimes.map((record) => record.run.runtimeId)));
    const entries = scanned.live.filter((record) => !only || only(record)).map((record) => {
      const entry = observe(record);
      entry.ownerConflict = conflicted.has(record.run.runtimeId);
      return entry;
    });
    await pool(entries, probeOne);
    const checkedAt = now();
    const stuck = [];
    for (const entry of entries) {
      const link = entry.record.link;
      // An episode ends when the link moved to a newer generation and reached linked.
      if (entry.episode && link.generation > entry.episode.generation && link.state === "linked") entry.episode = null;
      entry.sharedOutage = false;
      if (classify(entry, checkedAt).reason === "link-stuck") stuck.push(entry);
    }
    if (observeOnly) {
      if (drifted) log("supervisor.grace_sweep", { driftMs: at - previousSweepAt - intervalMs });
      return;
    }
    // Shared outage: every session that is trying to be linked is stuck at once — one transport
    // check, no per-session repair storm.
    const active = (only ? scanned.live.map((record) => observations.get(record.run.runtimeId)).filter(Boolean) : entries)
      .filter((entry) => !["dormant", "ending"].includes(entry.record.link.state));
    if (!only && stuck.length >= 2 && stuck.length === active.length) {
      for (const entry of stuck) {
        entry.sharedOutage = true;
        classify(entry, checkedAt);
      }
      if (!outageActive) {
        outageActive = true;
        log("supervisor.shared_outage", { sessions: stuck.length });
        try { await onSharedOutage(); } catch (error) {
          log("supervisor.shared_check_failed", { error: error?.name ?? "Error" });
        }
      }
      return;
    }
    if (!only) outageActive = false;
    for (const entry of stuck) {
      await repair(entry);
      classify(entry, now());
    }
  }

  /** No overlapping rounds: a timer tick while a sweep runs is skipped; explicit calls queue. */
  function sweep(options = {}) {
    if (options.fromTimer && running) return running;
    const next = chain.then(() => runSweep(options));
    chain = next.catch((error) => log("supervisor.sweep_failed", { error: error?.name ?? "Error" }));
    running = chain;
    void chain.finally(() => { if (running === chain) running = null; });
    return next;
  }

  function entryHealth(entry) {
    return {
      ...(entry.health ?? sessionHealth(entry.record, observationOf(entry), now())),
      runtimeId: entry.record.run.runtimeId,
    };
  }

  function health(sessionId, { storeAuthority = null } = {}) {
    const runtimes = lastScan.live.filter((record) => record.session.sessionId === sessionId &&
      (!storeAuthority || record.session.storeAuthority === storeAuthority));
    if (runtimes.length === 1) {
      const entry = observations.get(runtimes[0].run.runtimeId) ?? observe(runtimes[0]);
      return { sessionId, ...entryHealth(entry) };
    }
    if (runtimes.length > 1) {
      return { sessionId, label: "stalled", reason: "owner-unknown", observer: "station", freshAt: now() };
    }
    const owner = ownerOf(lastScan, { storeAuthority, sessionId });
    return owner.state === "unknown"
      ? { sessionId, label: "stalled", reason: "owner-unknown", observer: "station", freshAt: now() }
      : { sessionId, label: "gone", reason: null, observer: "station", freshAt: now() };
  }

  return Object.freeze({
    start() {
      if (timer) return;
      timer = setTimer(() => { void sweep({ fromTimer: true }); }, intervalMs);
      void sweep();
    },
    stop() {
      if (timer) clearTimer(timer);
      timer = null;
    },
    sweep,
    /** Immediate probe of one session (open/recovery), then its health. */
    async check(sessionId, options = {}) {
      await sweep({ only: (record) => record.session.sessionId === sessionId });
      return health(sessionId, options);
    },
    health,
    list() {
      return [...observations.values()].map((entry) => ({
        ...entryHealth(entry),
        sessionId: entry.record.session.sessionId,
        pid: entry.record.run.pid,
        version: entry.record.run.version,
        cwd: entry.record.run.cwd,
        linkState: entry.record.link.state,
        phoneName: entry.controllerName ?? null,
        lastPhoneContactAt: entry.record.link.lastPhoneContactAt,
        lastRepair: entry.episode?.lastRepair ?? null,
      }));
    },
    get lastScan() {
      return lastScan;
    },
  });
}

function directoryExists(path) {
  try {
    return typeof path === "string" && path.length > 0 && existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function defaultSessionStorePath() {
  return join(homedir(), ".copilot", "session-store.db");
}

async function confirmProcessExit(record, { timeoutMs = 5_000, pollMs = 50, verify = verifyProcessIdentity } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proof = await verify({ pid: record.run.pid, processStartedAt: record.run.processStartedAt });
    if (proof?.live === false) return { ok: true };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, error: "The previous Copilot process did not exit; nothing was resumed." };
}

export function createStation({
  transport = null,
  transportDescriptor = null,
  keyPair = null,
  channelId = null,
  deviceId = null,
  heartbeatMs = DEVICE_HEARTBEAT_MS,
  telemetryApi = createDeviceTelemetryCollector(),
  clipboardApi = createDeviceClipboard(),
  keepAwakeApi = createDeviceKeepAwakeController(),
  monitoringLimits = {},
  allowTerminal = false,
  terminalHostFactory = createTerminalHost,
  spawnFn,
  projectsApi = projectsStore,
  // Read-only CLI session store access (see store.mjs) — injectable so tests can stub the
  // resumable-session list instead of reading the real ~/.copilot/session-store.db.
  sessionsApi = sessionStore,
  // Live session registry + control pipe (sessionRegistry.mjs / sessionControl.mjs) — injectable
  // so tests drive discovery and session commands without real Copilot processes. Process proofs
  // are cached between sweeps (full start-time re-verification every few minutes).
  scanRegistry = ((verifyBatch) => (options) => scanSessions({ verifyBatch, ...options }))(createCachedVerifier()),
  controlClient = createSessionControlClient,
  storePath = defaultSessionStorePath(),
  opener = null,
  openerFactory = createOpenSession,
  launcher = null,
  supervisorOptions = {},
  log = console,
  // ~/.weft by default (see projects.mjs's weftHome()) — overridable so tests don't touch a real
  // user's Weft home when exercising the connections.json / sessions-live / requests stores.
  connectionsHome = undefined,
  // Optional UI hooks so a host (e.g. weft) can render a live connection/heartbeat indicator
  // without this module knowing anything about terminals or rendering.
  onDeviceConnected = null,
  onDeviceDisconnected = null,
  onProgress = null,
  onHeartbeat = null,
  // Retained as a host compatibility hook. Secure pairing now waits for a fresh authenticated
  // hello on every process start, so this hook is intentionally no longer invoked.
  onOptimisticBind = null,
  onOpenRequest = null,
  onOpenStatus = null,
  // Fired whenever the station relays the current SESSION_OFFERS set to the phone (offers arg) or
  // a phone claims one (SESSION_CLAIMED, channelId arg) — host-log hooks, best-effort.
  onSessionOffers = null,
  onSessionClaimed = null,
  onPairingPayloadChanged = null,
  pairingTtlMs = PAIRING_TTL_MS,
  // Only a whitelisted subtype is exposed to diagnostics, never decrypted payloads or IDs.
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
  let keepAwakeUnsub = null;
  let boundPeerPub = null;
  // The phone's own stable id (localStorage-backed, survives rescans and app restarts), captured
  // from its hello. A rescan mints a FRESH keypair, so the public key alone cannot tell "the same
  // phone re-paired" apart from "a different phone showed up" — this can.
  let boundPeerDeviceId = null;
  let boundHandshakeNonce = null;
  let channel = null;
  let stopped = false;
  let started = false;
  let lastPeerContactAt = null;
  let lastPeerName = null;
  let transportState = "unreported";
  let transportCheckedAt = null;
  let transportStatusStop = null;
  let heartbeatTimer = null;
  let activeMonitor = null;
  const attention = createAttentionLease();
  const traffic = createTrafficLog();
  let pairingGrantTimer = null;
  // In-session `/weft` offers, read from live session records (sessionRegistry.mjs). `claimedOffers`
  // suppresses re-advertising a session the phone already adopted (until its offer is withdrawn);
  // `lastOffersJson` dedupes redundant SESSION_OFFERS sends; `recordWatcher`/`offersDebounce` drive
  // near-instant re-send when the on-disk records change.
  const claimedOffers = new Set();
  let lastOffersJson = null;
  let recordWatcher = null;
  let offersDebounce = null;
  // The Dev Tunnel address revision announced to the phone with endpoint_update.
  let endpointRevision = 0;
  // Persistent-pairing-only: true if a phone had EVER bound to this exact persisted
  // channelId/keypair as of the moment this run started (see pairingIdentity.mjs's
  // everConnected). Snapshotted before this run's own bindPeer can flip it, so a host UI (weft
  // start's status line) can tell "first scan ever" from "reconnecting a known phone" before
  // anything has connected THIS run. Stays null in ephemeral mode (no persisted state exists).
  let listenerEverConnectedBeforeThisRun = null;
  let sessionOpener = opener;
  let supervisor = null;
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
    const startedAt = Date.now();
    const stage = (phase) => {
      appendStationLog("station.startup.stage", { phase, elapsedMs: Date.now() - startedAt, pid: process.pid });
      onProgress?.(phase);
    };
    stage("initializing-terminal");
    await terminalHost.initialize();
    if (allowTerminal && terminalHost.supportError) log.warn?.(terminalHost.supportError);
    try {
      keepAwakeUnsub = keepAwakeApi?.onStatus?.((status) => {
        void sendUtilityResult(channel, keepAwakeStatus(null, status));
      });
    } catch {
      // Optional status notifications must not prevent station startup.
    }
    // A remembered peer key authorizes only that already-paired phone to reconnect. A different
    // phone requires an explicit identity rotation and fresh QR.
    let trustedPeerPublicKeyB64 = null;
    stage("restoring-pairing");
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
    stage("resolving-transport");
    listenerTransportDescriptor ??= await resolveTransport();
    listenerTransport ??= createTransportFromDescriptor(listenerTransportDescriptor, { channelId: listenerChannelId });
    setUpSessionManagement();
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
    stage("connecting-station");
    await installPairingListener({ connect: true });
    schedulePairingGrantRefresh();
    startRecordWatch();
    stage("recovering-session-operations");
    try {
      await sessionOpener.reconcile();
    } catch (error) {
      log?.warn?.(`Weft Device Station: open-request recovery failed: ${error?.message ?? error}`);
    }
    supervisor.start();
    stage("ready");
    return api;
  };

  // Open requests, the supervisor and the registry share one view of ~/.weft.
  function setUpSessionManagement() {
    if (sessionOpener && supervisor) return;
    const storeAuthority = deriveStoreAuthority(storePath);
    const scan = () => scanRegistry({ baseDir: connectionsHome });
    const clientFor = (record) => controlClient(record, { baseDir: connectionsHome });
    const stationLog = (event, fields, options) => appendStationLog(event, fields, { baseDir: connectionsHome, ...options });
    const requests = createOpenRequests({ baseDir: connectionsHome });
    sessionOpener ??= opener ?? openerFactory({
      requests,
      scan,
      control: clientFor,
      storeAuthority,
      isPidAlive,
      log: stationLog,
      onStatus: (status) => sendOpenStatus(status),
      sessions: {
        async resolve(sessionId) {
          const saved = await Promise.resolve(sessionsApi.readSession?.(sessionId) ?? sessionsApi.readSessionCwd?.(sessionId));
          if (!saved) return null;
          const session = typeof saved === "string" ? { sessionId, cwd: saved } : { ...saved, sessionId };
          return { ...session, directoryExists: directoryExists(session.cwd) };
        },
      },
      projects: {
        async resolve(name) {
          const projects = await Promise.resolve(projectsApi.listProjects());
          const project = projects.find((candidate) => candidate.name === name);
          return project && directoryExists(project.path) ? project : null;
        },
      },
      identities: {
        async create() {
          const keys = await generateKeyPair();
          const { publicKeyB64, privateKeyJwk } = await exportKeyPair(keys);
          const channelId = randomChannelId();
          const payload = buildPairingPayload({
            channelId,
            publicKeyB64,
            transport: listenerTransportDescriptor,
            appVersion: resolveVersion(),
          });
          return {
            channelId, publicKeyB64, privateKeyJwk,
            pairingPayload: payload, pairingToken: payload.token, pairingExpiresAt: payload.expiresAt,
          };
        },
      },
      launcher: launcher ?? {
        launch: ({ requestId, project, resumeSessionId, mode, title, identity, identityFile }) => launchCopilotSession({
          project, name: title, mode, identity, identityFile, resumeSessionId,
          operationId: requestId, operationOwnerToken: randomUUID(), baseDir: connectionsHome, spawnFn,
        }),
      },
      processes: {
        async terminate(record) {
          const proof = await verifyProcessIdentity({ pid: record.run.pid, processStartedAt: record.run.processStartedAt });
          if (proof?.live !== true) return { ok: proof?.live === false, error: "The session process changed before it could be stopped." };
          try {
            process.kill(record.run.pid, "SIGTERM");
            return { ok: true };
          } catch (error) {
            return { ok: false, error: error?.message ?? String(error) };
          }
        },
        confirmExit: (record) => confirmProcessExit(record),
      },
    });
    supervisor ??= createSupervisor({
      scan,
      control: clientFor,
      log: stationLog,
      onSharedOutage: () => sharedTransportCheck(),
      ...supervisorOptions,
    });
  }

  // One shared check when every session's link is stuck at once: is OUR relay endpoint still the
  // same? A changed Dev Tunnel address is rebound (and announced) once, not repaired per session.
  async function sharedTransportCheck() {
    if (listenerTransportDescriptor?.kind !== "devtunnel") return { changed: false };
    return rebindTransport();
  }

  async function installPairingListener({ connect = false } = {}) {
    transportStatusStop?.();
    const observedTransport = listenerTransport;
    if (connect) {
      transportState = "connecting";
      transportCheckedAt = Date.now();
    }
    transportStatusStop = observedTransport.onStatus?.((value) => {
      if (observedTransport !== listenerTransport || stopped) return;
      transportState = value;
      transportCheckedAt = Date.now();
    });
    const handle = await openPairedEndpoint({
      transport: listenerTransport,
      keyPair: listenerKeyPair,
      connect,
      channelId: listenerChannelId,
      senderId: "weft-listener",
      senderName: listenerDeviceName,
      pairingGate,
      onPeer: bindPeer,
      onDisconnected: () => {
        if (channel) traffic.note("phone_disconnected");
        stopHeartbeat();
        stopMonitoring();
        terminalHost.disconnectPhone();
        controlUnsub?.();
        controlUnsub = null;
        channel = null;
        onDeviceDisconnected?.();
      },
    });
    pairingStop = handle.stop;
    if (connect) {
      transportState = "connected";
      transportCheckedAt = Date.now();
    }
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
    transportStatusStop?.();
    transportStatusStop = null;
    transportState = "disconnected";
    transportCheckedAt = Date.now();
    let terminalStopError = null;
    try { await terminalHost.stop(); } catch (error) { terminalStopError = error; }
    if (pairingGrantTimer) clearTimeout(pairingGrantTimer);
    pairingGrantTimer = null;
    stopHeartbeat();
    stopMonitoring();
    stopRecordWatch();
    supervisor?.stop();
    sessionOpener?.stop?.();
    try { keepAwakeUnsub?.(); } catch { /* best-effort host cleanup */ }
    keepAwakeUnsub = null;
    const utilityShutdown = Promise.allSettled(
      [clipboardApi, keepAwakeApi].map(async (utility) => { await utility?.shutdown?.(); }),
    );
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
    await utilityShutdown;
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
    // Protocol v3: tell the bound phone where Station moved while the old path may still deliver,
    // so it can follow without a rescan (best effort, bounded).
    endpointRevision += 1;
    if (channel) {
      const announced = channel.send(endpointUpdate({ endpointRevision, descriptor: next }));
      await Promise.race([
        Promise.resolve(announced).catch(() => {}),
        new Promise((resolve) => { const timer = setTimeout(resolve, 2_000); timer.unref?.(); }),
      ]);
      appendStationLog("station.endpoint_update", { endpointRevision }, { baseDir: connectionsHome });
    }
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
      if (attention.level === "off" || !channel) return;
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
    attention.reset();
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
      observer: traffic.observe,
    });
    traffic.note("phone_connected");
    const boundChannel = channel;
    controlUnsub = boundChannel.onEvent(EVENT_TYPE.CONTROL, (envelope) => {
      void handleControl(envelope, boundChannel);
    });
    await sendProjectList();
    await sendSessionOffers({ force: true });
    await sendOpenReplays();
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
    lastPeerContactAt = Date.now();
    lastPeerName = typeof peer.senderName === "string" ? peer.senderName.slice(0, 100) : null;
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
      [
        ATTENTION_CAPABILITY,
        DEVICE_CAPABILITY.MONITOR_V1,
        ...(terminalHost.supported ? [DEVICE_CAPABILITY.TERMINAL_V1] : []),
        ...(clipboardApi?.supported === true ? [DEVICE_CAPABILITY.CLIPBOARD_V1] : []),
        ...(keepAwakeApi?.supported === true ? [DEVICE_CAPABILITY.KEEP_AWAKE_V1] : []),
        DEVICE_CAPABILITY.SESSION_ACTIVATION_V1,
      ],
      loadDefaultPermissionMode(),
    ));
  }

  // Relay the current set of in-session `/weft` offers to the paired phone. `force` bypasses the
  // dedupe so a fresh bind always gets the full list. Best-effort throughout: a read/send failure
  // just skips this tick; the next bind, PROJECT_LIST_REQUEST, or file-change watch resends.
  async function sendSessionOffers({ force = false } = {}) {
    if (!channel || stopped || (!force && attention.level === "off")) return;
    let pending = [];
    try {
      pending = liveOffers(await scanRegistry({ baseDir: connectionsHome, cleanup: false }));
    } catch {
      pending = [];
    }
    // Once a session withdraws its offer (on pair/exit) it's gone from `pending`, so drop it from
    // the claimed-suppression set to keep that set bounded.
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
  // asks (SESSION_LIST_REQUEST). Keep a failed store read distinct from a genuinely empty list.
  async function sendSessionList(limit, cwd, sort, requestId) {
    if (!channel || stopped) return;
    const replyChannel = channel;
    const startedAt = Date.now();
    appendStationLog("session.list.requested", { pid: process.pid });
    let sessions = [];
    let folders = null;
    let errorCode;
    try {
      sessions = (await Promise.resolve(sessionsApi.listSessions({ limit, cwd, sort, strict: true }))) ?? [];
    } catch (error) {
      appendStationLog("session.list.store_failed", { code: error.cause?.code ?? error.code ?? error.name }, { level: "error" });
      errorCode = "session-store-unavailable";
    }
    if (!errorCode) {
      try {
        sessions = await mergeLiveSessions(sessions);
      } catch (error) {
        appendStationLog("session.list.discovery_failed", { code: error.code ?? error.name }, { level: "warn" });
        // Saved sessions remain available if runtime discovery is temporarily unavailable.
      }
      try {
        folders = (await Promise.resolve(sessionsApi.listSessionFolders?.(undefined, { strict: true }))) ?? null;
      } catch (error) {
        appendStationLog("session.list.folders_failed", { code: error.cause?.code ?? error.code ?? error.name }, { level: "warn" });
        folders = null;
      }
    }
    try {
      if (stopped || replyChannel !== channel) return;
      await replyChannel.send(sessionList(sessions, folders, { requestId, cwd, sort, ...(errorCode ? { errorCode } : {}) }));
      appendStationLog("session.list.sent", { count: sessions.length, elapsedMs: Date.now() - startedAt });
    } catch (error) {
      appendStationLog("session.list.send_failed", { code: error.code ?? error.name, elapsedMs: Date.now() - startedAt }, { level: "error" });
      // send didn't land — the phone will re-request on its next refresh.
    }
  }

  // Watch ~/.weft/sessions-live so a new `/weft` offer (or its withdrawal) reaches the phone almost
  // at once. File watches are a hint only: on-bind sends and project-list requests still refresh.
  function startRecordWatch() {
    try {
      const dir = join(projectsStore.weftHome(connectionsHome), LIVE_DIR);
      try {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
      } catch {
        // best-effort — a missing dir just means no sessions yet.
      }
      recordWatcher = watch(dir, (_event, filename) => {
        if (filename && !String(filename).includes(".json")) return;
        if (offersDebounce) clearTimeout(offersDebounce);
        offersDebounce = setTimeout(() => {
          offersDebounce = null;
          void sendSessionOffers();
        }, 150);
        offersDebounce.unref?.();
      });
      recordWatcher.on?.("error", () => {
        // Watch failures are non-fatal — PROJECT_LIST_REQUEST polling + on-bind sends still refresh.
      });
      recordWatcher.unref?.();
    } catch {
      recordWatcher = null;
    }
  }

  function stopRecordWatch() {
    if (offersDebounce) {
      clearTimeout(offersDebounce);
      offersDebounce = null;
    }
    try {
      recordWatcher?.close?.();
    } catch {
      // best-effort
    }
    recordWatcher = null;
  }

  // Saved sessions plus live ones missing from the saved page; live sessions are marked running.
  async function mergeLiveSessions(sessions) {
    const scanned = await scanRegistry({ baseDir: connectionsHome, cleanup: false });
    const storeAuthority = sessionOpener?.storeAuthority ?? deriveStoreAuthority(storePath);
    const live = scanned.live.filter((record) => record.session.storeAuthority === storeAuthority);
    const merged = new Map((sessions ?? []).map((session) => [session.sessionId, session]));
    for (const record of live) {
      if (merged.has(record.session.sessionId)) continue;
      const saved = await Promise.resolve(
        sessionsApi.readSession?.(record.session.sessionId) ?? sessionsApi.readSessionCwd?.(record.session.sessionId),
      );
      if (!saved) continue;
      const session = typeof saved === "string"
        ? { sessionId: record.session.sessionId, cwd: saved, title: null, repository: null, branch: null, updatedAt: 0 }
        : saved;
      if (directoryExists(session.cwd)) merged.set(record.session.sessionId, session);
    }
    const liveIds = new Set(live.map((record) => record.session.sessionId));
    return [...merged.values()].map((session) => ({
      ...session,
      ...(liveIds.has(session.sessionId) ? { running: true } : {}),
    })).sort((left, right) => {
      const liveDifference = Number(liveIds.has(right.sessionId)) - Number(liveIds.has(left.sessionId));
      return liveDifference || (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    });
  }

  async function sendOpenStatus(status) {
    if (!status?.requestId) return;
    try {
      onOpenStatus?.(status);
    } catch {
      // best-effort host hook
    }
    if (!channel || stopped) return;
    try {
      await channel.send(lifecycleStatus(status));
    } catch {
      // The phone asks again with lifecycle_status_request.
    }
  }

  // A (re)bound phone gets every unfinished request's current snapshot.
  async function sendOpenReplays() {
    if (!channel || stopped || !sessionOpener) return;
    let pending = [];
    try {
      pending = createOpenRequests({ baseDir: connectionsHome }).list({ nonTerminal: true });
    } catch {
      return;
    }
    for (const record of pending) await sendOpenStatus(await sessionOpener.inspect(record.requestId));
  }

  async function sendUtilityResult(replyChannel, result) {
    if (stopped || !replyChannel || replyChannel !== channel) return;
    try { await replyChannel.send(result); } catch { /* transport errors never expose utility payloads */ }
  }

  async function handleClipboard(envelope, replyChannel) {
    const operation = envelope.eventSubtype === SUBTYPE.CONTROL.CLIPBOARD_READ ? "read" : "write";
    const { requestId, text } = envelope.msg ?? {};
    let code = !validUtilityId(requestId) ? "invalid-request"
      : operation === "write" ? clipboardTextError(text) : null;
    let result;
    if (!code && clipboardApi?.supported !== true) code = "unsupported";
    if (!code) {
      try {
        result = operation === "read" ? await clipboardApi.readText() : await clipboardApi.writeText(text);
      } catch (error) {
        code = error?.code === "timeout" ? "timeout" : "unavailable";
      }
    }
    await sendUtilityResult(replyChannel, clipboardResult(
      validUtilityId(requestId) ? requestId : "", operation, code ?? result?.code, result?.text,
    ));
  }

  async function handleKeepAwake(envelope, replyChannel) {
    const { requestId, leaseId, durationMs } = envelope.msg ?? {};
    const subtype = envelope.eventSubtype;
    const invalid = !validUtilityId(requestId) ||
      (subtype !== SUBTYPE.CONTROL.KEEP_AWAKE_STATUS_REQUEST && !validUtilityId(leaseId)) ||
      (subtype === SUBTYPE.CONTROL.KEEP_AWAKE_START && normalizeKeepAwakeDuration(durationMs) === null);
    let code = invalid ? "invalid-request" : keepAwakeApi?.supported !== true ? "unsupported" : null;
    let status;
    try {
      if (code || subtype === SUBTYPE.CONTROL.KEEP_AWAKE_STATUS_REQUEST) status = await keepAwakeApi?.status?.();
      else if (subtype === SUBTYPE.CONTROL.KEEP_AWAKE_START) status = await keepAwakeApi.start({ leaseId, durationMs });
      else status = await keepAwakeApi.stop(leaseId);
    } catch (error) {
      code = error?.code === "timeout" ? "timeout" : "unavailable";
    }
    await sendUtilityResult(replyChannel, keepAwakeStatus(
      validUtilityId(requestId) ? requestId : "", { ...status, ...(code ? { code } : {}) },
    ));
  }

  async function handleControl(envelope, replyChannel) {
    if (stopped || replyChannel !== channel || envelope?.eventType !== EVENT_TYPE.CONTROL) return;
    lastPeerContactAt = Date.now();
    if (envelope.eventSubtype === SUBTYPE.CONTROL.WATCH_REQUEST) {
      const ack = attention.update(envelope.msg);
      if (ack) {
        await replyChannel.send(watchState(ack.watchId, ack.level, ack.leaseMs));
        if (ack.level !== "off") {
          await sendSessionOffers({ force: true });
          await sendOpenReplays();
        }
      }
      return;
    }
    // Private shell traffic never reaches generic device event or diagnostic hooks.
    if (envelope.eventSubtype === SUBTYPE.CONTROL.TERMINAL_REQUEST) {
      await terminalHost.handle(envelope.msg);
      return;
    }
    try {
      onControl?.({ subtype: CONTROL_SUBTYPES.has(envelope.eventSubtype) ? envelope.eventSubtype : null });
    } catch {
      // best-effort UI/log hook
    }
    if (
      envelope.eventSubtype === SUBTYPE.CONTROL.CLIPBOARD_READ ||
      envelope.eventSubtype === SUBTYPE.CONTROL.CLIPBOARD_WRITE
    ) {
      await handleClipboard(envelope, replyChannel);
      return;
    }
    if (
      envelope.eventSubtype === SUBTYPE.CONTROL.KEEP_AWAKE_START ||
      envelope.eventSubtype === SUBTYPE.CONTROL.KEEP_AWAKE_STOP ||
      envelope.eventSubtype === SUBTYPE.CONTROL.KEEP_AWAKE_STATUS_REQUEST
    ) {
      await handleKeepAwake(envelope, replyChannel);
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST_REQUEST) {
      await sendProjectList();
      await sendSessionOffers();
      await sendOpenReplays();
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
    if (envelope.eventSubtype === SUBTYPE.CONTROL.SESSION_LIST_REQUEST) {
      await sendSessionList(envelope.msg?.limit, envelope.msg?.cwd, envelope.msg?.sort, envelope.msg?.requestId);
      return;
    }
    // Protocol v3 has no adapters: a phone still sending pre-v3 launch requests is told to update.
    if (
      envelope.eventSubtype === SUBTYPE.CONTROL.SPAWN_SESSION ||
      envelope.eventSubtype === SUBTYPE.CONTROL.RESUME_SESSION
    ) {
      appendStationLog("station.update_required", { subtype: envelope.eventSubtype }, { level: "warn" });
      await replyChannel.send(updateRequired({ side: "phone", peerVersion: null }));
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.OPEN_SESSION) {
      await handleOpen(envelope.msg ?? {});
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.LIFECYCLE_STATUS_REQUEST) {
      const requestId = envelope.msg?.requestId;
      await sendOpenStatus(await sessionOpener.inspect(requestId) ?? {
        requestId, revision: 0, stage: "accepted", outcome: "failed", reason: "not-found", result: null,
      });
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.TAKEOVER_CONFIRM) {
      await sendOpenStatus(await sessionOpener.confirmTakeover(envelope.msg ?? {}));
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.LIFECYCLE_CANCEL) {
      await sendOpenStatus(await sessionOpener.cancel(envelope.msg?.requestId, envelope.msg?.revision));
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.SESSION_HEALTH_REQUEST) {
      const sessionId = typeof envelope.msg?.sessionId === "string" ? envelope.msg.sessionId : "";
      if (!sessionId || !supervisor) return;
      let health;
      try {
        health = await supervisor.check(sessionId, { storeAuthority: sessionOpener?.storeAuthority ?? null });
      } catch {
        health = supervisor.health(sessionId, { storeAuthority: sessionOpener?.storeAuthority ?? null });
      }
      if (stopped || replyChannel !== channel) return;
      await replyChannel.send(sessionHealthMsg({ ...health, sessionId, observer: "station" }));
      return;
    }

    async function handleOpen(request) {
      try {
        onOpenRequest?.({
          requestId: request?.requestId ?? null,
          ...(request?.target?.sessionId ? { sessionId: request.target.sessionId } : { projectName: request?.target?.project ?? null }),
          mode: request?.options?.permissionMode ?? "default",
          name: request?.options?.title ?? null,
        });
      } catch {
        // best-effort UI hook
      }
      try {
        const status = await sessionOpener.open(request, { requester: boundPeerDeviceId });
        // Statuses stream through onStatus; a conflict or invalid request is answered here.
        if (status?.reason === "invalid-request") await sendOpenStatus(status);
      } catch (error) {
        await sendOpenStatus({
          requestId: typeof request?.requestId === "string" ? request.requestId : "",
          revision: 0,
          stage: "accepted",
          outcome: "failed",
          reason: "internal-error",
          result: { message: error?.message ?? String(error) },
        });
      }
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.SESSION_CLAIMED) {
      const claimedId = envelope.msg?.channelId;
      if (typeof claimedId === "string" && claimedId) {
        claimedOffers.add(claimedId);
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

  const api = {
    start,
    stop,
    traffic: () => ({ entries: traffic.snapshot() }),
    managementStatus() {
      let transportEndpoint = null;
      try { transportEndpoint = new URL(listenerTransportDescriptor?.url).origin; } catch { /* Endpoint may not be configured. */ }
      return {
        transportState, transportCheckedAt, transportKind: listenerTransportDescriptor?.kind ?? null, transportEndpoint,
        paired: Boolean(pairingGate?.claimedPeerPublicKeyB64),
        phoneName: lastPeerName,
        lastPeerContactAt,
        connected: !channel || stopped ? false : lastPeerContactAt && Date.now() - lastPeerContactAt < 120_000 ? true : null,
        watchLevel: attention.level,
        // Supervisor view of every live session (Control Center → Sessions).
        sessions: supervisor?.list() ?? [],
      };
    },
    /** Control Center / CLI: open a v3 request ({ requestId, target, options }) as the local user. */
    async openLocalSession(request) {
      if (!started || stopped || !sessionOpener) throw new Error("Station is not ready.");
      return sessionOpener.open(request, { requester: "local-control-center" });
    },
    /** Health of one saved session after an immediate probe (phone recovery, Control Center). */
    async sessionHealth(sessionId) {
      if (!supervisor) throw new Error("Station is not ready.");
      return supervisor.check(sessionId, { storeAuthority: sessionOpener?.storeAuthority ?? null });
    },
    get supervisor() {
      return supervisor;
    },
    get opener() {
      return sessionOpener;
    },
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
    get paired() {
      return Boolean(pairingGate?.claimedPeerPublicKeyB64);
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

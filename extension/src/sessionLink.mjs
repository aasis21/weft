// SPDX-License-Identifier: Apache-2.0
//
// The session link: one Copilot session's encrypted connection to its phone (LLD §4.1).
//
//   dormant ──activate──► connecting ──subscribed──► waiting ──link_ready──► linked
//                            ▲   │ deadline/error: attempt++, lastError, log, backoff 1.5 s×2 ≤ 15 s
//                            └───┘
//   resetLink / reload / transport switch / takeover: bump generation, abort, await close, connect
//   stop(): ending → (host deletes the record)
//
// Rules this module enforces:
//   * every connect attempt has an AbortController and a 30 s deadline;
//   * every await re-checks the link generation; work from a retired generation is dropped, its
//     transport closed, and its pairing gate refuses to ACK anyone;
//   * exactly one transport is live per generation;
//   * `linked` needs the handshake ACK AND the phone's link_ready after our handlers attached.
//
// Loaded lazily by sessionHost.mjs (built as its own bundle), so the dormant extension never pulls
// in crypto, QR, transport or relay code.
import { basename } from "node:path";
import QRCode from "qrcode";
import {
  SecureChannel,
  generateKeyPair,
  randomChannelId,
  buildPairingPayload,
  createPairingGate,
  endpointUpdate,
  updateRequired,
  PROTOCOL_VERSION,
  CONFIG_ERROR_CODES,
} from "@aasis21/weft-shared";
import {
  createTransportFromDescriptor,
  resolveTransportByName,
  resolveTransport,
  SUPPORTED_TRANSPORT_NAMES,
} from "./transportFactory.mjs";
import { attachRelay, createPermissionRelay } from "./relay.mjs";
import { resolveDevTunnelTransport, stopDevTunnel } from "./devtunnel.mjs";
import { enableSessionLog, appendSessionLog } from "./sessionLog.mjs";
import { resolveVersion } from "./version.mjs";
import { pairingQrText } from "./pairingLink.mjs";
import { isStationRunning } from "./sessionRegistry.mjs";
import {
  cleanupIdentityAfterPairing,
  persistHandoffController,
  readIdentityFile,
} from "./handoffIdentity.mjs";
import { createWorkspaceView } from "./workspaceView.mjs";
import { openPairedEndpoint } from "./pairedEndpoint.mjs";
import { createTrafficLog } from "./trafficLog.mjs";

export const ATTEMPT_DEADLINE_MS = 30_000;
export const BACKOFF_START_MS = 1_500;
export const BACKOFF_MAX_MS = 15_000;
/** Resend our link_ready until the phone answers; a peer that talks but never answers is pre-v3. */
export const LINK_READY_RESEND_MS = 3_000;
export const LINK_READY_PEER_DEADLINE_MS = 10_000;
const FAILURE_LOG_INTERVAL_MS = 10_000;
const NOTICE_AFTER_MS = 60_000;
const NOTICE_EVERY_MS = 10 * 60_000;
const CONTACT_POLL_MS = 15_000;
const ENDPOINT_POLL_MS = 15_000;
const CLOSE_DEADLINE_MS = 5_000;

export function activationControllerDecision({
  controllerDeviceId = null,
  controllerPublicKey = null,
  requesterId = null,
  controllerName = null,
} = {}) {
  const hasController = Boolean(controllerDeviceId || controllerPublicKey);
  if (!hasController) return { kind: "activate" };
  if (requesterId && controllerDeviceId && requesterId === controllerDeviceId) {
    return { kind: "current-controller" };
  }
  return { kind: "conflict", controllerName };
}

export function backoffMs(failures) {
  return Math.min(BACKOFF_START_MS * 2 ** Math.max(0, failures - 1), BACKOFF_MAX_MS);
}

/** Map an attempt failure to a stable, non-sensitive `lastError.code`. */
export function linkErrorCode(error) {
  if (typeof error?.linkCode === "string") return error.linkCode;
  if (CONFIG_ERROR_CODES.includes(error?.code)) return error.code;
  const message = String(error?.message ?? "");
  if (/401|403|unauthori[sz]ed|forbidden|invalid api key|jwt/i.test(message)) return "auth-failed";
  if (/timed? ?out|timeout/i.test(message)) return "subscribe-timeout";
  if (/CHANNEL_ERROR|subscribe/i.test(message)) return "subscribe-failed";
  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|network|fetch failed/i.test(message)) return "relay-unreachable";
  return "connect-failed";
}

const coded = (linkCode, message, cause) => Object.assign(new Error(message, cause ? { cause } : undefined), { linkCode });

const defaultDeps = {
  resolveTransport,
  resolveTransportByName,
  resolveDevTunnelTransport,
  createTransport: createTransportFromDescriptor,
  openPairedEndpoint,
  attachRelay,
  createPermissionRelay,
  stopDevTunnel,
  enableSessionLog,
  appendSessionLog,
  readIdentityFile,
  persistHandoffController,
  cleanupIdentityAfterPairing,
  isStationRunning,
  generateKeyPair,
  randomChannelId,
  createWorkspaceView,
  renderQr: (text) => QRCode.toString(text, { type: "terminal", small: true }),
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (fn, ms) => {
    const handle = setInterval(fn, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle) => clearInterval(handle),
};

/**
 * Create the link for one session. The host serializes every transition through its queue; this
 * module never assumes it, it fences by generation instead.
 *
 * @param {object} options
 * @param {object} options.session          the joined Copilot session
 * @param {object} options.record           sessionRegistry writer handle ({ update(patch, { kind }) })
 * @param {object|null} options.reloadIdentity  identity handed over by the reloading predecessor
 * @param {string} options.identityFile     Station handoff identity file ('' when none)
 * @param {boolean} options.handoffExpected the launcher set handoff env vars
 * @param {(kind: string, fn: Function) => Promise} options.requestTransition  host queue
 */
export async function createSessionLink({
  session,
  record = null,
  reloadIdentity = null,
  identityFile = "",
  channelIdEnv = "",
  handoffExpected = false,
  requestTransition = (_kind, fn) => fn(),
  deps: suppliedDeps = {},
} = {}) {
  if (!session) throw new Error("session is required");
  const deps = { ...defaultDeps, ...suppliedDeps };
  const now = () => deps.now();
  const log = (event, fields = {}, options) => {
    try { deps.appendSessionLog(event, fields, options); } catch { /* diagnostics are best-effort */ }
  };

  const COMMAND_TRANSPORT_NAMES = [...SUPPORTED_TRANSPORT_NAMES, "devtunnel"];
  const WEFT_COLOR = !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const paint = (codes) => (s) => (WEFT_COLOR ? `\x1b[${codes}m${s}\x1b[0m` : `${s}`);
  const ui = {
    brand: paint("1;38;2;198;242;78"),
    lime: paint("38;2;198;242;78"),
    cyan: paint("38;2;63;224;206"),
    dim: paint("2"),
  };

  let handoff = null;
  if (!reloadIdentity && identityFile) {
    try {
      handoff = await deps.readIdentityFile(identityFile);
    } catch (error) {
      process.stderr.write(`Weft: could not load handed-off identity; using a fresh pairing: ${error?.message ?? error}\n`);
    }
  }
  const identity = reloadIdentity ?? handoff;
  const requestId = identity?.requestId ?? identity?.operationId ?? null;
  const durableHandoff = Boolean(handoff?.operationOwnerToken || reloadIdentity?.durableHandoff || requestId);
  const laptopKeys = identity?.laptopKeys ?? (await deps.generateKeyPair());
  const channelId = identity?.channelId ?? (channelIdEnv || deps.randomChannelId());
  const traffic = createTrafficLog();

  // ---- link facts (mirrored into the live record) -------------------------------------------------
  let generation = Number.isSafeInteger(identity?.linkGeneration) ? identity.linkGeneration : 0;
  let state = "dormant";
  let controllerRevision = Number.isSafeInteger(identity?.controllerRevision) ? identity.controllerRevision : 0;
  let endpointRevision = Number.isSafeInteger(identity?.endpointRevision) ? identity.endpointRevision : 0;
  let attempt = 0;
  let lastError = null;
  let ending = false;
  /** The one live slot: { generation, controller, transport, endpoint, startedAt } */
  let slot = null;

  const writeLink = (patch, kind = "state") => {
    try {
      record?.update({ link: patch }, { kind });
    } catch (error) {
      log("record.write_failed", { error: error?.code ?? error?.name }, { level: "warn" });
    }
  };
  const writeOffer = (offer) => {
    try { record?.update({ offer }); } catch { /* best-effort */ }
  };

  // ---- transport + pairing grant ---------------------------------------------------------------
  let descriptor = null;
  let descriptorError = null;
  try {
    descriptor = await deps.resolveTransport();
  } catch (error) {
    descriptorError = error;
  }
  let pendingGrant = identity?.pairingToken && identity?.pairingExpiresAt
    ? { pairingToken: identity.pairingToken, expiresAt: identity.pairingExpiresAt }
    : null;
  let trustedPeer = identity?.trustedPeerPublicKeyB64 ?? null;
  let controllerDeviceId = identity?.controllerDeviceId ?? null;
  let controllerName = identity?.controllerName ?? null;
  let pairingPayload = null;
  let pairingGate = null;

  function rebuildGrant({ keepTrusted = true } = {}) {
    if (!descriptor) return;
    const grant = pendingGrant;
    pendingGrant = null;
    pairingPayload = buildPairingPayload({
      channelId,
      publicKeyB64: laptopKeys.publicKeyB64,
      transport: descriptor,
      appVersion: resolveVersion(),
      ...(grant ?? {}),
    });
    pairingGate = createPairingGate({
      pairingToken: pairingPayload.token,
      expiresAt: pairingPayload.expiresAt,
      trustedPeerPublicKeyB64: keepTrusted ? trustedPeer : null,
    });
  }
  rebuildGrant();

  // Phone-side state of the current link.
  let peer = null; // { publicKeyB64, handshakeNonce, deviceId, senderName }
  let relay = null;
  let relayInit = null;
  let permissionRelay = null;
  let pairChain = Promise.resolve();
  let workspace = null;
  const timers = { grant: null, contact: null, endpoint: null, ready: null, readyDeadline: null };
  let lastContactWritten = null;
  let lastWatching = null;
  let failureLog = { at: -Infinity, suppressed: 0 };
  let failingSince = null;
  let noticeAt = -Infinity;

  deps.enableSessionLog({ sessionId: session.sessionId });
  log("session.loaded", {
    sessionId: session.sessionId || "unknown-session",
    transport: descriptor?.kind ?? "unset",
    channel: channelId.slice(0, 8),
    handoff: Boolean(handoff),
    reload: Boolean(reloadIdentity),
    linkGeneration: generation,
  });
  if (handoffExpected && !handoff && !reloadIdentity) {
    log("spawn.handoff_lost", { channel: channelId.slice(0, 8) }, { level: "error" });
    session.log?.(
      "Weft: this session was opened from your phone, but its pairing identity didn't reach it " +
        "(the terminal launcher likely dropped the hand-off environment). Run `/weft` here to show a fresh QR.",
      { level: "warning", ephemeral: false },
    );
  }
  if (descriptorError) {
    log("transport.setup_error", { error: descriptorError.message }, { level: "warn" });
    session.log?.(
      `Weft: transport didn't come up at startup (${descriptorError.message}). ` +
        `Run \`/weft [${COMMAND_TRANSPORT_NAMES.join("|")}]\` to configure/retry it.`,
      { level: "warning", ephemeral: false },
    );
  }

  async function workspaceView() {
    if (!workspace) workspace = deps.createWorkspaceView({
      session,
      requestPermission: (argumentsValue) => session.rpc.tools.execute({
        name: "weft_workspace_access", arguments: argumentsValue,
      }),
    }).catch((error) => { workspace = null; throw error; });
    return workspace;
  }

  async function ensureRelay() {
    if (relay) return relay;
    relayInit ??= (async () => {
      permissionRelay = deps.createPermissionRelay({
        channel: null, logger: (message, options) => session.log?.(message, options),
      });
      relay = await deps.attachRelay({
        session, channel: null, channelId, permissionRelay,
        onConnectionLost: () => onTransportLost(slot, slot?.transport),
        workspaceView,
      });
      return relay;
    })().finally(() => { relayInit = null; });
    return relayInit;
  }

  // ---- timers -----------------------------------------------------------------------------------
  function clearTimer(name, kind = "timeout") {
    if (!timers[name]) return;
    if (kind === "interval") deps.clearInterval(timers[name]);
    else deps.clearTimeout(timers[name]);
    timers[name] = null;
  }

  function startMonitors() {
    if (!timers.contact) {
      timers.contact = deps.setInterval(() => observePhone(), CONTACT_POLL_MS);
    }
    if (!timers.endpoint) {
      timers.endpoint = deps.setInterval(() => { void checkEndpoint(); }, ENDPOINT_POLL_MS);
    }
  }

  // Facts about the phone for Station: last contact (throttled) and whether it is watching.
  function observePhone() {
    if (!relay || ending || !["waiting", "linked"].includes(state)) return;
    const status = relay.managementStatus?.() ?? {};
    const watching = status.watchLevel ? status.watchLevel !== "off" : null;
    if (watching !== lastWatching) {
      lastWatching = watching;
      writeLink({ phoneWatching: watching, lastPhoneContactAt: status.lastPeerContactAt ?? lastContactWritten });
      lastContactWritten = status.lastPeerContactAt ?? lastContactWritten;
      return;
    }
    if (status.lastPeerContactAt && status.lastPeerContactAt !== lastContactWritten) {
      lastContactWritten = status.lastPeerContactAt;
      writeLink({ lastPhoneContactAt: lastContactWritten }, "contact");
    }
  }

  let checkingEndpoint = false;
  async function checkEndpoint() {
    if (ending || checkingEndpoint || descriptor?.kind !== "devtunnel") return;
    checkingEndpoint = true;
    try {
      const next = await deps.resolveDevTunnelTransport();
      if (ending || next.url === descriptor?.url) return;
      endpointRevision += 1;
      // Tell the phone where we moved while the old path may still deliver (best effort).
      try { await relay?.sendControl?.(endpointUpdate({ endpointRevision, descriptor: next })); } catch { /* best effort */ }
      descriptor = next;
      rebuildGrant();
      writeLink({ endpointRevision });
      log("endpoint.changed", { endpointRevision });
      session.log?.("Weft endpoint changed. Reconnecting; run `/weft` if your phone does not follow.", { level: "warning", ephemeral: false });
      void requestTransition("switchTransport", () => restartLink("endpoint"));
    } catch (error) {
      log("endpoint.lookup_unavailable", { error: error?.name }, { level: "warn" });
    } finally {
      checkingEndpoint = false;
    }
  }

  // ---- generation-fenced connect loop -------------------------------------------------------------

  function current(candidate) {
    return Boolean(candidate) && candidate === slot && candidate.generation === generation && !ending;
  }

  /** A gate that refuses everyone once its generation is retired: retired instances never ACK. */
  function fencedGate(candidate) {
    return {
      authorize(args) {
        return current(candidate) && Boolean(pairingGate?.authorize(args));
      },
      get claimedPeerPublicKeyB64() {
        return pairingGate?.claimedPeerPublicKeyB64 ?? null;
      },
    };
  }

  async function bounded(promise, ms = CLOSE_DEADLINE_MS) {
    let timer;
    try {
      await Promise.race([
        Promise.resolve(promise).catch(() => {}),
        new Promise((resolve) => { timer = deps.setTimeout(resolve, ms); }),
      ]);
    } finally {
      deps.clearTimeout(timer);
    }
  }

  async function closeSlot(retired) {
    if (!retired) return;
    retired.controller.abort();
    clearTimer("ready");
    clearTimer("readyDeadline");
    try { retired.endpoint?.stop(); } catch { /* best-effort */ }
    retired.endpoint = null;
    if (relay && retired.relayBound) {
      try { relay.detach(); } catch (error) {
        log("connection.detach_failed", { error: error?.name }, { level: "error" });
      }
    }
    const transport = retired.transport;
    retired.transport = null;
    await bounded(transport?.close?.());
  }

  function abortableSleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = deps.setTimeout(resolve, ms);
      signal.addEventListener("abort", () => {
        deps.clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }

  function withDeadline(promise, ms, signal, onLate) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        deps.clearTimeout(timer);
        fn(value);
      };
      const timer = deps.setTimeout(() => finish(reject, coded("subscribe-timeout", "The relay did not answer before the attempt deadline.")), Math.max(0, ms));
      signal.addEventListener("abort", () => finish(reject, coded("aborted", "Link attempt was cancelled.")), { once: true });
      promise.then(
        (value) => {
          if (settled) onLate?.(value);
          finish(resolve, value);
        },
        (error) => finish(reject, error),
      );
    });
  }

  async function connectOnce(candidate, deadlineAt) {
    if (!descriptor) {
      try {
        descriptor = await deps.resolveTransport();
        descriptorError = null;
        rebuildGrant();
      } catch (error) {
        descriptorError = error;
        throw coded("missing-config", error?.message ?? "No transport is configured.", error);
      }
      if (!current(candidate)) throw coded("aborted", "stale");
    }
    if (candidate.transport) throw new Error("A transport is already live for this link generation.");
    const transport = deps.createTransport(descriptor, { channelId });
    candidate.transport = transport;
    const opening = Promise.resolve().then(() => deps.openPairedEndpoint({
      transport,
      keyPair: laptopKeys,
      connect: true,
      channelId,
      pairingGate: fencedGate(candidate),
      onDisconnected: () => onTransportLost(candidate, transport),
      onPeer: (info) => onPeer(candidate, transport, info),
    }));
    const endpoint = await withDeadline(opening, deadlineAt - now(), candidate.controller.signal,
      (late) => { try { late?.stop?.(); } catch { /* best-effort */ } });
    if (!current(candidate)) {
      try { endpoint.stop(); } catch { /* best-effort */ }
      throw coded("aborted", "stale");
    }
    candidate.endpoint = endpoint;
  }

  function noteFailure(candidate, error) {
    const code = linkErrorCode(error);
    const at = now();
    lastError = { code, at };
    failingSince ??= at;
    if (at - failureLog.at >= FAILURE_LOG_INTERVAL_MS) {
      log("link.attempt_failed", {
        code, attempt, generation: candidate.generation,
        ...(failureLog.suppressed ? { suppressed: failureLog.suppressed } : {}),
      }, { level: "warn" });
      failureLog = { at, suppressed: 0 };
    } else {
      failureLog.suppressed += 1;
    }
    if (at - failingSince >= NOTICE_AFTER_MS && at - noticeAt >= NOTICE_EVERY_MS) {
      noticeAt = at;
      session.log?.(`Weft: can't reach the relay (${code}). Retrying.`, { level: "warning", ephemeral: false });
    }
    return code;
  }

  async function runLoop(candidate) {
    let failures = 0;
    while (current(candidate)) {
      attempt += 1;
      const deadlineAt = now() + ATTEMPT_DEADLINE_MS;
      writeLink({ state: "connecting", attempt, deadlineAt }, failures ? "failure" : "state");
      try {
        await connectOnce(candidate, deadlineAt);
        if (!current(candidate)) return;
        failingSince = null;
        if (state === "connecting") {
          state = "waiting";
          writeLink({ state, attempt, deadlineAt: null, lastError: null });
        }
        lastError = null;
        log(candidate.reconnect ? "pairing.reconnected" : "pairing.ready", { channel: channelId.slice(0, 8), generation: candidate.generation });
        if (durableHandoff && !peer) publishOffer();
        return;
      } catch (error) {
        const transport = candidate.transport;
        candidate.transport = null;
        await bounded(transport?.close?.());
        if (!current(candidate)) return;
        failures += 1;
        const code = noteFailure(candidate, error);
        const wait = backoffMs(failures);
        // The next attempt's deadline: the record shows a self-retrying link as connecting, and a
        // wedged one (no further writes) as stuck once this passes.
        writeLink({ attempt, lastError, deadlineAt: now() + wait + ATTEMPT_DEADLINE_MS }, "failure");
        if (CONFIG_ERROR_CODES.includes(code) && failures === 1) {
          session.log?.(`Weft: ${error?.message ?? code}`, { level: "warning", ephemeral: false });
        }
        await abortableSleep(wait, candidate.controller.signal);
      }
    }
  }

  /** Enter `connecting` on a new generation; the previous slot is aborted and closed first. */
  async function restartLink(by) {
    if (ending) return status();
    const previous = slot;
    generation += 1;
    const candidate = {
      generation,
      controller: new AbortController(),
      transport: null,
      endpoint: null,
      relayBound: false,
      startedAt: now(),
      reconnect: Boolean(previous) || by !== "activate",
    };
    slot = candidate;
    state = "connecting";
    attempt = 0;
    peer = null;
    lastWatching = null;
    writeLink({ generation, state, attempt: 0, deadlineAt: now() + ATTEMPT_DEADLINE_MS, controllerRevision, endpointRevision, phoneWatching: null });
    if (by !== "activate") log("link.reset", { by, generation });
    await closeSlot(previous);
    if (!current(candidate)) return status();
    startMonitors();
    candidate.loop = runLoop(candidate).catch((error) => {
      log("link.loop_failed", { error: error?.name }, { level: "error" });
    });
    return status();
  }

  /** Only the live, subscribed transport of the current generation can report a lost link. */
  function onTransportLost(candidate, transport) {
    if (!current(candidate) || !transport || candidate.transport !== transport || !candidate.endpoint) return;
    const lostGeneration = candidate.generation;
    traffic.note("phone_disconnected");
    log("connection.lost", { generation: lostGeneration }, { level: "warn" });
    void requestTransition("resetLink", () => (lostGeneration === generation && current(candidate) ? restartLink("self") : status()));
  }

  // ---- handshake → attach → link_ready ------------------------------------------------------------

  function onPeer(candidate, transport, info) {
    pairChain = pairChain.then(() => attachForPeer(candidate, transport, info)).catch((error) => {
      log("pairing.repair_failed", { error: error?.message ?? String(error) }, { level: "warn" });
    });
    return pairChain;
  }

  async function attachForPeer(candidate, transport, { key, peer: hello }) {
    if (!current(candidate) || transport !== candidate.transport) return;
    if (
      peer && hello.publicKeyB64 === peer.publicKeyB64 &&
      hello.handshakeNonce === peer.handshakeNonce && candidate.relayBound
    ) return;
    const firstController = !controllerDeviceId;
    await ensureRelay();
    if (!current(candidate) || transport !== candidate.transport) return;
    const channel = new SecureChannel({
      transport,
      key,
      identity: {
        channelId,
        sessionId: session.sessionId || "unknown-session",
        senderId: "copilot",
        senderName: "Copilot",
      },
      observer: traffic.observe,
    });
    traffic.note("phone_connected");
    candidate.relayBound = true;
    await relay.rebind(channel, {
      linkGeneration: candidate.generation,
      controllerRevision,
      accept: () => current(candidate),
      // The phone attaches its handlers after the ACK and can miss our first link_ready; its first
      // message proves it is listening, so answer it with link_ready right away.
      onActivity: () => {
        if (!current(candidate) || state !== "waiting" || now() - (candidate.readyNudgedAt ?? 0) < 500) return;
        candidate.readyNudgedAt = now();
        void relay?.sendLinkReady?.();
      },
      onLinkReady: (message) => onPhoneLinkReady(candidate, message),
      onUpdateRequired: (message) => {
        log("link.update_required", { side: message?.side ?? "unknown", peerVersion: message?.peerVersion ?? null }, { level: "warn" });
        session.log?.("Weft: your phone says this laptop needs a newer Weft. Run `weft update`, then reload Weft here.", { level: "warning", ephemeral: false });
      },
    });
    if (!current(candidate)) {
      try { relay.detach(); } catch { /* best-effort */ }
      return;
    }
    peer = {
      publicKeyB64: hello.publicKeyB64,
      handshakeNonce: hello.handshakeNonce ?? null,
      deviceId: hello.deviceId ?? null,
      senderName: hello.senderName ?? null,
    };
    trustedPeer = hello.publicKeyB64;
    controllerDeviceId = hello.deviceId ?? controllerDeviceId;
    controllerName = hello.senderName ?? controllerName;
    candidate.handshakeAt = now();
    state = "waiting";
    clearTimer("grant");
    writeLink({ state, lastPhoneContactAt: candidate.handshakeAt });
    writeOffer(null);
    if (durableHandoff && identityFile) {
      try {
        deps.persistHandoffController(identityFile, {
          trustedPeerPublicKeyB64: trustedPeer,
          controllerDeviceId,
          controllerName,
          operationId: requestId,
          operationOwnerToken: handoff?.operationOwnerToken ?? null,
        });
      } catch (error) {
        log("handoff.recovery_persist_failed", { error: error?.message ?? String(error) }, { level: "error" });
      }
    }
    consumeHandoffFile();
    log("device.paired", { phone: hello.senderName ?? hello.deviceId ?? "unknown", generation: candidate.generation });
    if (firstController) session.log?.(
      `${ui.lime("✓ Phone paired")} — ${hello.senderName ?? hello.deviceId ?? "your phone"} is now mirroring this session.`,
    );
    watchLinkReady(candidate);
  }

  /** Resend link_ready until the phone answers; a phone that talks without answering is pre-v3. */
  function watchLinkReady(candidate) {
    clearTimer("ready");
    clearTimer("readyDeadline");
    const resend = () => {
      if (!current(candidate) || state === "linked") return;
      void relay?.sendLinkReady?.();
      timers.ready = deps.setTimeout(resend, LINK_READY_RESEND_MS);
    };
    timers.ready = deps.setTimeout(resend, LINK_READY_RESEND_MS);
    timers.readyDeadline = deps.setTimeout(() => {
      timers.readyDeadline = null;
      if (!current(candidate) || state === "linked") return;
      const contact = relay?.managementStatus?.().lastPeerContactAt ?? null;
      if (!contact || contact <= candidate.handshakeAt) return;
      log("link.peer_outdated", { generation: candidate.generation }, { level: "warn" });
      void relay?.sendControl?.(updateRequired({ side: "phone", peerVersion: null, minVersion: PROTOCOL_VERSION }));
      clearTimer("ready");
      candidate.relayBound = false;
      try { relay?.detach(); } catch { /* best-effort */ }
      lastError = { code: "update-required", at: now() };
      writeLink({ lastError }, "failure");
    }, LINK_READY_PEER_DEADLINE_MS);
  }

  function onPhoneLinkReady(candidate, message) {
    if (!current(candidate) || message?.linkGeneration !== candidate.generation) return;
    if (state === "linked") return;
    clearTimer("ready");
    clearTimer("readyDeadline");
    state = "linked";
    const at = now();
    lastContactWritten = at;
    writeLink({ state, lastPhoneContactAt: at, lastError: null, deadlineAt: null });
    log("link.ready", { generation: candidate.generation, ms: at - candidate.startedAt });
    observePhone();
  }

  // ---- pairing UX (/weft, canvas, Station offers) -------------------------------------------------

  function publishOffer() {
    if (ending || !pairingPayload || peer) return;
    const cwd = session.cwd ?? session.workingDirectory ?? process.cwd();
    writeOffer({ channelId, name: basename(cwd) || null, cwd, payload: pairingPayload, expiresAt: pairingPayload.expiresAt });
    log("offer.registered", { channel: channelId.slice(0, 8) });
  }

  function scheduleGrantRefresh() {
    if (!durableHandoff || !pairingPayload?.expiresAt || peer || ending) return;
    clearTimer("grant");
    timers.grant = deps.setTimeout(() => {
      timers.grant = null;
      void requestTransition("activate", async () => {
        if (!durableHandoff || peer || ending) return status();
        rebuildGrant();
        publishOffer();
        scheduleGrantRefresh();
        return status();
      });
    }, Math.max(0, pairingPayload.expiresAt - now() + 50));
  }

  async function switchTransport(name) {
    const normalized = name.trim().toLowerCase();
    let next;
    try {
      next = normalized === "devtunnel"
        ? await deps.resolveDevTunnelTransport()
        : deps.resolveTransportByName(normalized);
    } catch (error) {
      throw new Error(`Weft: ${error?.message ?? error}`, { cause: error });
    }
    if (JSON.stringify(next) === JSON.stringify(descriptor)) {
      session.log?.(`Weft: already using "${next.kind}" for this session.`, { ephemeral: false });
      return false;
    }
    descriptor = next;
    descriptorError = null;
    rebuildGrant();
    log("transport.switched", { transport: next.kind });
    session.log?.(
      `Weft: switched transport to "${next.kind}" for this session only. Scan the fresh QR below.`,
      { ephemeral: false },
    );
    await restartLink("switch");
    return true;
  }

  async function preparePairing({ transport, refresh = false } = {}) {
    if (ending) throw new Error("This Copilot session has ended.");
    await ensureRelay();
    const paired = Boolean(pairingGate?.claimedPeerPublicKeyB64);
    if (paired && transport && transport !== descriptor?.kind && !refresh) {
      throw new Error("Use New pairing code to confirm changing the connected phone's transport.");
    }
    if (transport) await switchTransport(transport);
    if (!descriptor) {
      throw new Error(
        `Weft: no working transport yet (${descriptorError?.message ?? "not configured"}). ` +
          `Run \`/weft [${COMMAND_TRANSPORT_NAMES.join("|")}]\` or select a transport in the Weft panel.`,
      );
    }
    const expired = pairingPayload?.expiresAt && now() >= pairingPayload.expiresAt;
    if (refresh || (!paired && expired)) {
      trustedPeer = null;
      controllerDeviceId = null;
      controllerName = null;
      rebuildGrant({ keepTrusted: false });
      await restartLink("pairing-refresh");
    } else if (state === "dormant") {
      await restartLink("activate");
    }
    publishOffer();
    return status();
  }

  async function showPairing(context) {
    await preparePairing({
      transport: context?.args?.trim(),
      refresh: Boolean(pairingGate?.claimedPeerPublicKeyB64),
    });
    await logPairing({ full: true });
    log("pairing.shown", { transport: descriptor.kind, channel: channelId.slice(0, 8) });
  }

  async function logPairing({ full = false } = {}) {
    const payload = JSON.stringify(pairingPayload);
    const qr = (await deps.renderQr(pairingQrText(pairingPayload))).replace(/\n+$/, "");
    const lines = full
      ? [
          `${ui.brand("WEFT")}  ${ui.dim("·  pair your phone")}`,
          "",
          ui.dim("Mirror this Copilot session on your phone — watch the live token"),
          ui.dim("stream, read diffs, and approve tool runs from anywhere."),
          "",
          qr,
          "",
          `${ui.lime("1")}  Open the Weft app   ${ui.dim("·")}  ${ui.cyan("useweft.netlify.app")}`,
          `${ui.lime("2")}  Scan the code above with your phone camera, or tap ${ui.dim("“Scan QR”")} in the app`,
          `${ui.lime("3")}  Approve the link on your phone — it confirms right here`,
          "",
          ui.dim("Can’t scan? Tap “Paste a code” in the app and paste this:"),
          // Fenced so the CLI's markdown renderer never autolinks bytes the user must copy exactly.
          "```",
          payload,
          "```",
          "",
          ...(deps.isStationRunning()
            ? [
                ui.dim("Phone already paired to this laptop? This session is also waiting in the Weft app under this device — just tap it to join, no scan."),
                "",
              ]
            : []),
          ui.dim(`Relay ${descriptor.kind} · Channel ${channelId.slice(0, 8)} · End-to-end encrypted (AES-256-GCM), keys live only this session`),
          "",
          `${ui.cyan("›")} ${ui.dim("Waiting for your phone…")}`,
        ]
      : [
          `${ui.brand("WEFT")}  ${ui.dim("·  scan to pair your phone")}`,
          "",
          qr,
          "",
          `${ui.cyan("›")} ${ui.dim("Waiting for your phone…")}   ${ui.dim("·")}   ${ui.dim("run")} ${ui.lime("/weft")} ${ui.dim("for setup steps")}`,
        ];
    session.log?.(lines.join("\n"), { level: "info", ephemeral: false });
  }

  // ---- host-facing operations ---------------------------------------------------------------------

  async function activate({ showQr = false, context = null } = {}) {
    if (ending) throw new Error("This Copilot session has ended.");
    await ensureRelay();
    const requesterId = typeof context?.requesterId === "string" && context.requesterId.trim()
      ? context.requesterId.trim() : null;
    const decision = activationControllerDecision({
      controllerDeviceId,
      controllerPublicKey: trustedPeer,
      requesterId,
      controllerName,
    });
    if (!showQr && requesterId && decision.kind === "conflict") {
      return { ...status(), controllerConflict: true };
    }
    if (showQr) await showPairing(context);
    else if (state === "dormant") await restartLink("activate");
    if (durableHandoff) scheduleGrantRefresh();
    return status();
  }

  async function replaceController() {
    if (ending) throw new Error("This Copilot session has ended.");
    controllerRevision += 1;
    trustedPeer = null;
    controllerDeviceId = null;
    controllerName = null;
    rebuildGrant({ keepTrusted: false });
    writeLink({ controllerRevision });
    log("link.takeover", { controllerRevision });
    await restartLink("takeover");
    publishOffer();
    return status();
  }

  function status() {
    const relayStatus = relay?.managementStatus?.() ?? {};
    return {
      state,
      linkGeneration: generation,
      controllerRevision,
      endpointRevision,
      attempt,
      lastError,
      paired: Boolean(pairingGate?.claimedPeerPublicKeyB64),
      phoneName: controllerName,
      controllerDeviceId,
      pairingPayload,
      sessionId: session.sessionId || null,
      pid: process.pid,
      connected: state === "linked" ? relayStatus.connected ?? null : false,
      watchLevel: relayStatus.watchLevel ?? null,
      lastPeerContactAt: relayStatus.lastPeerContactAt ?? null,
      busy: relayStatus.busy ?? null,
      version: resolveVersion(),
      title: relayStatus.title ?? null,
      cwd: session.cwd ?? session.workingDirectory ?? null,
    };
  }

  function getReloadIdentity() {
    return {
      channelId,
      laptopKeys,
      pairingToken: pairingPayload?.token ?? null,
      pairingExpiresAt: pairingPayload?.expiresAt ?? null,
      trustedPeerPublicKeyB64: trustedPeer ?? pairingGate?.claimedPeerPublicKeyB64 ?? null,
      controllerDeviceId,
      controllerName,
      controllerRevision,
      endpointRevision,
      linkGeneration: generation,
      requestId,
      durableHandoff,
    };
  }

  let handoffConsumed = false;
  function consumeHandoffFile() {
    if (handoffConsumed || !identityFile) return;
    handoffConsumed = true;
    if (deps.cleanupIdentityAfterPairing(identityFile, { durable: durableHandoff })) log("handoff.file_cleaned", {});
  }

  /**
   * Leave the link: abort and AWAIT the pending transport before returning, so a reloading
   * successor never races this instance on the same channel. Returns the reload identity when
   * `keepIdentity` is set.
   */
  async function stop({ reason = "session_end", keepIdentity = false, announce = false } = {}) {
    if (ending) return keepIdentity ? getReloadIdentity() : null;
    const identityForReload = keepIdentity ? getReloadIdentity() : null;
    ending = true;
    state = "ending";
    writeLink({ state });
    const retired = slot;
    slot = null;
    for (const [name, kind] of [["grant"], ["ready"], ["readyDeadline"], ["contact", "interval"], ["endpoint", "interval"]]) {
      clearTimer(name, kind);
    }
    if (relayInit) await bounded(relayInit);
    retired?.controller.abort();
    // A real end (or an explicit disconnect) tells the phone on the still-live channel first.
    const announceEnd = !keepIdentity || announce;
    if (relay && announceEnd) await bounded(relay.stop(reason, { closeTransport: true }));
    await closeSlot(retired);
    await bounded(retired?.loop);
    if (workspace) {
      try { (await workspace).close(); } catch { /* initialization failures are surfaced elsewhere */ }
    }
    log("session.shutdown", { reason, keepIdentity });
    if (relay && !announceEnd) await bounded(relay.stop(reason, { closeTransport: false }));
    if (!keepIdentity) await bounded(deps.stopDevTunnel().catch(() => {}));
    return identityForReload;
  }

  return Object.freeze({
    get generation() { return generation; },
    get state() { return state; },
    get controllerRevision() { return controllerRevision; },
    log,
    activate,
    resetLink: ({ by = "station" } = {}) => restartLink(by),
    replaceController,
    preparePairing,
    showPairing,
    switchTransport,
    status,
    traffic: () => ({ title: relay?.managementStatus?.().title ?? null, entries: traffic.snapshot() }),
    async grantWorkspaceAccess(args) { return (await workspaceView()).grant(args); },
    onPermissionRequest(request, invocation) {
      if (!permissionRelay || ending) return { kind: "user-not-available" };
      return permissionRelay.onPermissionRequest(request, invocation);
    },
    discardHandoffIdentity() {
      if (!identityFile) return false;
      return deps.cleanupIdentityAfterPairing(identityFile, { force: true });
    },
    getReloadIdentity,
    stop,
  });
}

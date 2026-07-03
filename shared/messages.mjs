// Helm shared message protocol — standardized event envelope.
//
// Two layers:
//  1. TransportMessage — the opaque, E2E-encrypted envelope that travels over the relay.
//     Shape: { channelId, event, iv, ciphertext, ts }. The relay never sees plaintext. The
//     transport-level `event` is ALWAYS the message's `eventType` (see EVENT_TYPE below).
//  2. EventEnvelope — the decrypted, standardized object every message uses:
//
//       { eventType, eventSubtype, channelId, sessionId, senderId, senderName, msg, ts }
//
//     `eventType`/`eventSubtype` classify the message; `msg` carries EVERYTHING type-specific
//     (never flattened onto the envelope). Identity fields (channelId/sessionId/senderId/
//     senderName) are stamped by SecureChannel (channel.mjs) on send, so factories only build
//     { eventType, eventSubtype, msg, ts } and the channel fills in who/where.
//
// Zero dependencies on purpose: importable as-is by the Node extension and the browser app.

/**
 * Top-level event types. Each is ALSO the transport topic the message publishes/subscribes on,
 * so there is no separate kind->event lookup to keep in sync — `eventType` is just a field.
 */
export const EVENT_TYPE = Object.freeze({
  STREAM: "stream", // ext -> phone: assistant tokens, tool activity, logs, activity, user echo
  PROMPT: "prompt", // phone -> ext: user prompt
  APPROVAL: "approval", // ext -> phone: native permission request
  DECISION: "decision", // phone -> ext: user's choice for an approval
  ELICITATION: "elicitation", // ext -> phone: ask_user form request + its completion (dismiss)
  ELICITATION_RESPONSE: "elicitation_response", // phone -> ext: the user's answer to a form
  CONTROL: "control", // both: lifecycle, heartbeat, mode, history, state
  PAIR: "pair", // both (plaintext, pre-key): the ECDH handshake (hello/ack)
});

/**
 * Fine-grained subtype, scoped UNDER its eventType (so the same subtype string may appear under
 * different types, e.g. `request` under both APPROVAL and ELICITATION). A message is uniquely
 * identified by the (eventType, eventSubtype) pair.
 */
export const SUBTYPE = Object.freeze({
  STREAM: Object.freeze({
    ASSISTANT_MESSAGE: "assistant_message",
    ASSISTANT_DELTA: "assistant_delta",
    TOOL_START: "tool_start",
    TOOL_COMPLETE: "tool_complete",
    LOG: "log",
    // turn-level activity: true while the agent is generating/acting, false when idle.
    ACTIVITY: "activity",
    // a user prompt typed at the laptop terminal, echoed to the phone (origin distinguishes source).
    USER_MESSAGE: "user_message",
  }),
  PROMPT: Object.freeze({ PROMPT: "prompt" }),
  APPROVAL: Object.freeze({ REQUEST: "request", COMPLETE: "complete" }),
  DECISION: Object.freeze({ APPROVAL_DECISION: "approval_decision" }),
  ELICITATION: Object.freeze({ REQUEST: "request", COMPLETE: "complete" }),
  ELICITATION_RESPONSE: Object.freeze({ RESPONSE: "response" }),
  CONTROL: Object.freeze({
    CHANNEL_UP: "channel_up",
    SESSION_META: "session_meta",
    CHANNEL_DOWN: "channel_down",
    HEARTBEAT: "heartbeat",
    MODE: "mode",
    INTERRUPT: "interrupt",
    HISTORY_REQUEST: "history_request",
    HISTORY: "history",
    // In-memory recent-turns snapshot (higher fidelity than the DB: captures the full assistant
    // text the CLI store drops for long/multi-tool turns). Requested on connect; see recentTurns().
    RECENT_TURNS_REQUEST: "recent_turns_request",
    RECENT_TURNS: "recent_turns",
    STATE_REQUEST: "state_request",
    STATE_SNAPSHOT: "state_snapshot",
    // --- phone-launched sessions (#156): talk to a `helm-cli` listener over its paired channel ---
    // phone -> listener: give me your registered projects (sent right after pairing).
    PROJECT_LIST_REQUEST: "project_list_request",
    // listener -> phone: the machine's registered projects + the listener's display name.
    PROJECT_LIST: "project_list",
    // phone -> listener: spawn a new Copilot session for a project with a permission mode.
    SPAWN_SESSION: "spawn_session",
    // listener -> phone: the pre-minted pairing payload for a freshly spawned session.
    SPAWN_PAIRING: "spawn_pairing",
    // listener -> phone: terminal result of a spawn request (ok / failure reason).
    SPAWN_RESULT: "spawn_result",
    // phone -> listener: forget this device (the listener stops / drops the binding).
    FORGET_DEVICE: "forget_device",
    // phone -> ext: Voice Mode (#168) is on/off. While on, the extension prepends a directive to
    // each relayed prompt so the agent authors its reply for SPEECH (concise, no verbatim code).
    VOICE_MODE: "voice_mode",
  }),
  PAIR: Object.freeze({ HELLO: "hello", ACK: "ack" }),
});

/** Session modes the phone can request. (Applied best-effort by the extension; see spike.) */
export const MODES = Object.freeze(["interactive", "plan", "autopilot"]);

const now = () => Date.now();

/**
 * Build the type-agnostic part of an envelope. Identity (channelId/sessionId/senderId/senderName)
 * is stamped later by SecureChannel on send, so callers never pass it.
 */
const envelope = (eventType, eventSubtype, msg = {}) => ({ eventType, eventSubtype, msg, ts: now() });

// ---- factories (ext -> phone : stream) -------------------------------------
export const assistantMessage = (content, messageId) =>
  envelope(EVENT_TYPE.STREAM, SUBTYPE.STREAM.ASSISTANT_MESSAGE, { content, messageId });
export const assistantDelta = (content, messageId) =>
  envelope(EVENT_TYPE.STREAM, SUBTYPE.STREAM.ASSISTANT_DELTA, { content, messageId });
export const toolStart = (toolCallId, toolName, args) =>
  envelope(EVENT_TYPE.STREAM, SUBTYPE.STREAM.TOOL_START, { toolCallId, toolName, args });
export const toolComplete = (toolCallId, toolName, success, resultPreview) =>
  envelope(EVENT_TYPE.STREAM, SUBTYPE.STREAM.TOOL_COMPLETE, {
    toolCallId,
    toolName,
    success,
    resultPreview,
  });
export const logLine = (level, message) =>
  envelope(EVENT_TYPE.STREAM, SUBTYPE.STREAM.LOG, { level, message });
/**
 * Turn-level activity (ext -> phone). `busy` is true when the agent starts a turn and false when
 * its processing loop goes idle. Drives the phone's Stop control for the whole abortable turn.
 */
export const activity = (busy) =>
  envelope(EVENT_TYPE.STREAM, SUBTYPE.STREAM.ACTIVITY, { busy: Boolean(busy) });
/**
 * A user prompt echoed from the laptop to the phone. `origin` records which device typed it
 * ('phone' = this device; 'terminal' = the laptop). `id` is a stable id (the SDK event id) for dedup.
 */
export const userMessage = (text, origin = "terminal", id) =>
  envelope(EVENT_TYPE.STREAM, SUBTYPE.STREAM.USER_MESSAGE, { text, origin, id });

// ---- factories (phone -> ext : prompt) -------------------------------------
/**
 * A phone-typed prompt relayed to the laptop session. `attachments` (optional) carries inline
 * images the user picked: each is `{ data (base64, no `data:` prefix), mimeType, name }`.
 */
export const prompt = (text, attachments = null) =>
  envelope(EVENT_TYPE.PROMPT, SUBTYPE.PROMPT.PROMPT, {
    text,
    ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
  });

// ---- factories (approval / decision) ---------------------------------------
/**
 * Approval request mirrors the NATIVE Copilot permission prompt. `options` is the verbatim set of
 * choices the terminal would show; the phone echoes back the chosen option id in the decision.
 */
export const approvalRequest = (requestId, toolName, toolArgs, options, deadline = {}) =>
  envelope(EVENT_TYPE.APPROVAL, SUBTYPE.APPROVAL.REQUEST, {
    requestId,
    toolName,
    toolArgs,
    options,
    ...(deadline && typeof deadline === "object" && "timeoutMs" in deadline
      ? { timeoutMs: deadline.timeoutMs }
      : {}),
    ...(deadline && typeof deadline === "object" && "expiresAt" in deadline
      ? { expiresAt: deadline.expiresAt }
      : {}),
  });
export const approvalDecision = (requestId, optionId, raw) =>
  envelope(EVENT_TYPE.DECISION, SUBTYPE.DECISION.APPROVAL_DECISION, { requestId, optionId, raw });
/**
 * Ext -> phone notice that an approval was resolved elsewhere (timed out, decided on another device,
 * or the relay stopped); dismiss any open banner for it. The approval analogue of elicitationComplete
 * — permissions have no native completion event, so the relay synthesizes this on resolve. `decision`
 * is informational (the chosen optionId, "timeout", ...); the phone only needs the requestId.
 */
export const approvalComplete = (requestId, decision) =>
  envelope(EVENT_TYPE.APPROVAL, SUBTYPE.APPROVAL.COMPLETE, { requestId, decision });

// ---- factories (elicitation / ask_user) ------------------------------------
/**
 * Elicitation request mirrors the CLI's `ask_user` prompt (ext -> phone). `mode` is "form" or "url".
 * `requestedSchema` is the JSON Schema the phone renders as a form.
 */
export const elicitationRequest = (requestId, message, mode, requestedSchema, toolCallId, url) =>
  envelope(EVENT_TYPE.ELICITATION, SUBTYPE.ELICITATION.REQUEST, {
    requestId,
    message,
    mode: mode ?? "form",
    requestedSchema,
    toolCallId,
    url,
  });
/**
 * Phone -> ext answer to an elicitation. `action` is "accept"/"decline"/"cancel". `content` (only
 * meaningful for "accept") carries the submitted field values; never shipped when the user backs out.
 */
export const elicitationResponse = (requestId, action, content) =>
  envelope(EVENT_TYPE.ELICITATION_RESPONSE, SUBTYPE.ELICITATION_RESPONSE.RESPONSE, {
    requestId,
    action,
    content: action === "accept" ? content : undefined,
  });
/** Ext -> phone notice that an elicitation was resolved elsewhere; dismiss any open form for it. */
export const elicitationComplete = (requestId, action) =>
  envelope(EVENT_TYPE.ELICITATION, SUBTYPE.ELICITATION.COMPLETE, { requestId, action });

// ---- factories (control) ---------------------------------------------------
/**
 * Ext -> phone: the channel is live. channelId/sessionId now travel on the ENVELOPE (stamped by the
 * channel), so this only carries the session's cwd + CLI chat title (summary).
 */
export const channelUp = (cwd, title) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.CHANNEL_UP, { cwd, title });
/** Lightweight, post-start metadata refresh (ext -> phone): the latest CLI title (and cwd). */
export const sessionMeta = (title, cwd) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.SESSION_META, { title, cwd });
export const channelDown = (reason) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.CHANNEL_DOWN, { reason });
/**
 * Ext -> phone liveness beat. `latestTurnIndex` is the highest committed turn_index (a fresh forward
 * cursor), or null when unknown. `busy` re-asserts the turn-in-flight flag each beat; null = unknown.
 */
export const heartbeat = (latestTurnIndex = null, busy = null) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.HEARTBEAT, { latestTurnIndex, busy });
export const modeChange = (mode) => envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.MODE, { mode });
/** Phone -> ext request to stop the current turn (best-effort; safe when nothing is running). */
export const interrupt = () => envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.INTERRUPT, {});

// ---- factories (history backfill) ------------------------------------------
/**
 * Phone -> ext request for a page of turns. `before` = backward cursor (older, scrollback);
 * `since` = forward cursor (newer, catch-up); both null = latest page. Mutually exclusive.
 */
export const historyRequest = (before = null, limit, since = null) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.HISTORY_REQUEST, { before, since, limit });
/**
 * Ext -> phone page of history. `items` ascending; `nextCursor`/`hasMore` continue the SAME
 * direction; `since` echoes the request's forward cursor (non-null => forward catch-up page).
 */
export const history = (items, nextCursor = null, hasMore = false, since = null) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.HISTORY, { items, nextCursor, hasMore, since });

// ---- factories (recent-turns snapshot) -------------------------------------
/**
 * Phone -> ext request for the extension's in-memory recent-turns buffer (the last `limit` turns it
 * knows). Preferred over history_request for the connect-time backfill because the buffer keeps the
 * FULL assistant text the CLI store drops for long/multi-tool turns.
 */
export const recentTurnsRequest = (limit) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.RECENT_TURNS_REQUEST, { limit });
/**
 * Ext -> phone snapshot of the last N turns as flat message entries, ascending (chronological).
 * Each item is `{ role, text, ts, id }`; `id` is a stable per-message id (assistant messageId /
 * user event id / `seed-<turn>-<role>` for store-seeded turns) so re-applying a snapshot is a no-op.
 * Self-contained (no cursor): the phone merges it into the transcript tail by id + content dedup.
 */
export const recentTurns = (items) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.RECENT_TURNS, { items: Array.isArray(items) ? items : [] });

// ---- factories (state snapshot) --------------------------------------------
/** Phone -> ext: request the current session state on (re)connect / refresh / resume. */
export const stateRequest = () => envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.STATE_REQUEST, {});
/**
 * Ext -> phone snapshot of the live session state. `approvals`/`elicitations` are the still-pending
 * prompt PAYLOADS (flat, same shape as an approvalRequest/elicitationRequest `msg`) so the phone
 * reuses its normal renderers.
 */
export const stateSnapshot = ({
  busy = false,
  abortable = false,
  mode = null,
  latestTurnIndex = null,
  approvals = [],
  elicitations = [],
} = {}) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.STATE_SNAPSHOT, {
    busy: Boolean(busy),
    abortable: Boolean(abortable),
    mode,
    latestTurnIndex,
    approvals,
    elicitations,
  });

// ---- factories (phone-launched sessions #156, all ride CONTROL) ------------
/** Phone -> listener: request the machine's registered projects (sent right after pairing). */
export const projectListRequest = () =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.PROJECT_LIST_REQUEST, {});
/**
 * Listener -> phone: the machine's registered projects + the listener's display name. `projects`
 * is `[{ name, path, isDefault }]` (path is informational for the phone; selection is by name).
 * `deviceId` (optional) is a STABLE, NON-SECRET id the listener persists across `helm-cli start`
 * restarts (see extension/src/deviceIdentity.mjs) so the phone can recognize "same laptop" even
 * though its ephemeral pairing `channelId`/keypair are freshly minted every run (by design, for
 * forward secrecy — see docs/pairing.md). Never derived from or tied to any cryptographic key.
 */
export const projectList = (projects, deviceName, deviceId) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.PROJECT_LIST, {
    projects: Array.isArray(projects) ? projects : [],
    deviceName: deviceName ?? null,
    deviceId: deviceId ?? null,
  });
/**
 * Phone -> listener: spawn a new Copilot session. `requestId` correlates the reply; `projectName`
 * selects a registered project; `mode` is "default" | "allow-all"; `name` is the friendly session name.
 */
export const spawnSession = (requestId, projectName, mode = "default", name = null) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.SPAWN_SESSION, { requestId, projectName, mode, name });
/**
 * Listener -> phone: the pre-minted pairing payload of a freshly spawned session, so the phone
 * pairs to it digitally (no QR). `payload` is a buildPairingPayload() result; `name`/`projectName`
 * let the phone label the Initializing card immediately.
 */
export const spawnPairing = (requestId, payload, name, projectName) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.SPAWN_PAIRING, { requestId, payload, name, projectName });
/** Listener -> phone: terminal result of a spawn request. `ok=false` carries a human `error`. */
export const spawnResult = (requestId, ok, error = null) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.SPAWN_RESULT, { requestId, ok: Boolean(ok), error });
/** Phone -> listener: forget this device; the listener stops (or drops its phone binding). */
export const forgetDevice = () =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.FORGET_DEVICE, {});

/**
 * Phone -> ext: Voice Mode is now on/off (#176). While on, the extension prepends a short
 * spoken-response directive to each relayed phone prompt so the agent replies for LISTENING
 * (short, conversational, summarize code) instead of dense on-screen text.
 */
export const voiceMode = (active) =>
  envelope(EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.VOICE_MODE, { active: Boolean(active) });

/** Minimal structural validation of a decrypted envelope (kept dependency-free). */
export function isValidEnvelope(env) {
  return (
    env != null &&
    typeof env === "object" &&
    typeof env.eventType === "string" &&
    typeof env.eventSubtype === "string" &&
    typeof env.ts === "number" &&
    env.msg != null &&
    typeof env.msg === "object"
  );
}

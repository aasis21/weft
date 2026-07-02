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
  APPROVAL: Object.freeze({ REQUEST: "request" }),
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
    STATE_REQUEST: "state_request",
    STATE_SNAPSHOT: "state_snapshot",
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
export const approvalRequest = (requestId, toolName, toolArgs, options) =>
  envelope(EVENT_TYPE.APPROVAL, SUBTYPE.APPROVAL.REQUEST, {
    requestId,
    toolName,
    toolArgs,
    options,
  });
export const approvalDecision = (requestId, optionId, raw) =>
  envelope(EVENT_TYPE.DECISION, SUBTYPE.DECISION.APPROVAL_DECISION, { requestId, optionId, raw });

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

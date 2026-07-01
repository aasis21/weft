// Helm shared message protocol.
//
// Two layers:
//  1. TransportMessage — the opaque, E2E-encrypted envelope that travels over the relay.
//     Shape: { channelId, event, iv, ciphertext, ts }. The relay never sees plaintext.
//  2. Inner messages — the decrypted, typed objects below. SecureChannel (channel.mjs)
//     handles encrypt/decrypt + identity tagging so callers only deal with inner messages.
//
// Zero dependencies on purpose: importable as-is by the Node extension and the browser app.

/** Logical events multiplexed over the single per-pairing Broadcast channel. */
export const EVENTS = Object.freeze({
  STREAM: "stream", // ext -> phone: assistant tokens, tool activity, logs
  PROMPT: "prompt", // phone -> ext: user prompt
  APPROVAL: "approval", // ext -> phone: native permission request
  DECISION: "decision", // phone -> ext: user's choice for an approval
  ELICITATION: "elicitation", // ext -> phone: ask_user form request + its completion (dismiss)
  ELICITATION_RESPONSE: "elicitation_response", // phone -> ext: the user's answer to a form
  CONTROL: "control", // both: lifecycle, heartbeat, mode
});

/** Inner message kinds. */
export const KIND = Object.freeze({
  // stream (ext -> phone)
  ASSISTANT_MESSAGE: "assistant.message",
  ASSISTANT_DELTA: "assistant.delta",
  TOOL_START: "tool.start",
  TOOL_COMPLETE: "tool.complete",
  LOG: "log",
  // turn-level activity (ext -> phone): true while the agent is generating/acting
  // (a turn is in flight — text, reasoning, or a tool), false when its loop goes idle.
  // Drives the phone's Stop control so it tracks the whole abortable turn, not just tools.
  ACTIVITY: "stream.activity",
  // a user prompt typed at the laptop terminal, echoed to the phone so its local
  // transcript isn't missing the user side of terminal-driven turns. `origin`
  // distinguishes the source device ('phone' for this device, 'terminal' for the laptop).
  USER_MESSAGE: "stream.user_message",
  // prompt (phone -> ext)
  PROMPT: "prompt",
  // approval (ext -> phone) / decision (phone -> ext)
  APPROVAL_REQUEST: "approval.request",
  APPROVAL_DECISION: "approval.decision",
  // elicitation / ask_user (ext -> phone request + completion, phone -> ext response).
  // Mirrors approval, but the payload is a JSON-Schema form the agent wants filled in.
  ELICITATION_REQUEST: "elicitation.request",
  ELICITATION_RESPONSE: "elicitation.response",
  // ext -> phone: an elicitation was resolved (by this phone, the terminal, or another
  // device) — the phone must dismiss any open form for this requestId.
  ELICITATION_COMPLETE: "elicitation.complete",
  // control (both)
  SESSION_START: "control.session_start",
  SESSION_META: "control.session_meta",
  SESSION_END: "control.session_end",
  HEARTBEAT: "control.heartbeat",
  MODE: "control.mode",
  // interrupt (phone -> ext): stop/cancel the in-flight generation or tool run.
  INTERRUPT: "control.interrupt",
  // history backfill (phone <-> ext): the phone pulls older turns it never saw
  // (first join, or scrollback) from the CLI session store.
  HISTORY_REQUEST: "control.history_request",
  HISTORY: "control.history",
  // state snapshot (phone <-> ext): on (re)connect / refresh / resume the phone asks the ext
  // for the CURRENT session state (busy/mode + pending approval & ask_user prompts) so a fresh
  // or mid-turn join shows the truth immediately instead of waiting for the next live event.
  STATE_REQUEST: "control.state_request",
  STATE_SNAPSHOT: "control.state_snapshot",
});

/** Session modes the phone can request. (Applied best-effort by the extension; see spike.) */
export const MODES = Object.freeze(["interactive", "plan", "autopilot"]);

const now = () => Date.now();

// ---- factories (ext -> phone : stream) -------------------------------------
export const assistantMessage = (content, messageId) => ({
  kind: KIND.ASSISTANT_MESSAGE,
  content,
  messageId,
  ts: now(),
});
export const assistantDelta = (content, messageId) => ({
  kind: KIND.ASSISTANT_DELTA,
  content,
  messageId,
  ts: now(),
});
export const toolStart = (toolCallId, toolName, args) => ({
  kind: KIND.TOOL_START,
  toolCallId,
  toolName,
  args,
  ts: now(),
});
export const toolComplete = (toolCallId, toolName, success, resultPreview) => ({
  kind: KIND.TOOL_COMPLETE,
  toolCallId,
  toolName,
  success,
  resultPreview,
  ts: now(),
});
export const logLine = (level, message) => ({
  kind: KIND.LOG,
  level,
  message,
  ts: now(),
});
/**
 * Turn-level activity (ext -> phone). `busy` is true when the agent starts a turn
 * (assistant message_start / first delta / tool start) and false when its processing
 * loop goes idle (SDK `assistant.idle`). The phone shows Stop while busy, matching the
 * turn-abort the interrupt actually performs.
 */
export const activity = (busy) => ({
  kind: KIND.ACTIVITY,
  busy: Boolean(busy),
  ts: now(),
});
/**
 * A user prompt echoed from the laptop to the phone. `origin` records which device
 * typed it ('phone' = this device, already shown optimistically; 'terminal' = the
 * laptop). `id` is a stable identifier (the SDK event id) so the phone can dedup.
 */
export const userMessage = (text, origin = "terminal", id) => ({
  kind: KIND.USER_MESSAGE,
  text,
  origin,
  id,
  ts: now(),
});

// ---- factories (phone -> ext : prompt) -------------------------------------
/**
 * A phone-typed prompt relayed to the laptop session. `attachments` (optional) carries
 * inline images the user picked in the composer: each is `{ data (base64, no `data:` URL
 * prefix), mimeType, name }`. The extension maps them to Copilot SDK blob attachments.
 * Images are downscaled on the phone so the encrypted payload stays under the transport cap.
 */
export const prompt = (text, attachments = null) => ({
  kind: KIND.PROMPT,
  text,
  ...(Array.isArray(attachments) && attachments.length ? { attachments } : {}),
  ts: now(),
});

// ---- factories (approval / decision) ---------------------------------------
/**
 * Approval request mirrors the NATIVE Copilot permission prompt. `options` is the
 * verbatim set of choices the terminal would show (e.g. allow-once / allow-always / deny);
 * the phone simply echoes back the chosen option id in the decision.
 */
export const approvalRequest = (requestId, toolName, toolArgs, options) => ({
  kind: KIND.APPROVAL_REQUEST,
  requestId,
  toolName,
  toolArgs,
  options,
  ts: now(),
});
export const approvalDecision = (requestId, optionId, raw) => ({
  kind: KIND.APPROVAL_DECISION,
  requestId,
  optionId,
  raw, // optional: the full native PermissionRequestResult, if the phone reconstructs it
  ts: now(),
});

// ---- factories (elicitation / ask_user) ------------------------------------
/**
 * Elicitation request mirrors the CLI's `ask_user` / elicitation prompt (ext -> phone).
 * `mode` is "form" (structured input, the common case) or "url" (open a browser).
 * `requestedSchema` is the JSON Schema ({ type:"object", properties, required }) the phone
 * renders as a form. `toolCallId` correlates the prompt with the tool call shown remotely.
 */
export const elicitationRequest = (requestId, message, mode, requestedSchema, toolCallId, url) => ({
  kind: KIND.ELICITATION_REQUEST,
  requestId,
  message,
  mode: mode ?? "form",
  requestedSchema,
  toolCallId,
  url,
  ts: now(),
});
/**
 * Phone -> ext answer to an elicitation. `action` is "accept" (submitted the form),
 * "decline" (explicitly refused) or "cancel" (dismissed). `content` carries the submitted
 * field values (keyed by schema field name) and is only meaningful when action === "accept".
 */
export const elicitationResponse = (requestId, action, content) => ({
  kind: KIND.ELICITATION_RESPONSE,
  requestId,
  action,
  // Never ship half-entered field values off the phone when the user backs out.
  content: action === "accept" ? content : undefined,
  ts: now(),
});
/**
 * Ext -> phone notice that an elicitation was resolved (here, at the terminal, or on another
 * device). The phone dismisses any open form for `requestId`. `action` echoes how it was
 * resolved when known, purely for display.
 */
export const elicitationComplete = (requestId, action) => ({
  kind: KIND.ELICITATION_COMPLETE,
  requestId,
  action,
  ts: now(),
});

// ---- factories (control) ---------------------------------------------------
export const sessionStart = (channelId, sessionId, cwd, title) => ({
  kind: KIND.SESSION_START,
  channelId,
  sessionId,
  cwd,
  title, // CLI chat summary ("title"); may be empty until the CLI derives one
  ts: now(),
});
/**
 * Lightweight, post-start metadata refresh (ext -> phone). The CLI keeps refining the
 * chat title (summary) as the conversation grows, so the extension re-sends just the
 * latest title (and cwd, if it changed) without the lifecycle semantics of session_start.
 */
export const sessionMeta = (title, cwd) => ({
  kind: KIND.SESSION_META,
  title,
  cwd,
  ts: now(),
});
export const sessionEnd = (reason) => ({
  kind: KIND.SESSION_END,
  reason,
  ts: now(),
});
/**
 * Ext -> phone liveness beat. `latestTurnIndex` is the highest committed turn_index in the CLI
 * store at beat time (or null when unknown), so a connected phone keeps a FRESH forward cursor
 * for post-away catch-up without waiting for a full state snapshot. `busy` is the authoritative
 * turn-in-flight flag re-asserted every beat, so a dropped `assistant.idle` self-corrects within
 * one heartbeat instead of leaving the Stop control stuck; null means "unknown, don't touch".
 */
export const heartbeat = (latestTurnIndex = null, busy = null) => ({
  kind: KIND.HEARTBEAT,
  latestTurnIndex,
  busy,
  ts: now(),
});
export const modeChange = (mode) => ({ kind: KIND.MODE, mode, ts: now() });
/**
 * Phone -> ext request to stop the current turn. The extension calls the SDK's
 * interrupt/cancel path; safe to send even when nothing is running (best-effort).
 */
export const interrupt = () => ({ kind: KIND.INTERRUPT, ts: now() });

// ---- factories (history backfill) ------------------------------------------
/**
 * Phone -> ext request for a page of turns. Three directions share this one kind:
 *  - latest page  → both `before` and `since` null/undefined (fresh join / never-seen session).
 *  - backward     → `before` is a turn_index cursor (exclusive): return turns OLDER than it
 *                   ("load earlier" scrollback).
 *  - forward      → `since` is a turn_index cursor (exclusive): return turns NEWER than it,
 *                   ascending (post-away catch-up). `before` and `since` are mutually exclusive.
 * `limit` is a hint — the extension clamps it to a safe max so each encrypted broadcast stays small.
 */
export const historyRequest = (before = null, limit, since = null) => ({
  kind: KIND.HISTORY_REQUEST,
  before,
  since,
  limit,
  ts: now(),
});
/**
 * Ext -> phone page of history. `items` are HistoryItem[] in ascending turn order.
 * `nextCursor` is the turn_index to continue the SAME direction (next `before` for backward,
 * next `since` for forward), or null when nothing more remains; `hasMore` mirrors that.
 * `since` echoes the request's forward cursor: when non-null the page is a FORWARD catch-up
 * (append missed turns to the transcript tail); when null it's a latest/backward page (scrollback).
 */
export const history = (items, nextCursor = null, hasMore = false, since = null) => ({
  kind: KIND.HISTORY,
  items,
  nextCursor,
  hasMore,
  since,
  ts: now(),
});

// ---- factories (state snapshot) --------------------------------------------
/**
 * Phone -> ext: request the current session state on (re)connect / refresh / resume. The ext
 * replies with a stateSnapshot so a phone that joins fresh, reconnects, or lands MID-TURN shows
 * the truth immediately (working vs ready, current mode, and any pending prompts) instead of
 * waiting for the next live event.
 */
export const stateRequest = () => ({ kind: KIND.STATE_REQUEST, ts: now() });
/**
 * Ext -> phone snapshot of the live session state, answering a stateRequest:
 *  - `busy`      — a turn is in flight (from the SDK activity RPC / isProcessing).
 *  - `abortable` — that in-flight work can be stopped (drives the Stop control at connect time).
 *  - `mode`      — the session's current mode, or null when unknown.
 *  - `latestTurnIndex` — highest committed turn_index in the store (the phone's forward cursor).
 *  - `approvals` / `elicitations` — currently PENDING prompts to (re)render, each already in
 *    approvalRequest / elicitationRequest shape so the phone reuses its normal renderers.
 */
export const stateSnapshot = ({
  busy = false,
  abortable = false,
  mode = null,
  latestTurnIndex = null,
  approvals = [],
  elicitations = [],
} = {}) => ({
  kind: KIND.STATE_SNAPSHOT,
  busy: Boolean(busy),
  abortable: Boolean(abortable),
  mode,
  latestTurnIndex,
  approvals,
  elicitations,
  ts: now(),
});

/** Map an inner message kind to the logical event it should be published on. */
export function eventForKind(kind) {
  switch (kind) {
    case KIND.ASSISTANT_MESSAGE:
    case KIND.ASSISTANT_DELTA:
    case KIND.TOOL_START:
    case KIND.TOOL_COMPLETE:
    case KIND.LOG:
    case KIND.ACTIVITY:
    case KIND.USER_MESSAGE:
      return EVENTS.STREAM;
    case KIND.PROMPT:
      return EVENTS.PROMPT;
    case KIND.APPROVAL_REQUEST:
      return EVENTS.APPROVAL;
    case KIND.APPROVAL_DECISION:
      return EVENTS.DECISION;
    case KIND.ELICITATION_REQUEST:
    case KIND.ELICITATION_COMPLETE:
      return EVENTS.ELICITATION;
    case KIND.ELICITATION_RESPONSE:
      return EVENTS.ELICITATION_RESPONSE;
    case KIND.SESSION_START:
    case KIND.SESSION_META:
    case KIND.SESSION_END:
    case KIND.HEARTBEAT:
    case KIND.MODE:
    case KIND.INTERRUPT:
    case KIND.HISTORY_REQUEST:
    case KIND.HISTORY:
    case KIND.STATE_REQUEST:
    case KIND.STATE_SNAPSHOT:
      return EVENTS.CONTROL;
    default:
      throw new Error(`helm/messages: unknown kind "${kind}"`);
  }
}

/** Minimal structural validation (kept dependency-free; mobile may layer zod on top). */
export function isValidInner(msg) {
  return (
    msg != null &&
    typeof msg === "object" &&
    typeof msg.kind === "string" &&
    typeof msg.ts === "number"
  );
}

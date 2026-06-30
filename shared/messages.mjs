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
  // a user prompt typed at the laptop terminal, echoed to the phone so its local
  // transcript isn't missing the user side of terminal-driven turns. `origin`
  // distinguishes the source device ('phone' for this device, 'terminal' for the laptop).
  USER_MESSAGE: "stream.user_message",
  // prompt (phone -> ext)
  PROMPT: "prompt",
  // approval (ext -> phone) / decision (phone -> ext)
  APPROVAL_REQUEST: "approval.request",
  APPROVAL_DECISION: "approval.decision",
  // control (both)
  SESSION_START: "control.session_start",
  SESSION_META: "control.session_meta",
  SESSION_END: "control.session_end",
  HEARTBEAT: "control.heartbeat",
  MODE: "control.mode",
  // history backfill (phone <-> ext): the phone pulls older turns it never saw
  // (first join, or scrollback) from the CLI session store.
  HISTORY_REQUEST: "control.history_request",
  HISTORY: "control.history",
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
export const prompt = (text) => ({ kind: KIND.PROMPT, text, ts: now() });

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
export const heartbeat = () => ({ kind: KIND.HEARTBEAT, ts: now() });
export const modeChange = (mode) => ({ kind: KIND.MODE, mode, ts: now() });

// ---- factories (history backfill) ------------------------------------------
/**
 * Phone -> ext request for a page of older turns. `before` is a turn_index cursor
 * (exclusive); null/undefined means "the latest page". `limit` is a hint — the
 * extension clamps it to a safe maximum so each encrypted broadcast stays small.
 */
export const historyRequest = (before = null, limit) => ({
  kind: KIND.HISTORY_REQUEST,
  before,
  limit,
  ts: now(),
});
/**
 * Ext -> phone page of history. `items` are HistoryItem[] in ascending turn order.
 * `nextCursor` is the turn_index to pass as the next `before` (or null when there is
 * nothing older); `hasMore` mirrors that as a convenience.
 */
export const history = (items, nextCursor = null, hasMore = false) => ({
  kind: KIND.HISTORY,
  items,
  nextCursor,
  hasMore,
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
    case KIND.USER_MESSAGE:
      return EVENTS.STREAM;
    case KIND.PROMPT:
      return EVENTS.PROMPT;
    case KIND.APPROVAL_REQUEST:
      return EVENTS.APPROVAL;
    case KIND.APPROVAL_DECISION:
      return EVENTS.DECISION;
    case KIND.SESSION_START:
    case KIND.SESSION_META:
    case KIND.SESSION_END:
    case KIND.HEARTBEAT:
    case KIND.MODE:
    case KIND.HISTORY_REQUEST:
    case KIND.HISTORY:
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

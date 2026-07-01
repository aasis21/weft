import { randomUUID } from "node:crypto";
import {
  EVENTS,
  KIND,
  MODES,
  assistantMessage,
  assistantDelta,
  toolStart,
  toolComplete,
  logLine,
  activity,
  userMessage,
  approvalRequest,
  elicitationRequest,
  elicitationComplete,
  channelUp,
  sessionMeta,
  channelDown,
  heartbeat,
  modeChange,
  history,
  stateSnapshot,
} from "@aasis21/helm-shared";
import { readSummary, readHistory, readLatestTurnIndex } from "./store.mjs";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
// ask_user forms take longer to fill in than a one-tap approval, so allow more slack before
// the fail-safe cancel fires (a cancel is a no-op if the terminal already answered).
const DEFAULT_ELICITATION_TIMEOUT_MS = 300_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
// How long a phone-relayed prompt stays "claimable" so the echoed user.message session
// event it produces is attributed to the phone (and not re-broadcast as a terminal msg).
const PROMPT_CORRELATION_WINDOW_MS = 30_000;

/**
 * Tracks recent phone-originated prompts so that when the matching `user.message`
 * session event fires we can tell it apart from a prompt typed at the laptop terminal.
 * The SDK event carries no source device, so we correlate by exact content within a
 * short time window. Pure + injectable clock → unit-testable.
 *
 * - `record(text)` — call right before relaying a phone prompt into the session.
 * - `classify(text)` — call on each `user.message`; returns 'phone' (consuming the
 *   match so a later identical terminal prompt isn't mis-attributed) or 'terminal'.
 */
export function createPromptOriginTracker({
  windowMs = PROMPT_CORRELATION_WINDOW_MS,
  now = () => Date.now(),
} = {}) {
  let pending = [];
  const prune = () => {
    const cutoff = now() - windowMs;
    pending = pending.filter((p) => p.ts >= cutoff);
  };
  return {
    record(text) {
      if (typeof text !== "string") return;
      prune();
      pending.push({ text, ts: now() });
    },
    classify(text) {
      prune();
      const idx = pending.findIndex((p) => p.text === text);
      if (idx === -1) return "terminal";
      pending.splice(idx, 1);
      return "phone";
    },
    get size() {
      return pending.length;
    },
  };
}

export function createPermissionRelay({
  channel,
  approvalTimeoutMs = approvalTimeoutFromEnv(),
  logger = () => {},
} = {}) {
  if (!channel) throw new Error("helm relay: channel is required");
  const pending = new Map();

  const unsubscribe = channel.onEvent(EVENTS.DECISION, (msg) => {
    if (msg?.kind !== KIND.APPROVAL_DECISION) return;
    const entry = pending.get(msg.requestId);
    if (!entry) return;
    pending.delete(msg.requestId);
    clearTimeout(entry.timer);
    entry.resolve(permissionResultFromDecision(msg));
  });

  async function onPermissionRequest(request, invocation = {}) {
    const requestId = randomUUID();
    const toolName = inferToolName(request);
    const toolArgs = inferToolArgs(request);
    const options = inferOptions(request);
    // Keep the exact payload we sent so a late-joining phone can have it replayed verbatim
    // in a state snapshot (same requestId → its decision still resolves this pending entry).
    const payload = approvalRequest(requestId, toolName, toolArgs, options);

    await channel.send(payload);

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        logger(
          `Helm: approval request timed out after ${approvalTimeoutMs}ms; denying ${toolName}.`,
          { level: "warning", ephemeral: false },
        );
        resolve({
          kind: "reject",
          feedback: "Helm approval timed out",
        });
      }, approvalTimeoutMs);

      pending.set(requestId, { resolve, timer, request, invocation, payload });
    });
  }

  /** The still-pending approval prompts, as their original approvalRequest payloads, so a phone
   *  that (re)connects mid-request can render them from a state snapshot. */
  function snapshotPending() {
    return [...pending.values()].map((entry) => entry.payload).filter(Boolean);
  }

  function close() {
    unsubscribe?.();
    for (const [requestId, entry] of pending) {
      clearTimeout(entry.timer);
      entry.resolve({
        kind: "reject",
        feedback: "Helm relay stopped before approval decision",
      });
      pending.delete(requestId);
    }
  }

  return { onPermissionRequest, snapshotPending, close };
}

/**
 * Relays the CLI's `ask_user` / elicitation prompts to the phone and forwards the phone's
 * answer back into the session — the elicitation analogue of `createPermissionRelay`.
 *
 * Unlike permissions (a declarative `onPermissionRequest` hook the SDK calls), elicitation is
 * event-driven: the runtime emits `elicitation.requested`, and any consumer may answer via
 * `session.rpc.respondToElicitation(requestId, result)`. Because this is dual-owned with the
 * live terminal, the phone is an *additional* responder — whoever answers first wins, and the
 * runtime's `elicitation.completed` event tells the other side to dismiss its UI.
 *
 *  - `offer(data)`     — call on an `elicitation.requested` event: relay the form to the phone.
 *  - `complete(data)`  — call on an `elicitation.completed` event: dismiss the phone's form.
 *  - internally listens for the phone's ELICITATION_RESPONSE and calls respondToElicitation.
 *
 * A per-request timeout fails safe with `{ action: "cancel" }` so a walked-away phone can never
 * hang the agent (the cancel is a no-op when the terminal already answered).
 */
export function createElicitationRelay({
  session,
  channel,
  elicitationTimeoutMs = elicitationTimeoutFromEnv(),
  logger = () => {},
} = {}) {
  if (!channel) throw new Error("helm relay: channel is required");
  const pending = new Map();
  const respond = pickElicitationResponder(session, logger);
  let releaseInterest = () => {};
  // Tell the runtime we want `elicitation.requested` routed to this consumer. Best-effort and
  // reversible: some hosts auto-observe in-process extensions, so a missing API isn't fatal.
  void registerElicitationInterest(session, logger).then((release) => {
    releaseInterest = release;
  });

  const unsubscribe = channel.onEvent(EVENTS.ELICITATION_RESPONSE, (msg) => {
    if (msg?.kind !== KIND.ELICITATION_RESPONSE) return;
    const entry = pending.get(msg.requestId);
    if (!entry) return; // already resolved at the terminal, or timed out
    clearPending(msg.requestId);
    if (!respond) {
      logger(
        "Helm: this CLI build can't accept remote ask_user answers (handlePendingElicitation unavailable).",
        { level: "warning", ephemeral: false },
      );
      return;
    }
    // Feed the phone's answer back into the runtime. success === false means another client
    // (typically the terminal) already answered — harmless, the phone form is already dismissed.
    void Promise.resolve(respond(msg.requestId, elicitResultFromResponse(msg))).then((accepted) => {
      if (accepted === false) {
        logger("Helm: ask_user was already answered before the phone's reply arrived.", {
          level: "info",
        });
      }
    });
  });

  async function offer(data = {}) {
    const requestId = data.requestId;
    if (!requestId) return;
    // Keep the exact payload we sent so a late-joining phone can have the open form replayed
    // verbatim in a state snapshot (same requestId → its answer still resolves this prompt).
    const payload = elicitationRequest(
      requestId,
      data.message ?? "",
      data.mode ?? "form",
      data.requestedSchema,
      data.toolCallId,
      data.url,
    );
    await channel.send(payload);
    const timer = setTimeout(() => {
      pending.delete(requestId);
      // Fail safe so a walked-away phone can't hang the agent; no-op if already answered.
      respond?.(requestId, { action: "cancel" });
      void channel.send(elicitationComplete(requestId, "cancel")).catch(() => {});
      logger(`Helm: ask_user prompt unanswered after ${elicitationTimeoutMs}ms; cancelled.`, {
        level: "warning",
        ephemeral: false,
      });
    }, elicitationTimeoutMs);
    timer.unref?.();
    pending.set(requestId, { timer, payload });
  }

  /** The still-open ask_user prompts, as their original elicitationRequest payloads, so a phone
   *  that (re)connects mid-prompt can render them from a state snapshot. */
  function snapshotPending() {
    return [...pending.values()].map((entry) => entry.payload).filter(Boolean);
  }

  async function complete(data = {}) {
    const requestId = data.requestId;
    if (!requestId) return;
    clearPending(requestId);
    // Dismiss any open form on the phone (the request was answered here or at the terminal).
    await channel.send(elicitationComplete(requestId, data.action));
  }

  function clearPending(requestId) {
    const entry = pending.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(requestId);
  }

  function close() {
    unsubscribe?.();
    for (const requestId of [...pending.keys()]) clearPending(requestId);
    try {
      releaseInterest?.();
    } catch {
      // Releasing interest must never break shutdown.
    }
  }

  return { offer, complete, snapshotPending, close };
}

export async function attachRelay({
  session,
  channel,
  channelId,
  approvalTimeoutMs,
  heartbeatMs = DEFAULT_HEARTBEAT_MS,
  permissionRelay,
} = {}) {
  if (!session) throw new Error("helm relay: session is required");
  if (!channel) throw new Error("helm relay: channel is required");

  await channel.connect?.();

  const sessionId = session.sessionId ?? session.id ?? "unknown-session";
  const cwd = session.cwd ?? session.workingDirectory ?? process.cwd();
  // CLI chat title (summary). Often empty until the CLI derives one, so it is also
  // refreshed on every heartbeat and re-sent (as session_meta) when it changes.
  let lastTitle = await fetchTitle(session);
  const logger = (message, options = {}) => logToSession(session, message, options);
  const approvals =
    permissionRelay ??
    createPermissionRelay({ channel, approvalTimeoutMs, logger });
  const elicitations = createElicitationRelay({ session, channel, logger });
  const unsubscribers = [];
  let stopped = false;
  // Correlates phone-relayed prompts with their echoed user.message events so the relay
  // only re-broadcasts prompts that were actually typed at the laptop terminal.
  const promptOrigin = createPromptOriginTracker();

  const sendSafe = async (msg) => {
    try {
      await channel.send(msg);
    } catch (err) {
      logger(`Helm relay send failed: ${err?.message ?? err}`, { level: "warning" });
    }
  };

  await sendSafe(channelUp(channelId ?? channel.transport?.channelId, sessionId, cwd, lastTitle));
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      // Carry the store's latest turn_index so a connected phone keeps a fresh forward cursor
      // (readLatestTurnIndex is best-effort and returns null on any read failure), plus the
      // authoritative busy flag so a dropped assistant.idle self-corrects within one beat.
      const [latestTurnIndex, activity] = await Promise.all([
        readLatestTurnIndex(sessionId),
        readSessionActivity(session),
      ]);
      await sendSafe(heartbeat(latestTurnIndex, activity ? activity.busy : null));
      // The CLI keeps refining the chat title (summary) as the conversation grows; push the
      // latest to the phone whenever it changes so the header tracks the terminal.
      const title = await fetchTitle(session);
      if (title && title !== lastTitle) {
        lastTitle = title;
        await sendSafe(sessionMeta(title));
      }
    })();
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  if (typeof session.on === "function") {
    unsubscribers.push(
      session.on((event) => void handleSessionEvent(event, sendSafe, promptOrigin, elicitations)),
    );
  }

  unsubscribers.push(
    channel.onEvent(EVENTS.PROMPT, (msg) => {
      if (msg?.kind !== KIND.PROMPT || typeof msg.text !== "string") return;
      // Remember this phone-typed prompt so its echoed user.message session event is
      // attributed to the phone (which already shows it optimistically) and not
      // re-broadcast as a terminal message.
      promptOrigin.record(msg.text);
      // Map phone-relayed image attachments (base64) to Copilot SDK blob attachments.
      // Defensive: drop anything missing base64 `data` or a `mimeType`. The SDK resizes
      // images itself; the phone already downscales to keep the relay payload small.
      const attachments = Array.isArray(msg.attachments)
        ? msg.attachments
            .filter((a) => a && typeof a.data === "string" && a.data && typeof a.mimeType === "string" && a.mimeType)
            .map((a) => ({
              type: "blob",
              data: a.data,
              mimeType: a.mimeType,
              displayName: typeof a.name === "string" && a.name ? a.name : "image",
            }))
        : [];
      const sendOptions = attachments.length
        ? { prompt: msg.text, attachments, mode: "immediate" }
        : { prompt: msg.text, mode: "immediate" };
      void session
        .send?.(sendOptions)
        ?.catch?.((err) =>
          logger(`Helm prompt relay failed: ${err?.message ?? err}`, {
            level: "warning",
          }),
        );
    }),
  );

  unsubscribers.push(
    channel.onEvent(EVENTS.CONTROL, (msg) => {
      if (msg?.kind === KIND.MODE) {
        void applyMode(session, msg.mode, logger, sendSafe);
        return;
      }
      if (msg?.kind === KIND.INTERRUPT) {
        void applyInterrupt(session, logger, sendSafe);
        return;
      }
      if (msg?.kind === KIND.HISTORY_REQUEST) {
        void serveHistory(sessionId, msg, sendSafe, logger);
        return;
      }
      if (msg?.kind === KIND.STATE_REQUEST) {
        void serveStateSnapshot({ session, sessionId, approvals, elicitations, sendSafe, logger });
      }
    }),
  );

  async function stop(reason = "extension_shutdown", { closeTransport = true } = {}) {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe?.();
    approvals.close?.();
    elicitations.close?.();
    // On a re-pair we keep the shared transport open for the next phone, so we neither announce a
    // session end (the new phone uses a different key and couldn't read it) nor close the channel.
    if (closeTransport) {
      await sendSafe(channelDown(reason));
      await channel.close?.();
    }
  }

  return { stop, onPermissionRequest: approvals.onPermissionRequest };
}

async function handleSessionEvent(event, sendSafe, promptOrigin, elicitations) {
  if (!event?.type) return;
  const data = event.data ?? {};
  switch (event.type) {
    case "assistant.message_start":
      // A turn is now in flight (text/reasoning) — tell the phone so its Stop control
      // appears for the whole abortable turn, not only while a tool runs.
      await sendSafe(activity(true));
      break;
    case "assistant.idle":
      // The agent's processing loop went idle: the turn is over, nothing left to abort.
      await sendSafe(activity(false));
      break;
    case "elicitation.requested":
      // The agent asked a question (ask_user). Relay the form so the phone can answer it,
      // mirroring how native permission prompts are relayed.
      if (elicitations) await elicitations.offer(data);
      break;
    case "elicitation.completed":
      // Answered here, at the terminal, or on another device — dismiss the phone's form.
      if (elicitations) await elicitations.complete(data);
      break;
    case "assistant.message":
      await sendSafe(assistantMessage(data.content ?? "", data.messageId ?? event.id));
      break;
    case "assistant.message_delta":
      await sendSafe(assistantDelta(data.deltaContent ?? "", data.messageId ?? event.id));
      break;
    case "user.message": {
      // Echo prompts typed at the laptop terminal so the phone's transcript isn't missing
      // the user side of terminal-driven turns. Skip messages the terminal itself hides
      // (skill-injected `source`) or auto-injected autopilot continuations. Phone-relayed
      // prompts are already shown optimistically on the phone, so only re-broadcast those
      // we can't match to a recent phone injection (i.e. genuinely terminal-typed).
      const text = data.content ?? "";
      if (!text || data.source || data.isAutopilotContinuation) break;
      const origin = promptOrigin?.classify(text) ?? "terminal";
      if (origin === "phone") break;
      await sendSafe(userMessage(text, "terminal", event.id));
      break;
    }
    case "tool.execution_start":
      await sendSafe(activity(true));
      await sendSafe(
        toolStart(data.toolCallId ?? event.id, data.toolName ?? data.name ?? "tool", data.arguments),
      );
      break;
    case "tool.execution_complete":
      await sendSafe(
        toolComplete(
          data.toolCallId ?? event.id,
          data.toolName ?? data.name ?? "tool",
          Boolean(data.success),
          previewToolResult(data),
        ),
      );
      break;
    case "log":
    case "session.log":
      await sendSafe(logLine(data.level ?? "info", data.message ?? data.content ?? ""));
      break;
    case "session.mode_changed":
      await sendSafe(modeChange(data.newMode ?? data.mode));
      break;
  }
}

/** Answer a phone's HISTORY_REQUEST with a page of turns (forward, backward, or latest). */
async function serveHistory(sessionId, msg, sendSafe, logger) {
  try {
    const before = Number.isFinite(msg?.before) ? msg.before : null;
    const since = Number.isFinite(msg?.since) ? msg.since : null;
    const page = await readHistory(sessionId, { before, since, limit: msg?.limit });
    await sendSafe(history(page.items, page.nextCursor, page.hasMore, since));
  } catch (err) {
    logger?.(`Helm history request failed: ${err?.message ?? err}`, { level: "warning" });
    await sendSafe(history([], null, false));
  }
}

/**
 * Answer a phone's STATE_REQUEST with a snapshot of the live session state so a fresh, reconnecting,
 * or MID-TURN join immediately shows the truth (working vs ready, current mode, latest turn cursor)
 * and re-renders any prompts still pending on the terminal — instead of waiting for the next event.
 */
async function serveStateSnapshot({ session, sessionId, approvals, elicitations, sendSafe, logger }) {
  try {
    const [activity, mode, latestTurnIndex] = await Promise.all([
      readSessionActivity(session),
      readCurrentMode(session),
      readLatestTurnIndex(sessionId),
    ]);
    await sendSafe(
      stateSnapshot({
        // A one-shot connect snapshot defaults to idle when the host can't tell us (null).
        busy: activity?.busy ?? false,
        abortable: activity?.abortable ?? false,
        mode,
        latestTurnIndex,
        approvals: approvals?.snapshotPending?.() ?? [],
        elicitations: elicitations?.snapshotPending?.() ?? [],
      }),
    );
  } catch (err) {
    logger?.(`Helm state request failed: ${err?.message ?? err}`, { level: "warning" });
    // An empty snapshot is safe (ready + no pending); the phone falls back to live events.
    await sendSafe(stateSnapshot({}));
  }
}

/**
 * Best-effort read of whether a turn is in flight and whether it can be stopped. Prefers the
 * experimental `metadata.activity()` RPC ({ hasActiveWork, abortable }); falls back to
 * `metadata.isProcessing()`. Returns null when NEITHER is exposed — the caller must treat that
 * as "unknown", not "idle", so a per-beat heartbeat never clears a live Stop control on a host
 * that can't report activity.
 */
async function readSessionActivity(session) {
  const metadata = session?.rpc?.metadata;
  if (metadata && typeof metadata.activity === "function") {
    try {
      const a = await metadata.activity();
      if (a && typeof a === "object") {
        return { busy: Boolean(a.hasActiveWork), abortable: Boolean(a.abortable) };
      }
    } catch {
      // Experimental/absent — fall through to isProcessing.
    }
  }
  if (metadata && typeof metadata.isProcessing === "function") {
    try {
      const p = await metadata.isProcessing();
      const busy = Boolean(p && (typeof p === "object" ? p.isProcessing : p));
      return { busy, abortable: busy };
    } catch {
      // Fall through to unknown.
    }
  }
  return null;
}

/** Best-effort read of the session's current mode from the experimental metadata snapshot. */
async function readCurrentMode(session) {
  try {
    const snap = await session?.rpc?.metadata?.snapshot?.();
    const m = snap?.currentMode;
    const name = typeof m === "string" ? m : (m?.mode ?? m?.name);
    return MODES.includes(name) ? name : null;
  } catch {
    return null;
  }
}

async function applyMode(session, mode, logger, sendSafe) {
  if (!MODES.includes(mode)) {
    logger(`Helm: ignored unsupported mode "${mode}".`, { level: "warning" });
    return;
  }

  if (typeof session.rpc?.mode?.set === "function") {
    try {
      const result = await session.rpc.mode.set({ mode });
      const appliedMode = result?.mode ?? mode;
      logger(`Helm: mode change requested -> ${mode}; applied ${appliedMode}.`, {
        level: "info",
        ephemeral: false,
      });
      await sendSafe(modeChange(appliedMode));
    } catch (err) {
      logger(`Helm: mode change to ${mode} failed: ${err?.message ?? err}`, {
        level: "warning",
        ephemeral: false,
      });
    }
    return;
  }

  logger(`Helm: mode change requested -> ${mode} (best-effort fallback).`, {
    level: "info",
    ephemeral: false,
  });

  if (typeof session.send === "function") {
    await session.send({ prompt: `/${mode}`, mode: "immediate" });
  }
}

// A phone "Stop" maps to the SDK's turn-abort RPC. We probe session.rpc.abort the same
// way applyMode probes session.rpc.mode.set, and surface a notice so the phone gets
// immediate feedback even when the abort emits no further session events.
async function applyInterrupt(session, logger, sendSafe) {
  if (typeof session.rpc?.abort !== "function") {
    logger("Helm: interrupt requested but session.rpc.abort is unavailable.", {
      level: "warning",
      ephemeral: false,
    });
    return;
  }
  try {
    const result = await session.rpc.abort({ reason: "remote_command" });
    if (result && result.success === false) {
      logger(`Helm: interrupt failed: ${result.error ?? "unknown error"}.`, {
        level: "warning",
        ephemeral: false,
      });
      return;
    }
    logger("Helm: generation interrupted from phone.", { level: "info", ephemeral: false });
    await sendSafe(logLine("warning", "■ Generation stopped from your phone."));
  } catch (err) {
    logger(`Helm: interrupt threw: ${err?.message ?? err}`, {
      level: "warning",
      ephemeral: false,
    });
  }
}

function inferToolName(request = {}) {
  return (
    request.toolName ??
    request.name ??
    request.command ??
    request.kind ??
    request.toolCallId ??
    "unknown"
  );
}

function inferToolArgs(request = {}) {
  return request.arguments ?? request.args ?? request.input ?? request;
}

function inferOptions(request = {}) {
  if (Array.isArray(request.options)) return request.options;
  return [
    { id: "approved", label: "Approve" },
    { id: "denied-interactively-by-user", label: "Deny" },
  ];
}

// The Copilot CLI native runtime (>= 1.0.66) requires a permission-request hook to
// resolve to one of these kebab-case decision kinds. The older SDK-style kinds
// ("approved" / "denied-interactively-by-user" / "denied-by-permission-request-hook")
// are rejected by the runtime with: unknown variant `approved`, expected one of
// `approve-once`, `approve-for-session`, `reject`, `user-not-available`.
const NATIVE_DECISION_KINDS = new Set([
  "approve-once",
  "approve-for-session",
  "reject",
  "user-not-available",
]);

function permissionResultFromDecision(msg) {
  // Forward-compat: honor an exact native decision a future phone may send in `raw`.
  if (msg.raw && typeof msg.raw === "object" && NATIVE_DECISION_KINDS.has(msg.raw.kind)) {
    return msg.raw;
  }
  const approved =
    msg.optionId === "approve-once" ||
    msg.optionId === "approved" ||
    msg.optionId === "allow" ||
    msg.optionId === "approve";
  if (approved) return { kind: "approve-once" };
  return {
    kind: "reject",
    feedback: msg.raw?.feedback ?? "Denied from Helm mobile",
  };
}

function previewToolResult(data = {}) {
  const source =
    data.result?.detailedContent ??
    data.result?.content ??
    data.error?.message ??
    data.result ??
    "";
  const text = typeof source === "string" ? source : JSON.stringify(source);
  return text.length > 2_000 ? `${text.slice(0, 2_000)}…` : text;
}

function approvalTimeoutFromEnv() {
  const raw = Number.parseInt(process.env.HELM_APPROVAL_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_APPROVAL_TIMEOUT_MS;
}

function elicitationTimeoutFromEnv() {
  const raw = Number.parseInt(process.env.HELM_ELICITATION_TIMEOUT_MS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ELICITATION_TIMEOUT_MS;
}

/** Shape the phone's response into the SDK's ElicitResult ({ action, content? }). */
function elicitResultFromResponse(msg) {
  const action = msg?.action === "accept" || msg?.action === "decline" ? msg.action : "cancel";
  const result = { action };
  if (action === "accept" && msg?.content && typeof msg.content === "object") {
    result.content = msg.content;
  }
  return result;
}

/**
 * Find the runtime's "answer a pending elicitation" method. The native runtime exposes this as
 * `session.rpc.ui.handlePendingElicitation({ requestId, result }) -> { success }` — NOT the
 * `respondToElicitation(requestId, result)` shown in the stale SDK `.d.ts` (probing that returned
 * nothing, which is exactly what blocked remote ask_user answers). We probe `session.rpc.ui` then
 * `session.ui` defensively, matching helm's pattern for `session.rpc.abort` / `mode.set`.
 * Returns an async `(requestId, result) => boolean` responder (false = another client won the
 * race), or null when the host exposes no handler.
 */
function pickElicitationResponder(session, logger = () => {}) {
  for (const ui of [session?.rpc?.ui, session?.ui]) {
    const fn = ui?.handlePendingElicitation;
    if (typeof fn !== "function") continue;
    return async (requestId, result) => {
      try {
        const outcome = await fn.call(ui, { requestId, result });
        // `{ success: false }` means the terminal (or another device) already answered.
        return outcome?.success !== false;
      } catch (err) {
        logger(`Helm: handlePendingElicitation failed: ${err?.message ?? err}`, { level: "warning" });
        return false;
      }
    };
  }
  return null;
}

/**
 * Best-effort `registerInterest("elicitation.requested")` so the runtime counts this consumer
 * as a listener and routes the prompt to us (SDK long-poll consumers aren't auto-observed).
 * Returns a releaser thunk; a no-op when the host doesn't expose the interest API.
 */
async function registerElicitationInterest(session, logger = () => {}) {
  for (const owner of [session?.rpc, session]) {
    if (typeof owner?.registerInterest !== "function") continue;
    try {
      const result = await owner.registerInterest({ eventType: "elicitation.requested" });
      const handle = result?.handle;
      return () => {
        if (handle == null || typeof owner.releaseInterest !== "function") return;
        try {
          void owner.releaseInterest({ handle });
        } catch {
          // Idempotent per the SDK; ignore release failures.
        }
      };
    } catch (err) {
      logger(`Helm: registerInterest(elicitation.requested) failed; continuing: ${err?.message ?? err}`, {
        level: "info",
      });
      return () => {};
    }
  }
  return () => {};
}

// Resolve the CLI "chat title" (summary) for a session. Prefer the live metadata RPC when the
// host exposes it; otherwise read the CLI's own session store (the same source the session
// picker uses). Best-effort: returns "" on any failure so the phone falls back to the cwd name.
async function fetchTitle(session) {
  try {
    const snap = await session?.rpc?.metadata?.snapshot?.();
    const live = (snap && (snap.summary || snap.initialName)) || "";
    if (live) return live;
  } catch {
    // Metadata RPC is experimental/absent — fall through to the on-disk store.
  }
  return readSummary(session?.sessionId ?? session?.id);
}

function logToSession(session, message, options = {}) {
  try {
    if (typeof session.log === "function") {
      session.log(message, options);
    }
  } catch {
    // Logging must never break the relay.
  }
}

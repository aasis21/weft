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
  sessionStart,
  sessionMeta,
  sessionEnd,
  heartbeat,
  modeChange,
  history,
} from "@aasis21/helm-shared";
import { readSummary, readHistory } from "./store.mjs";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
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

    await channel.send(approvalRequest(requestId, toolName, toolArgs, options));

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

      pending.set(requestId, { resolve, timer, request, invocation });
    });
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

  return { onPermissionRequest, close };
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

  await sendSafe(sessionStart(channelId ?? channel.transport?.channelId, sessionId, cwd, lastTitle));
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      await sendSafe(heartbeat());
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
      session.on((event) => void handleSessionEvent(event, sendSafe, promptOrigin)),
    );
  }

  unsubscribers.push(
    channel.onEvent(EVENTS.PROMPT, (msg) => {
      if (msg?.kind !== KIND.PROMPT || typeof msg.text !== "string") return;
      // Remember this phone-typed prompt so its echoed user.message session event is
      // attributed to the phone (which already shows it optimistically) and not
      // re-broadcast as a terminal message.
      promptOrigin.record(msg.text);
      void session
        .send?.({ prompt: msg.text, mode: "immediate" })
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
      }
    }),
  );

  async function stop(reason = "extension_shutdown", { closeTransport = true } = {}) {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe?.();
    approvals.close?.();
    // On a re-pair we keep the shared transport open for the next phone, so we neither announce a
    // session end (the new phone uses a different key and couldn't read it) nor close the channel.
    if (closeTransport) {
      await sendSafe(sessionEnd(reason));
      await channel.close?.();
    }
  }

  return { stop, onPermissionRequest: approvals.onPermissionRequest };
}

async function handleSessionEvent(event, sendSafe, promptOrigin) {
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

/** Answer a phone's HISTORY_REQUEST with a page of older turns from the CLI store. */
async function serveHistory(sessionId, msg, sendSafe, logger) {
  try {
    const before = Number.isFinite(msg?.before) ? msg.before : null;
    const page = await readHistory(sessionId, { before, limit: msg?.limit });
    await sendSafe(history(page.items, page.nextCursor, page.hasMore));
  } catch (err) {
    logger?.(`Helm history request failed: ${err?.message ?? err}`, { level: "warning" });
    await sendSafe(history([], null, false));
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

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
  approvalRequest,
  sessionStart,
  sessionEnd,
  heartbeat,
  modeChange,
} from "@aasis21/helm-shared";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
const DEFAULT_HEARTBEAT_MS = 15_000;

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
          kind: "denied-by-permission-request-hook",
          message: "Helm approval timed out",
          interrupt: false,
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
        kind: "denied-by-permission-request-hook",
        message: "Helm relay stopped before approval decision",
        interrupt: false,
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
  const logger = (message, options = {}) => logToSession(session, message, options);
  const approvals =
    permissionRelay ??
    createPermissionRelay({ channel, approvalTimeoutMs, logger });
  const unsubscribers = [];
  let stopped = false;

  const sendSafe = async (msg) => {
    try {
      await channel.send(msg);
    } catch (err) {
      logger(`Helm relay send failed: ${err?.message ?? err}`, { level: "warning" });
    }
  };

  await sendSafe(sessionStart(channelId ?? channel.transport?.channelId, sessionId, cwd));
  const heartbeatTimer = setInterval(() => {
    void sendSafe(heartbeat());
  }, heartbeatMs);
  heartbeatTimer.unref?.();

  if (typeof session.on === "function") {
    unsubscribers.push(session.on((event) => void handleSessionEvent(event, sendSafe)));
  }

  unsubscribers.push(
    channel.onEvent(EVENTS.PROMPT, (msg) => {
      if (msg?.kind !== KIND.PROMPT || typeof msg.text !== "string") return;
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
      if (msg?.kind !== KIND.MODE) return;
      void applyMode(session, msg.mode, logger, sendSafe);
    }),
  );

  async function stop(reason = "extension_shutdown") {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeatTimer);
    for (const unsubscribe of unsubscribers.splice(0)) unsubscribe?.();
    approvals.close?.();
    await sendSafe(sessionEnd(reason));
    await channel.close?.();
  }

  return { stop, onPermissionRequest: approvals.onPermissionRequest };
}

async function handleSessionEvent(event, sendSafe) {
  if (!event?.type) return;
  const data = event.data ?? {};
  switch (event.type) {
    case "assistant.message":
      await sendSafe(assistantMessage(data.content ?? "", data.messageId ?? event.id));
      break;
    case "assistant.message_delta":
      await sendSafe(assistantDelta(data.deltaContent ?? "", data.messageId ?? event.id));
      break;
    case "tool.execution_start":
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

function permissionResultFromDecision(msg) {
  if (msg.raw && typeof msg.raw === "object" && typeof msg.raw.kind === "string") {
    return msg.raw;
  }
  if (msg.optionId === "approved" || msg.optionId === "allow" || msg.optionId === "approve") {
    return { kind: "approved" };
  }
  return {
    kind: "denied-interactively-by-user",
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

function logToSession(session, message, options = {}) {
  try {
    if (typeof session.log === "function") {
      session.log(message, options);
    }
  } catch {
    // Logging must never break the relay.
  }
}

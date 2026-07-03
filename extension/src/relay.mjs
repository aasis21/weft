import { randomUUID } from "node:crypto";
import {
  EVENT_TYPE,
  SUBTYPE,
  MODES,
  RECENT_TURNS_DEFAULT,
  assistantMessage,
  assistantDelta,
  toolStart,
  toolComplete,
  logLine,
  activity,
  userMessage,
  approvalRequest,
  approvalComplete,
  elicitationRequest,
  elicitationComplete,
  channelUp,
  sessionMeta,
  channelDown,
  heartbeat,
  modeChange,
  history,
  recentTurns,
  stateSnapshot,
} from "@aasis21/helm-shared";
import { readSummary, readHistory, readLatestTurnIndex } from "./store.mjs";
import { createRecentTurns } from "./recentTurns.mjs";

const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;
// ask_user forms take longer to fill in than a one-tap approval, so allow more slack before
// the fail-safe cancel fires (a cancel is a no-op if the terminal already answered).
const DEFAULT_ELICITATION_TIMEOUT_MS = 300_000;
const DEFAULT_HEARTBEAT_MS = 15_000;
const SEND_FAILURE_RECONNECT_THRESHOLD = 6;
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
  let loggedShellApprovalShape = false;

  const unsubscribe = channel.onEvent(EVENT_TYPE.DECISION, (msg) => {
    if (msg?.eventSubtype !== SUBTYPE.DECISION.APPROVAL_DECISION) return;
    const decision = msg.msg;
    const entry = pending.get(decision.requestId);
    if (!entry) return;
    pending.delete(decision.requestId);
    clearTimeout(entry.timer);
    entry.resolve(permissionResultFromDecision(decision));
    // Echo a completion so any OTHER device still showing this banner dismisses it too.
    void channel.send(approvalComplete(decision.requestId, decision.optionId)).catch(() => {});
  });

  async function onPermissionRequest(request, invocation = {}) {
    const requestId = randomUUID();
    const toolName = inferToolName(request);
    if (!loggedShellApprovalShape && isShellToolName(toolName)) {
      loggedShellApprovalShape = true;
      logger(`Helm debug: shell approval request shape ${safeJson({ request, invocation })}`, {
        level: "info",
        ephemeral: false,
      });
    }
    const toolArgs = inferToolArgs(request, invocation);
    const options = inferOptions(request);
    const expiresAt = Date.now() + approvalTimeoutMs;
    // Keep the exact payload we sent so a late-joining phone can have it replayed verbatim
    // in a state snapshot (same requestId → its decision still resolves this pending entry).
    const payload = approvalRequest(requestId, toolName, toolArgs, options, {
      timeoutMs: approvalTimeoutMs,
      expiresAt,
    });

    await channel.send(payload);

    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        logger(
          `Helm: approval request timed out after ${approvalTimeoutMs}ms; denying ${toolName}.`,
          { level: "warning", ephemeral: false },
        );
        // Tell the phone the request is gone so its banner doesn't linger as a zombie (#78).
        void channel.send(approvalComplete(requestId, "timeout")).catch(() => {});
        resolve({
          kind: "reject",
          feedback: "Helm approval timed out",
        });
      }, approvalTimeoutMs);

      pending.set(requestId, { resolve, timer, request, invocation, payload });
    });
  }

  /** The still-pending approval prompts, as flat approvalRequest PAYLOADS (msg), so a phone
   *  that (re)connects mid-request can render them from a state snapshot. */
  function snapshotPending() {
    return [...pending.values()].map((entry) => entry.payload?.msg).filter(Boolean);
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

  const unsubscribe = channel.onEvent(EVENT_TYPE.ELICITATION_RESPONSE, (msg) => {
    if (msg?.eventSubtype !== SUBTYPE.ELICITATION_RESPONSE.RESPONSE) return;
    const answer = msg.msg;
    const entry = pending.get(answer.requestId);
    if (!entry) return; // already resolved at the terminal, or timed out
    clearPending(answer.requestId);
    if (!respond) {
      logger(
        "Helm: this CLI build can't accept remote ask_user answers (handlePendingElicitation unavailable).",
        { level: "warning", ephemeral: false },
      );
      return;
    }
    // Feed the phone's answer back into the runtime. success === false means another client
    // (typically the terminal) already answered — harmless, the phone form is already dismissed.
    void Promise.resolve(respond(answer.requestId, elicitResultFromResponse(answer))).then((accepted) => {
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

  /** The still-open ask_user prompts, as flat elicitationRequest PAYLOADS (msg), so a phone
   *  that (re)connects mid-prompt can render them from a state snapshot. */
  function snapshotPending() {
    return [...pending.values()].map((entry) => entry.payload?.msg).filter(Boolean);
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

/**
 * Relays the SDK's separate `exit_plan_mode.requested` event to the phone using Helm's
 * existing approval envelope, then answers through the runtime UI RPC.
 */
export function createExitPlanModeRelay({
  session,
  channel,
  approvalTimeoutMs = approvalTimeoutFromEnv(),
  logger = () => {},
} = {}) {
  if (!channel) throw new Error("helm relay: channel is required");
  const pending = new Map();
  const respond = pickExitPlanModeResponder(session, logger);
  let releaseInterest = () => {};

  void registerInterestForEvent(session, "exit_plan_mode.requested", logger).then((release) => {
    releaseInterest = release;
  });

  const unsubscribe = channel.onEvent(EVENT_TYPE.DECISION, (msg) => {
    if (msg?.eventSubtype !== SUBTYPE.DECISION.APPROVAL_DECISION) return;
    const decision = msg.msg;
    const entry = pending.get(decision.requestId);
    if (!entry) return;
    clearPending(decision.requestId);
    void channel.send(approvalComplete(decision.requestId, decision.optionId)).catch(() => {});
    if (!respond) {
      logger(
        "Helm: this CLI build can't accept remote plan-exit answers (handlePendingExitPlanMode unavailable).",
        { level: "warning", ephemeral: false },
      );
      return;
    }
    void Promise.resolve(respond(decision.requestId, exitPlanResponseFromOption(decision.optionId))).then(
      (accepted) => {
        if (accepted === false) {
          logger("Helm: plan-exit request was already answered before the phone's reply arrived.", {
            level: "info",
          });
        }
      },
    );
  });

  async function offer(data = {}) {
    const requestId = data.requestId;
    if (!requestId) return;
    const options = exitPlanOptions(data);
    const expiresAt = Date.now() + approvalTimeoutMs;
    const payload = approvalRequest(
      requestId,
      "Exit Plan Mode",
      {
        summary: data.summary ?? "",
        ...(typeof data.planContent === "string" && data.planContent ? { planContent: data.planContent } : {}),
      },
      options,
      { timeoutMs: approvalTimeoutMs, expiresAt },
    );
    await channel.send(payload);
    const timer = setTimeout(() => {
      clearPending(requestId);
      respond?.(requestId, { approved: false, feedback: "Helm plan-exit approval timed out" });
      void channel.send(approvalComplete(requestId, "timeout")).catch(() => {});
      logger(`Helm: plan-exit request unanswered after ${approvalTimeoutMs}ms; declined.`, {
        level: "warning",
        ephemeral: false,
      });
    }, approvalTimeoutMs);
    timer.unref?.();
    pending.set(requestId, { timer, payload });
  }

  async function complete(data = {}) {
    const requestId = data.requestId;
    if (!requestId) return;
    clearPending(requestId);
    await channel.send(approvalComplete(requestId, data.selectedAction ?? (data.approved ? "approved" : "rejected")));
  }

  function snapshotPending() {
    return [...pending.values()].map((entry) => entry.payload?.msg).filter(Boolean);
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
  onConnectionLost,
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
  const exitPlans = createExitPlanModeRelay({ session, channel, approvalTimeoutMs, logger });
  // In-memory recent-turns buffer: captures FULL assistant text live (the CLI store drops it for
  // long/multi-tool turns), so a connecting phone can backfill recent turns at full fidelity. Seeded
  // best-effort from the store so turns from before this extension started still show.
  const turnBuffer = createRecentTurns();
  try {
    const seedPage = await readHistory(sessionId, { limit: RECENT_TURNS_DEFAULT });
    turnBuffer.seed(seedPage.items);
  } catch {
    // Seeding is best-effort; the buffer still fills from the live stream.
  }
  const unsubscribers = [];
  let stopped = false;
  let consecutiveSendFailures = 0;
  let connectionLostNotified = false;
  // Correlates phone-relayed prompts with their echoed user.message events so the relay
  // only re-broadcasts prompts that were actually typed at the laptop terminal.
  const promptOrigin = createPromptOriginTracker();
  const relayActivity = {
    idleReaffirmPending: false,
    activityUnknownLogged: false,
  };

  const sendSafe = async (msg) => {
    try {
      await channel.send(msg);
      consecutiveSendFailures = 0;
      connectionLostNotified = false;
    } catch (err) {
      consecutiveSendFailures += 1;
      if (
        consecutiveSendFailures >= SEND_FAILURE_RECONNECT_THRESHOLD &&
        !connectionLostNotified &&
        !stopped
      ) {
        connectionLostNotified = true;
        onConnectionLost?.(err);
      }
    }
  };

  await sendSafe(channelUp(cwd, lastTitle));
  const heartbeatTimer = setInterval(() => {
    void (async () => {
      // Carry the store's latest turn_index so a connected phone keeps a fresh forward cursor
      // (readLatestTurnIndex is best-effort and returns null on any read failure), plus the
      // authoritative busy flag so a dropped assistant.idle self-corrects within one beat.
      const [latestTurnIndex, activity] = await Promise.all([
        readLatestTurnIndex(sessionId),
        readSessionActivity(session),
      ]);
      if (!activity && !relayActivity.activityUnknownLogged) {
        relayActivity.activityUnknownLogged = true;
        logger("Helm: session activity RPC unavailable; heartbeat busy state is unknown.", {
          level: "info",
        });
      }
      const busy = relayActivity.idleReaffirmPending ? false : (activity ? activity.busy : null);
      await sendSafe(heartbeat(latestTurnIndex, busy));
      relayActivity.idleReaffirmPending = false;
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
      session.on((event) =>
        void handleSessionEvent(event, sendSafe, promptOrigin, elicitations, exitPlans, turnBuffer, relayActivity),
      ),
    );
  }

  unsubscribers.push(
    channel.onEvent(EVENT_TYPE.PROMPT, (msg) => {
      if (msg?.eventSubtype !== SUBTYPE.PROMPT.PROMPT || typeof msg.msg?.text !== "string") return;
      const body = msg.msg;
      // Remember this phone-typed prompt so its echoed user.message session event is
      // attributed to the phone (which already shows it optimistically) and not
      // re-broadcast as a terminal message.
      promptOrigin.record(body.text);
      // Map phone-relayed image attachments (base64) to Copilot SDK blob attachments.
      // Defensive: drop anything missing base64 `data` or a `mimeType`. The SDK resizes
      // images itself; the phone already downscales to keep the relay payload small.
      const attachments = Array.isArray(body.attachments)
        ? body.attachments
            .filter((a) => a && typeof a.data === "string" && a.data && typeof a.mimeType === "string" && a.mimeType)
            .map((a) => ({
              type: "blob",
              data: a.data,
              mimeType: a.mimeType,
              displayName: typeof a.name === "string" && a.name ? a.name : "image",
            }))
        : [];
      const sendOptions = attachments.length
        ? { prompt: body.text, attachments, mode: "immediate" }
        : { prompt: body.text, mode: "immediate" };
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
    channel.onEvent(EVENT_TYPE.CONTROL, (msg) => {
      if (msg?.eventSubtype === SUBTYPE.CONTROL.MODE) {
        void applyMode(session, msg.msg?.mode, logger, sendSafe);
        return;
      }
      if (msg?.eventSubtype === SUBTYPE.CONTROL.INTERRUPT) {
        void applyInterrupt(session, logger, sendSafe);
        return;
      }
      if (msg?.eventSubtype === SUBTYPE.CONTROL.HISTORY_REQUEST) {
        void serveHistory(sessionId, msg.msg, sendSafe, logger);
        return;
      }
      if (msg?.eventSubtype === SUBTYPE.CONTROL.RECENT_TURNS_REQUEST) {
        void serveRecentTurns(turnBuffer, msg.msg, sendSafe, logger);
        return;
      }
      if (msg?.eventSubtype === SUBTYPE.CONTROL.STATE_REQUEST) {
        void serveStateSnapshot({ session, sessionId, approvals, elicitations, exitPlans, sendSafe, logger });
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
    exitPlans.close?.();
    // On a re-pair we keep the shared transport open for the next phone, so we neither announce a
    // session end (the new phone uses a different key and couldn't read it) nor close the channel.
    if (closeTransport) {
      await sendSafe(channelDown(reason));
      await channel.close?.();
    }
  }

  return { stop, onPermissionRequest: approvals.onPermissionRequest };
}

async function handleSessionEvent(event, sendSafe, promptOrigin, elicitations, exitPlans, turnBuffer, relayActivity) {
  if (!event?.type) return;
  const data = event.data ?? {};
  switch (event.type) {
    case "assistant.message_start":
      if (relayActivity) relayActivity.idleReaffirmPending = false;
      // A turn is now in flight (text/reasoning) — tell the phone so its Stop control
      // appears for the whole abortable turn, not only while a tool runs.
      await sendSafe(activity(true));
      break;
    case "assistant.idle":
      // The agent's processing loop went idle: the turn is over, nothing left to abort.
      await sendSafe(activity(false));
      if (relayActivity) relayActivity.idleReaffirmPending = true;
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
    case "exit_plan_mode.requested":
      // Plan-exit approval is not a permission hook; the SDK emits a distinct event.
      if (exitPlans) await exitPlans.offer(data);
      break;
    case "exit_plan_mode.completed":
      // Answered here, at the terminal, or on another device — dismiss the phone banner.
      if (exitPlans) await exitPlans.complete(data);
      break;
    case "assistant.message":
      turnBuffer?.recordAssistant(data.content ?? "", event.ts ?? Date.now(), data.messageId ?? event.id);
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
      // Record the user side of EVERY real turn (both origins) so the phone can backfill it; the
      // phone dedups its own optimistic prompts by content. Do this BEFORE classify(), which
      // consumes the phone-prompt match used only for the terminal-echo decision below.
      turnBuffer?.recordUser(text, event.ts ?? Date.now(), event.id);
      const origin = promptOrigin?.classify(text) ?? "terminal";
      if (origin === "phone") break;
      await sendSafe(userMessage(text, "terminal", event.id));
      break;
    }
    case "tool.execution_start":
      if (relayActivity) relayActivity.idleReaffirmPending = false;
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

/** Answer a phone's HISTORY_REQUEST with a page of turns (forward, backward, or latest). `req` is
 *  the flat history_request payload (msg). */
async function serveHistory(sessionId, req, sendSafe, logger) {
  try {
    const before = Number.isFinite(req?.before) ? req.before : null;
    const since = Number.isFinite(req?.since) ? req.since : null;
    const page = await readHistory(sessionId, { before, since, limit: req?.limit });
    await sendSafe(history(page.items, page.nextCursor, page.hasMore, since));
  } catch (err) {
    logger?.(`Helm history request failed: ${err?.message ?? err}`, { level: "warning" });
    await sendSafe(history([], null, false));
  }
}

/** Answer a phone's RECENT_TURNS_REQUEST with the in-memory buffer's last `limit` turns (full
 *  assistant text). Self-contained snapshot — the phone merges it into the transcript tail. */
async function serveRecentTurns(turnBuffer, req, sendSafe, logger) {
  try {
    const items = turnBuffer?.snapshot?.(req?.limit) ?? [];
    await sendSafe(recentTurns(items));
  } catch (err) {
    logger?.(`Helm recent-turns request failed: ${err?.message ?? err}`, { level: "warning" });
    await sendSafe(recentTurns([]));
  }
}

/**
 * Answer a phone's STATE_REQUEST with a snapshot of the live session state so a fresh, reconnecting,
 * or MID-TURN join immediately shows the truth (working vs ready, current mode, latest turn cursor)
 * and re-renders any prompts still pending on the terminal — instead of waiting for the next event.
 */
async function serveStateSnapshot({ session, sessionId, approvals, elicitations, exitPlans, sendSafe, logger }) {
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
        approvals: [
          ...(approvals?.snapshotPending?.() ?? []),
          ...(exitPlans?.snapshotPending?.() ?? []),
        ],
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

function inferToolArgs(request = {}, invocation = {}) {
  const candidates = [
    request.arguments,
    request.args,
    request.toolInput,
    request.parameters,
    request.params,
    request.input,
    invocation?.toolInput,
    invocation?.arguments,
    invocation?.args,
    invocation?.parameters,
    invocation?.params,
    invocation?.input,
  ];
  if (isShellToolName(inferToolName(request))) {
    for (const candidate of [...candidates, request, invocation]) {
      const command = findShellCommand(candidate);
      if (command) return { command };
    }
  }
  for (const candidate of candidates) {
    if (candidate != null) return candidate;
  }
  return request;
}

function isShellToolName(toolName) {
  return /(?:^|[_\-\s])(shell|bash|powershell|pwsh|terminal|command)(?:$|[_\-\s])/i.test(String(toolName ?? ""));
}

function findShellCommand(value, depth = 0, seen = new Set()) {
  if (value == null || depth > 4) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  for (const key of ["command", "cmd", "script"]) {
    const command = value[key];
    if (typeof command === "string" && command.trim()) return command.trim();
  }
  for (const key of ["toolInput", "arguments", "args", "parameters", "params", "input", "request", "invocation"]) {
    const command = findShellCommand(value[key], depth + 1, seen);
    if (command) return command;
  }
  return null;
}

function inferOptions(request = {}) {
  if (Array.isArray(request.options)) return request.options;
  return [
    { id: "approved", label: "Approve" },
    { id: "denied-interactively-by-user", label: "Deny" },
  ];
}

const EXIT_PLAN_DEFAULT_ACTIONS = ["exit_only", "autopilot"];
const EXIT_PLAN_REVISE_OPTION = "suggest_changes";

function exitPlanOptions(data = {}) {
  const actions = Array.isArray(data.actions) && data.actions.length ? data.actions : EXIT_PLAN_DEFAULT_ACTIONS;
  const options = [];
  const seen = new Set();
  for (const action of actions) {
    if (typeof action !== "string" || seen.has(action)) continue;
    seen.add(action);
    options.push({
      id: action,
      label: labelExitPlanAction(action),
      recommended: action === data.recommendedAction,
    });
  }
  if (!seen.has(EXIT_PLAN_REVISE_OPTION)) {
    options.push({ id: EXIT_PLAN_REVISE_OPTION, label: "Suggest changes", recommended: false });
  }
  return options;
}

function labelExitPlanAction(action) {
  switch (action) {
    case "exit_only":
      return "Exit plan mode";
    case "interactive":
    case "autopilot":
      return "Accept plan and build";
    case "autopilot_fleet":
      return "Accept plan, build, and start fleet";
    default:
      return action.replace(/_/g, " ");
  }
}

function exitPlanResponseFromOption(optionId) {
  if (optionId === EXIT_PLAN_REVISE_OPTION) {
    return { approved: false, feedback: "Please revise the plan." };
  }
  const selectedAction = typeof optionId === "string" ? optionId : "interactive";
  return {
    approved: true,
    selectedAction,
    autoApproveEdits: selectedAction === "autopilot" || selectedAction === "autopilot_fleet",
  };
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

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "[unserializable]";
  }
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

function pickExitPlanModeResponder(session, logger = () => {}) {
  for (const ui of [session?.rpc?.ui, session?.ui]) {
    const fn = ui?.handlePendingExitPlanMode;
    if (typeof fn !== "function") continue;
    return async (requestId, response) => {
      try {
        const outcome = await fn.call(ui, { requestId, response });
        return outcome?.success !== false;
      } catch (err) {
        logger(`Helm: handlePendingExitPlanMode failed: ${err?.message ?? err}`, { level: "warning" });
        return false;
      }
    };
  }
  for (const owner of [session, session?.rpc]) {
    const fn = owner?.respondToExitPlanMode;
    if (typeof fn !== "function") continue;
    return async (requestId, response) => {
      try {
        return (await fn.call(owner, requestId, response)) !== false;
      } catch (err) {
        logger(`Helm: respondToExitPlanMode failed: ${err?.message ?? err}`, { level: "warning" });
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
  return registerInterestForEvent(session, "elicitation.requested", logger);
}

async function registerInterestForEvent(session, eventType, logger = () => {}) {
  for (const owner of [session?.rpc, session]) {
    if (typeof owner?.registerInterest !== "function") continue;
    try {
      const result = await owner.registerInterest({ eventType });
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
      logger(`Helm: registerInterest(${eventType}) failed; continuing: ${err?.message ?? err}`, {
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

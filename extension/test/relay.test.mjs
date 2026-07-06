// SPDX-License-Identifier: Apache-2.0
// Tests for the relay's new behaviors: phone/terminal prompt-origin correlation,
// terminal user.message echoing, and serving history requests. The pure tracker is
// tested directly; the wiring is tested via lightweight fake session/channel objects.
//
// Everything on the wire is the standardized event envelope: messages are routed by
// (eventType, eventSubtype) and their payload lives under `msg`. The fakes therefore emit
// factory-built envelopes and assert on `m.eventSubtype` + `m.msg.*`.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_TYPE,
  SUBTYPE,
  prompt,
  historyRequest,
  stateRequest,
  interrupt,
  voiceMode,
  elicitationResponse,
  approvalDecision,
} from "@aasis21/weft-shared";
import {
  attachRelay,
  createElicitationRelay,
  createExitPlanModeRelay,
  createPermissionRelay,
  createPromptOriginTracker,
} from "../src/relay.mjs";

const flush = () => new Promise((r) => setTimeout(r, 15));

function makeFakeChannel() {
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    transport: { channelId: "chan-1" },
    async connect() {},
    async send(msg) {
      sent.push(msg);
    },
    async close() {},
    onEvent(event, fn) {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(fn);
      return () => handlers.get(event)?.delete(fn);
    },
    emit(event, msg) {
      for (const fn of handlers.get(event) ?? []) fn(msg);
    },
  };
}

function makeFailingChannel({ failUntil = Infinity } = {}) {
  const channel = makeFakeChannel();
  let attempts = 0;
  channel.attempts = () => attempts;
  channel.send = async (msg) => {
    attempts += 1;
    if (attempts <= failUntil) throw new Error(`send failed ${attempts}`);
    channel.sent.push(msg);
  };
  return channel;
}

function makeFakeSession(sessionId = "unknown-session") {
  let handler = null;
  const prompts = [];
  const abortCalls = [];
  const elicitationResponses = [];
  const exitPlanResponses = [];
  const interestCalls = [];
  return {
    sessionId,
    cwd: "/repo",
    prompts,
    abortCalls,
    elicitationResponses,
    exitPlanResponses,
    interestCalls,
    rpc: {
      async abort(params) {
        abortCalls.push(params);
        return { success: true };
      },
      ui: {
        // The real runtime answers a pending elicitation here (not respondToElicitation).
        async handlePendingElicitation({ requestId, result }) {
          elicitationResponses.push({ requestId, result });
          return { success: true };
        },
        async handlePendingExitPlanMode({ requestId, response }) {
          exitPlanResponses.push({ requestId, response });
          return { success: true };
        },
      },
      async registerInterest(params) {
        interestCalls.push(params);
        return { handle: `handle-${interestCalls.length}` };
      },
      async releaseInterest() {},
    },
    on(fn) {
      handler = fn;
      return () => {
        handler = null;
      };
    },
    async send(payload) {
      prompts.push(payload);
    },
    emitEvent(event) {
      handler?.(event);
    },
  };
}

async function withRelay(run) {
  const channel = makeFakeChannel();
  const session = makeFakeSession();
  const relay = await attachRelay({
    session,
    channel,
    channelId: "chan-1",
    heartbeatMs: 10_000_000,
  });
  try {
    await run({ channel, session });
  } finally {
    await relay.stop("test", { closeTransport: false });
  }
}

test("relays exit_plan_mode.requested as a three-option approval and answers via the UI RPC", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession();
  const relay = createExitPlanModeRelay({ session, channel, approvalTimeoutMs: 10_000_000 });
  try {
    await relay.offer({
      requestId: "plan-1",
      summary: "Implement the approved plan.",
      actions: ["exit_only", "autopilot"],
      recommendedAction: "autopilot",
    });
    const req = channel.sent.find(
      (m) => m.eventType === EVENT_TYPE.APPROVAL && m.eventSubtype === SUBTYPE.APPROVAL.REQUEST,
    );
    assert.ok(req, "expected a plan-exit approval request to be sent to the phone");
    assert.equal(req.msg.toolName, "Exit Plan Mode");
    assert.deepEqual(
      req.msg.options.map((o) => ({ id: o.id, label: o.label, recommended: o.recommended })),
      [
        { id: "exit_only", label: "Exit plan mode", recommended: false },
        { id: "autopilot", label: "Accept plan and build", recommended: true },
        { id: "suggest_changes", label: "Suggest changes", recommended: false },
      ],
    );

    channel.emit(EVENT_TYPE.DECISION, approvalDecision("plan-1", "autopilot"));
    await flush();
    assert.deepEqual(session.exitPlanResponses, [
      {
        requestId: "plan-1",
        response: { approved: true, selectedAction: "autopilot", autoApproveEdits: true },
      },
    ]);
  } finally {
    relay.close();
  }
});

test("attachRelay forwards exit_plan_mode events into the approval timeline", async () => {
  await withRelay(async ({ channel, session }) => {
    session.emitEvent({
      type: "exit_plan_mode.requested",
      id: "plan-event",
      data: {
        requestId: "plan-2",
        summary: "Ready",
        actions: ["exit_only", "autopilot"],
        recommendedAction: "autopilot",
      },
    });
    await flush();
    const req = channel.sent.find(
      (m) => m.eventType === EVENT_TYPE.APPROVAL && m.eventSubtype === SUBTYPE.APPROVAL.REQUEST,
    );
    assert.ok(req, "expected exit_plan_mode.requested to relay as an approval");
    assert.equal(req.msg.options.length, 3);
  });
});

// ---- pure tracker ----------------------------------------------------------

test("createPromptOriginTracker: unseen text is terminal, recorded text is phone (once)", () => {
  const t = createPromptOriginTracker({ now: () => 1000 });
  assert.equal(t.classify("never typed here"), "terminal");
  t.record("run the tests");
  assert.equal(t.size, 1);
  assert.equal(t.classify("run the tests"), "phone");
  // The match is consumed, so a later identical (terminal) prompt is not mis-attributed.
  assert.equal(t.classify("run the tests"), "terminal");
  assert.equal(t.size, 0);
});

test("createPromptOriginTracker: matches expire after the window", () => {
  let nowMs = 1000;
  const t = createPromptOriginTracker({ windowMs: 5000, now: () => nowMs });
  t.record("deploy please");
  nowMs = 1000 + 5001; // advance past the window
  assert.equal(t.classify("deploy please"), "terminal");
  assert.equal(t.size, 0);
});

test("createPromptOriginTracker: ignores non-string input", () => {
  const t = createPromptOriginTracker();
  t.record(undefined);
  t.record(42);
  assert.equal(t.size, 0);
});

// ---- relay wiring ----------------------------------------------------------

test("relays a terminal-typed user.message to the phone as origin=terminal", async () => {
  await withRelay(async ({ channel, session }) => {
    session.emitEvent({ type: "user.message", id: "e1", data: { content: "typed at laptop" } });
    await flush();
    const echo = channel.sent.find((m) => m.eventSubtype === SUBTYPE.STREAM.USER_MESSAGE);
    assert.ok(echo, "expected a user_message echo");
    assert.equal(echo.msg.text, "typed at laptop");
    assert.equal(echo.msg.origin, "terminal");
    assert.equal(echo.msg.id, "e1");
  });
});

test("does NOT re-broadcast a phone-relayed prompt's echoed user.message", async () => {
  await withRelay(async ({ channel, session }) => {
    // Phone sends a prompt; the relay records it and forwards into the session.
    channel.emit(EVENT_TYPE.PROMPT, prompt("from my phone"));
    await flush();
    assert.deepEqual(session.prompts.at(-1), { prompt: "from my phone", mode: "immediate" });

    // The session then echoes it back as a user.message — must NOT be re-broadcast.
    session.emitEvent({ type: "user.message", id: "e2", data: { content: "from my phone" } });
    await flush();
    const echoes = channel.sent.filter(
      (m) => m.eventSubtype === SUBTYPE.STREAM.USER_MESSAGE && m.msg.text === "from my phone"
    );
    assert.equal(echoes.length, 0);
  });
});

test("voice mode prefixes relayed prompts with a spoken-response directive, and stops when off", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.PROMPT, prompt("hello there"));
    await flush();
    assert.equal(session.prompts.at(-1).prompt, "hello there");

    channel.emit(EVENT_TYPE.CONTROL, voiceMode(true));
    await flush();
    channel.emit(EVENT_TYPE.PROMPT, prompt("what changed"));
    await flush();
    const spoken = session.prompts.at(-1).prompt;
    assert.match(spoken, /^\[Voice Mode is on/, "prompt is prefixed while voice mode is on");
    assert.ok(spoken.endsWith("what changed"), "the user's text is preserved after the directive");

    channel.emit(EVENT_TYPE.CONTROL, voiceMode(false));
    await flush();
    channel.emit(EVENT_TYPE.PROMPT, prompt("done now"));
    await flush();
    assert.equal(session.prompts.at(-1).prompt, "done now");
  });
});

test("skips skill-injected (source) and autopilot-continuation user messages", async () => {
  await withRelay(async ({ channel, session }) => {
    session.emitEvent({
      type: "user.message",
      id: "e3",
      data: { content: "hidden skill prompt", source: "skill-pdf" },
    });
    session.emitEvent({
      type: "user.message",
      id: "e4",
      data: { content: "auto continue", isAutopilotContinuation: true },
    });
    await flush();
    assert.equal(
      channel.sent.filter((m) => m.eventSubtype === SUBTYPE.STREAM.USER_MESSAGE).length,
      0,
    );
  });
});

test("answers a HISTORY_REQUEST with a control.history message", async () => {
  await withRelay(async ({ channel }) => {
    channel.emit(EVENT_TYPE.CONTROL, historyRequest(null, 50));
    await flush();
    const hist = channel.sent.find((m) => m.eventSubtype === SUBTYPE.CONTROL.HISTORY);
    assert.ok(hist, "expected a control.history response");
    // Unknown session id → empty page, but the shape must be correct.
    assert.deepEqual(hist.msg.items, []);
    assert.equal(hist.msg.nextCursor, null);
    assert.equal(hist.msg.hasMore, false);
    // A latest/backward request carries no forward cursor to echo.
    assert.equal(hist.msg.since, null);
  });
});

test("echoes the forward `since` cursor on a catch-up HISTORY_REQUEST", async () => {
  await withRelay(async ({ channel }) => {
    channel.emit(EVENT_TYPE.CONTROL, historyRequest(null, 50, 12));
    await flush();
    const hist = channel.sent.find((m) => m.eventSubtype === SUBTYPE.CONTROL.HISTORY);
    assert.ok(hist, "expected a control.history response");
    // The echo lets the phone route this page to forward catch-up (append) vs scrollback.
    assert.equal(hist.msg.since, 12);
  });
});

// ---- state snapshot (unified sync: connect-time truth) ----------------------
// On (re)connect / refresh / resume the phone sends a STATE_REQUEST; the ext replies with a
// state_snapshot so a fresh or MID-TURN join immediately shows working-vs-ready, the mode, and
// any prompts still pending at the terminal — instead of waiting for the next live event.

test("answers a STATE_REQUEST with a control.state_snapshot (safe idle defaults)", async () => {
  await withRelay(async ({ channel }) => {
    channel.emit(EVENT_TYPE.CONTROL, stateRequest());
    await flush();
    const snap = channel.sent.find((m) => m.eventSubtype === SUBTYPE.CONTROL.STATE_SNAPSHOT);
    assert.ok(snap, "expected a control.state_snapshot response");
    // The fake session exposes no metadata RPC → idle defaults, no pending prompts.
    assert.equal(snap.msg.busy, false);
    assert.equal(snap.msg.abortable, false);
    assert.equal(snap.msg.mode, null);
    assert.deepEqual(snap.msg.approvals, []);
    assert.deepEqual(snap.msg.elicitations, []);
  });
});

test("a STATE_REQUEST replays a still-open ask_user prompt to a late-joining phone", async () => {
  await withRelay(async ({ channel, session }) => {
    session.emitEvent({
      type: "elicitation.requested",
      id: "elX",
      data: {
        requestId: "req-late",
        message: "Still deciding?",
        mode: "form",
        requestedSchema: { type: "object", properties: {} },
      },
    });
    await flush();
    channel.emit(EVENT_TYPE.CONTROL, stateRequest());
    await flush();
    const snap = channel.sent
      .filter((m) => m.eventSubtype === SUBTYPE.CONTROL.STATE_SNAPSHOT)
      .at(-1);
    assert.ok(snap, "expected a state snapshot");
    // Pending prompts are carried as FLAT payloads (msg), so the phone reuses its renderers.
    assert.equal(snap.msg.elicitations.length, 1);
    assert.equal(snap.msg.elicitations[0].requestId, "req-late");
    assert.equal(snap.msg.elicitations[0].message, "Still deciding?");
  });
});

test("a STATE_REQUEST reflects busy/mode from the session metadata RPC when present", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession();
  session.rpc.metadata = {
    async activity() {
      return { hasActiveWork: true, abortable: true };
    },
    async snapshot() {
      return { currentMode: "plan" };
    },
  };
  const relay = await attachRelay({ session, channel, channelId: "chan-1", heartbeatMs: 10_000_000 });
  try {
    channel.emit(EVENT_TYPE.CONTROL, stateRequest());
    await flush();
    const snap = channel.sent.find((m) => m.eventSubtype === SUBTYPE.CONTROL.STATE_SNAPSHOT);
    assert.ok(snap, "expected a state snapshot");
    assert.equal(snap.msg.busy, true);
    assert.equal(snap.msg.abortable, true);
    assert.equal(snap.msg.mode, "plan");
  } finally {
    await relay.stop("test", { closeTransport: false });
  }
});

test("the heartbeat re-asserts busy from the activity RPC so a lost idle self-corrects", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession();
  session.rpc.metadata = {
    async activity() {
      return { hasActiveWork: true, abortable: true };
    },
  };
  const relay = await attachRelay({ session, channel, channelId: "chan-1", heartbeatMs: 20 });
  try {
    await new Promise((r) => setTimeout(r, 55));
    const beat = channel.sent.find((m) => m.eventSubtype === SUBTYPE.CONTROL.HEARTBEAT);
    assert.ok(beat, "expected a heartbeat to be emitted");
    assert.equal(beat.msg.busy, true);
  } finally {
    await relay.stop("test", { closeTransport: false });
  }
});

test("the heartbeat sends busy=null (unknown) when the host exposes no activity RPC", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession(); // no metadata RPC
  const relay = await attachRelay({ session, channel, channelId: "chan-1", heartbeatMs: 20 });
  try {
    await new Promise((r) => setTimeout(r, 55));
    const beat = channel.sent.find((m) => m.eventSubtype === SUBTYPE.CONTROL.HEARTBEAT);
    assert.ok(beat, "expected a heartbeat to be emitted");
    // null, not false — the phone must keep its live busy rather than be forced idle each beat.
    assert.equal(beat.msg.busy, null);
  } finally {
    await relay.stop("test", { closeTransport: false });
  }
});

test("the heartbeat re-affirms idle once after assistant.idle even when activity is unknown", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession(); // no metadata RPC
  const relay = await attachRelay({ session, channel, channelId: "chan-1", heartbeatMs: 20 });
  try {
    session.emitEvent({ type: "assistant.idle", id: "idle-1", data: {} });
    await new Promise((r) => setTimeout(r, 35));
    const beat = channel.sent.find((m) => m.eventSubtype === SUBTYPE.CONTROL.HEARTBEAT);
    assert.ok(beat, "expected a heartbeat to be emitted");
    assert.equal(beat.msg.busy, false);
  } finally {
    await relay.stop("test", { closeTransport: false });
  }
});

test("sendSafe stays quiet for five failures, triggers reconnect once on the sixth, and resets after success", async () => {
  const channel = makeFailingChannel({ failUntil: 6 });
  const session = makeFakeSession();
  const logs = [];
  session.log = (message, options) => logs.push({ message, options });
  let lostCount = 0;
  const relay = await attachRelay({
    session,
    channel,
    channelId: "chan-1",
    heartbeatMs: 10_000_000,
    onConnectionLost: () => {
      lostCount += 1;
    },
  });
  try {
    assert.equal(channel.attempts(), 1, "channel_up failure is counted");
    assert.equal(lostCount, 0);

    for (let i = 0; i < 4; i += 1) {
      session.emitEvent({ type: "assistant.idle", id: `idle-${i}`, data: {} });
      await flush();
    }
    assert.equal(channel.attempts(), 5);
    assert.equal(lostCount, 0, "below-threshold failures do not reconnect");
    assert.equal(logs.length, 0, "below-threshold failures stay silent");

    session.emitEvent({ type: "assistant.idle", id: "idle-threshold", data: {} });
    await flush();
    assert.equal(channel.attempts(), 6);
    assert.equal(lostCount, 1, "sixth consecutive failure triggers reconnect");
    assert.equal(logs.length, 0, "sendSafe does not log repeated send warnings");

    session.emitEvent({ type: "assistant.idle", id: "idle-success", data: {} });
    await flush();
    session.emitEvent({ type: "assistant.idle", id: "idle-fail-after-reset", data: {} });
    await flush();
    assert.equal(lostCount, 1, "a successful send resets the consecutive failure counter");
  } finally {
    await relay.stop("test", { closeTransport: false });
  }
});

test("createElicitationRelay.snapshotPending replays open ask_user payloads, cleared on complete", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession();
  const relay = createElicitationRelay({ session, channel, elicitationTimeoutMs: 10_000_000 });
  try {
    await relay.offer({
      requestId: "req-open",
      message: "Which env?",
      mode: "form",
      requestedSchema: { type: "object", properties: { env: { type: "string" } } },
    });
    // snapshotPending returns FLAT payloads (msg), ready to drop into a state snapshot.
    const snap = relay.snapshotPending();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].requestId, "req-open");
    assert.equal(snap[0].message, "Which env?");
    // Resolving it (here or at the terminal) removes it from the snapshot.
    await relay.complete({ requestId: "req-open", action: "accept" });
    assert.deepEqual(relay.snapshotPending(), []);
  } finally {
    relay.close();
  }
});

test("relays a control.interrupt to the SDK turn-abort and notifies the phone", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.CONTROL, interrupt());
    await flush();
    assert.deepEqual(session.abortCalls, [{ reason: "remote_command" }]);
    const notice = channel.sent.find(
      (m) => m.eventSubtype === SUBTYPE.STREAM.LOG && /stopped from your phone/i.test(m.msg.message ?? "")
    );
    assert.ok(notice, "expected a stop notice to be relayed to the phone");
  });
});

test("forwards turn lifecycle as activity busy=true on message_start, false on idle", async () => {
  await withRelay(async ({ channel, session }) => {
    // A turn begins with the assistant streaming text (no tool yet) — Stop must show here.
    session.emitEvent({ type: "assistant.message_start", id: "m1", data: {} });
    await flush();
    const start = channel.sent.find((m) => m.eventSubtype === SUBTYPE.STREAM.ACTIVITY);
    assert.ok(start, "expected an activity message on message_start");
    assert.equal(start.msg.busy, true);

    // The agent's loop goes idle → the turn is over, nothing left to abort.
    session.emitEvent({ type: "assistant.idle", id: "i1", data: {} });
    await flush();
    const idle = channel.sent.filter((m) => m.eventSubtype === SUBTYPE.STREAM.ACTIVITY).at(-1);
    assert.equal(idle.msg.busy, false);
  });
});

test("a tool-first turn still reports activity busy=true on tool start", async () => {
  await withRelay(async ({ channel, session }) => {
    session.emitEvent({
      type: "tool.execution_start",
      id: "t1",
      data: { toolCallId: "t1", toolName: "powershell", arguments: { command: "ls" } },
    });
    await flush();
    const busy = channel.sent.find((m) => m.eventSubtype === SUBTYPE.STREAM.ACTIVITY);
    assert.ok(busy && busy.msg.busy === true, "expected activity busy=true alongside the tool start");
  });
});

// ---- ask_user / elicitation (#64) ------------------------------------------
// The runtime emits elicitation.requested when the agent needs a structured answer.
// The relay must ferry the form to the phone, feed the phone's answer back into the
// SDK via respondToElicitation, dismiss the phone when any side answers, and never let
// a walked-away phone hang the turn (fail-safe cancel on timeout).

test("relays an elicitation.requested to the phone as an elicitation request envelope", async () => {
  await withRelay(async ({ channel, session }) => {
    session.emitEvent({
      type: "elicitation.requested",
      id: "el1",
      data: {
        requestId: "req-1",
        message: "Where should I deploy?",
        mode: "form",
        requestedSchema: { type: "object", properties: { env: { type: "string" } }, required: ["env"] },
        toolCallId: "tc-1",
      },
    });
    await flush();
    const req = channel.sent.find(
      (m) => m.eventType === EVENT_TYPE.ELICITATION && m.eventSubtype === SUBTYPE.ELICITATION.REQUEST,
    );
    assert.ok(req, "expected an elicitation.request relayed to the phone");
    assert.equal(req.msg.requestId, "req-1");
    assert.equal(req.msg.message, "Where should I deploy?");
    assert.equal(req.msg.requestedSchema.properties.env.type, "string");
  });
});

test("feeds a phone elicitation answer back into the SDK via handlePendingElicitation", async () => {
  await withRelay(async ({ channel, session }) => {
    session.emitEvent({
      type: "elicitation.requested",
      id: "el2",
      data: { requestId: "req-2", message: "Pick", mode: "form", requestedSchema: { type: "object", properties: {} } },
    });
    await flush();
    channel.emit(
      EVENT_TYPE.ELICITATION_RESPONSE,
      elicitationResponse("req-2", "accept", { env: "staging", migrate: true }),
    );
    await flush();
    assert.deepEqual(session.elicitationResponses, [
      { requestId: "req-2", result: { action: "accept", content: { env: "staging", migrate: true } } },
    ]);
  });
});

test("dismisses the phone form when any side completes the elicitation", async () => {
  await withRelay(async ({ channel, session }) => {
    session.emitEvent({
      type: "elicitation.completed",
      id: "el3",
      data: { requestId: "req-3", action: "accept" },
    });
    await flush();
    const done = channel.sent.find((m) => m.eventSubtype === SUBTYPE.ELICITATION.COMPLETE);
    assert.ok(done, "expected an elicitation.complete dismiss relayed to the phone");
    assert.equal(done.msg.requestId, "req-3");
    assert.equal(done.msg.action, "accept");
  });
});

test("cancels a stale elicitation on timeout so a walked-away phone can't hang the turn", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession();
  const relay = createElicitationRelay({ session, channel, elicitationTimeoutMs: 15 });
  try {
    relay.offer({
      requestId: "req-4",
      message: "still there?",
      mode: "form",
      requestedSchema: { type: "object", properties: {} },
    });
    await new Promise((r) => setTimeout(r, 45));
    assert.deepEqual(session.elicitationResponses, [
      { requestId: "req-4", result: { action: "cancel" } },
    ]);
    const dismiss = channel.sent.find((m) => m.eventSubtype === SUBTYPE.ELICITATION.COMPLETE);
    assert.ok(dismiss && dismiss.msg.action === "cancel", "expected a cancel dismiss after timeout");
  } finally {
    relay.close();
  }
});

// ---- permission decisions → native CLI decision kinds ----------------------
// The Copilot CLI native runtime (>= 1.0.66) only accepts the kebab-case decision
// kinds approve-once / approve-for-session / reject / user-not-available; returning
// the older "approved" / "denied-*" kinds throws "permission host returned malformed
// payload: unknown variant `approved`". These lock the phone decision → native mapping.

async function decideWith(optionId, raw) {
  const channel = makeFakeChannel();
  const relay = createPermissionRelay({ channel });
  try {
    const pending = relay.onPermissionRequest({ kind: "shell", toolName: "powershell" });
    await flush();
    const req = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.REQUEST);
    assert.ok(req, "expected an approval request to be sent to the phone");
    channel.emit(EVENT_TYPE.DECISION, approvalDecision(req.msg.requestId, optionId, raw));
    return await pending;
  } finally {
    relay.close();
  }
}

test("an approve decision resolves to the native approve-once kind", async () => {
  assert.deepEqual(await decideWith("approved"), { kind: "approve-once" });
});

test("a deny decision resolves to the native reject kind with feedback", async () => {
  const result = await decideWith("denied-interactively-by-user");
  assert.equal(result.kind, "reject");
  assert.equal(typeof result.feedback, "string");
});

test("an exact native decision in raw is passed through, unknown raw kinds are not", async () => {
  assert.deepEqual(await decideWith("whatever", { kind: "approve-for-session", approval: {} }), {
    kind: "approve-for-session",
    approval: {},
  });
  // A stale/unknown raw kind must never leak to the runtime — it falls back to reject.
  const result = await decideWith("nope", { kind: "approved" });
  assert.equal(result.kind, "reject");
});

test("a permission timeout fails closed with the native reject kind", async () => {
  const channel = makeFakeChannel();
  const relay = createPermissionRelay({ channel, approvalTimeoutMs: 5 });
  try {
    const result = await relay.onPermissionRequest({ kind: "shell", toolName: "powershell" });
    assert.equal(result.kind, "reject");
    // #78: the phone must be told the request is gone so its banner doesn't linger as a zombie.
    const done = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.COMPLETE);
    assert.ok(done, "expected an approval_complete after the timeout");
    assert.equal(done.msg.decision, "timeout");
  } finally {
    relay.close();
  }
});

test("approval requests carry the relay's real auto-deny deadline", async () => {
  const channel = makeFakeChannel();
  const approvalTimeoutMs = 12_345;
  const relay = createPermissionRelay({ channel, approvalTimeoutMs });
  try {
    const before = Date.now();
    void relay.onPermissionRequest({ kind: "shell", toolName: "powershell" });
    await flush();
    const after = Date.now();
    const req = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.REQUEST);
    assert.ok(req, "expected an approval request to be sent to the phone");
    assert.equal(req.msg.timeoutMs, approvalTimeoutMs);
    assert.ok(req.msg.expiresAt >= before + approvalTimeoutMs);
    assert.ok(req.msg.expiresAt <= after + approvalTimeoutMs);
  } finally {
    relay.close();
  }
});

test("approval requests infer shell commands from nested invocation input before raw request fallback", async () => {
  const channel = makeFakeChannel();
  const logs = [];
  const relay = createPermissionRelay({ channel, logger: (message, options) => logs.push({ message, options }) });
  try {
    void relay.onPermissionRequest(
      { kind: "shell", toolCallId: "toolu_123" },
      { toolInput: { command: "npm test -w extension" } },
    );
    await flush();
    const req = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.REQUEST);
    assert.ok(req, "expected an approval request to be sent to the phone");
    assert.deepEqual(req.msg.toolArgs, { command: "npm test -w extension" });
    assert.equal(logs.filter((entry) => /shell approval request shape/.test(entry.message)).length, 1);
  } finally {
    relay.close();
  }
});

test("a phone decision echoes an approval_complete so other devices dismiss the banner", async () => {
  const channel = makeFakeChannel();
  const relay = createPermissionRelay({ channel });
  try {
    const pending = relay.onPermissionRequest({ kind: "shell", toolName: "powershell" });
    await flush();
    const req = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.REQUEST);
    channel.emit(EVENT_TYPE.DECISION, approvalDecision(req.msg.requestId, "approved"));
    await pending;
    const done = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.COMPLETE);
    assert.ok(done, "expected an approval_complete after the decision");
    assert.equal(done.msg.requestId, req.msg.requestId);
  } finally {
    relay.close();
  }
});

test("createPermissionRelay.snapshotPending replays pending approval payloads verbatim", async () => {
  const channel = makeFakeChannel();
  const relay = createPermissionRelay({ channel });
  try {
    void relay.onPermissionRequest({ kind: "shell", toolName: "powershell" });
    await flush();
    // snapshotPending returns FLAT payloads (msg).
    const snap = relay.snapshotPending();
    assert.equal(snap.length, 1);
    assert.equal(snap[0].toolName, "powershell");
    // The replayed payload reuses the SAME requestId sent to the phone, so a decision on the
    // replayed prompt still resolves the original pending entry.
    const sent = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.REQUEST);
    assert.equal(snap[0].requestId, sent.msg.requestId);
    // Answering it removes it from the snapshot.
    channel.emit(EVENT_TYPE.DECISION, approvalDecision(sent.msg.requestId, "approved"));
    await flush();
    assert.deepEqual(relay.snapshotPending(), []);
  } finally {
    relay.close();
  }
});

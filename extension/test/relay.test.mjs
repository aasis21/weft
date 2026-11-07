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
import { mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  EVENT_TYPE,
  SUBTYPE,
  prompt,
  historyRequest,
  stateRequest,
  interrupt,
  voiceMode,
  invokeCommand,
  elicitationResponse,
  approvalDecision,
  watchRequest,
  recoveryRequest,
  assistantMessage,
  assistantDelta,
  toolStart,
  toolComplete,
  logLine,
} from "@aasis21/weft-shared";
import {
  attachRelay as createRelay,
  createElicitationRelay,
  createExitPlanModeRelay,
  createPermissionRelay,
  createPromptOriginTracker,
} from "../src/relay.mjs";
import { createSessionRecovery } from "../src/sessionRecovery.mjs";
import { createAttentionLease } from "../src/pairedEndpoint.mjs";

async function attachRelay(options) {
  return createRelay({
    ...options,
    recoveryStore: options.recoveryStore ?? await createSessionRecovery({ persist: false }),
  });
}

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
  const invokedCommands = [];
  return {
    sessionId,
    cwd: "/repo",
    prompts,
    abortCalls,
    elicitationResponses,
    exitPlanResponses,
    interestCalls,
    invokedCommands,
    rpc: {
      commands: {
        async invoke(params) {
          invokedCommands.push(params);
          return { success: true };
        },
      },
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
    await run({ channel, session, relay });
  } finally {
    await relay.stop("test", { closeTransport: false });
  }
}

test("attention expires after sleep, respects cooldown, and fences an older watch", () => {
  let clock = 0;
  const lease = createAttentionLease({ now: () => clock });
  assert.equal(lease.level, "detail", "older clients remain supported");
  lease.update({ watchId: "old", level: "detail" });
  lease.update({ watchId: "new", level: "compact" });
  assert.equal(lease.update({ watchId: "old", level: "detail" }), null);
  assert.equal(lease.update({ watchId: "old", level: "off" }), null);
  lease.update({ watchId: "new", level: "off" });
  assert.equal(lease.level, "compact");
  clock += 5001;
  assert.equal(lease.level, "off");
  assert.equal(lease.update({ watchId: "new", level: "detail" }), null, "late renew cannot restart a stopped watch");
  lease.update({ watchId: "visible", level: "detail" });
  clock += 60_001;
  assert.equal(lease.level, "off", "elapsed wall-clock lease expires before wake-up sends");
});

test("compact watch suppresses tokens and returns committed, scrubbed catch-up", async () => {
  await withRelay(async ({ session, channel }) => {
    channel.emit(EVENT_TYPE.CONTROL, watchRequest("compact", "compact"));
    await flush();
    channel.sent.length = 0;
    session.emitEvent({ type: "assistant.message_delta", data: { deltaContent: "token" } });
    session.emitEvent({ type: "tool.execution_start", data: { toolCallId: "tool", toolName: "shell", arguments: { command: "private command" } } });
    session.emitEvent({ type: "tool.execution_complete", data: { toolCallId: "tool", toolName: "shell", success: false, error: { message: "private result" } } });
    session.emitEvent({ type: "assistant.message", id: "answer", data: { content: "Finished" } });
    await flush();
    assert.equal(channel.sent.filter((message) => message.eventType === EVENT_TYPE.STREAM).length, 0);
    assert.ok(channel.sent.some((message) => message.eventSubtype === SUBTYPE.CONTROL.SESSION_STATUS && message.msg.cursor === 3));
    channel.emit(EVENT_TYPE.CONTROL, recoveryRequest());
    await flush();
    const page = channel.sent.find((message) => message.eventSubtype === SUBTYPE.CONTROL.RECOVERY).msg;
    assert.equal(page.items.length, 3);
    assert.ok(!JSON.stringify(page).includes("private command"));
    assert.ok(!JSON.stringify(page).includes("private result"));
    assert.deepEqual(page.items[0].message.msg.args, {});
    assert.equal(page.items[1].message.msg.resultPreview, "Failed");
    assert.equal(page.items.at(-1).message.msg.content, "Finished");
    assert.equal(page.items.at(-1).message.recoverySequence, 3);
  });
});

test("disconnect keeps capture and pending native approval until a fresh channel answers", async () => {
  await withRelay(async ({ session, channel, relay }) => {
    const approval = relay.onPermissionRequest({ kind: "shell", fullCommandText: "npm test" });
    await flush();
    const request = channel.sent.find((message) => message.eventSubtype === SUBTYPE.APPROVAL.REQUEST);
    assert.ok(request);
    relay.detach();
    assert.equal((await relay.onPermissionRequest({ kind: "shell" })).kind, "user-not-available");
    session.emitEvent({ type: "assistant.message", id: "missed", data: { content: "While disconnected" } });
    const replacement = makeFakeChannel();
    await relay.rebind(replacement);
    replacement.emit(EVENT_TYPE.CONTROL, stateRequest());
    await flush();
    const snapshot = replacement.sent.find((message) => message.eventSubtype === SUBTYPE.CONTROL.STATE_SNAPSHOT);
    assert.equal(snapshot.msg.approvals[0].requestId, request.msg.requestId);
    channel.emit(EVENT_TYPE.DECISION, approvalDecision(request.msg.requestId, "approve"));
    assert.equal(snapshot.msg.approvals.length, 1);
    replacement.emit(EVENT_TYPE.DECISION, approvalDecision(request.msg.requestId, "approve"));
    assert.equal((await approval).kind, "approve-once");
    replacement.emit(EVENT_TYPE.CONTROL, recoveryRequest());
    await flush();
    assert.ok(replacement.sent.find((message) => message.eventSubtype === SUBTYPE.CONTROL.RECOVERY)
      .msg.items.some((item) => item.message.msg.content === "While disconnected"));
  });
});

test("an old connection cannot deliver its delayed recovery response to a replacement", async () => {
  const channel = makeFakeChannel();
  const replacement = makeFakeChannel();
  const journal = await createSessionRecovery({ persist: false });
  await journal.capture(assistantMessage("Saved"));
  let release;
  let entered;
  const blocked = new Promise((resolve) => { release = resolve; });
  const requested = new Promise((resolve) => { entered = resolve; });
  const page = journal.page.bind(journal);
  journal.page = async (...args) => {
    entered();
    await blocked;
    return page(...args);
  };
  const relay = await attachRelay({
    session: makeFakeSession(), channel, recoveryStore: journal, heartbeatMs: 10_000_000,
  });
  try {
    channel.emit(EVENT_TYPE.CONTROL, recoveryRequest());
    await requested;
    await relay.rebind(replacement);
    release();
    await flush();
    assert.ok(!replacement.sent.some((message) => message.eventSubtype === SUBTYPE.CONTROL.RECOVERY));
    replacement.emit(EVENT_TYPE.CONTROL, recoveryRequest());
    await flush();
    assert.equal(replacement.sent.find((message) => message.eventSubtype === SUBTYPE.CONTROL.RECOVERY).msg.items.length, 1);
  } finally {
    release();
    await relay.stop("test", { closeTransport: false });
  }
});

test("recovery is durable, paged, bounded, and reports retained-history gaps", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "weft-recovery-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let journal = await createSessionRecovery({ sessionId: "durable", baseDir: dir, maxEvents: 2 });
  await journal.capture(assistantDelta("not retained"));
  await journal.capture(toolStart("tool", "shell", { command: "not retained" }));
  await journal.capture(toolComplete("tool", "shell", false, "not retained"));
  const live = await journal.capture(assistantMessage("Saved", "answer"));
  const epoch = live.recoveryEpoch;
  await journal.close();
  journal = await createSessionRecovery({ sessionId: "durable", baseDir: dir, maxEvents: 2 });
  const page = await journal.page(epoch, 0, 1);
  assert.equal(page.epoch, epoch);
  assert.equal(page.items.length, 1);
  assert.equal(page.hasMore, true);
  assert.equal(page.gap, true);
  const next = await journal.page(epoch, page.cursor, 1);
  assert.equal(next.items[0].message.msg.content, "Saved");
  assert.equal(next.hasMore, false);
  const contents = await readFile(join(dir, "recovery", (await readdir(join(dir, "recovery")))[0]), "utf8");
  assert.ok(!contents.includes("not retained"));
  assert.equal((await journal.page("different-epoch", 100)).gap, true);
});

test("catch-up bounds large messages, resets corrupt caches explicitly, and ages out events", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "weft-recovery-limits-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let clock = Date.now();
  let journal = await createSessionRecovery({
    sessionId: "limits", baseDir: dir, now: () => clock, retentionMs: 1000, maxEventBytes: 1024,
  });
  await journal.capture(assistantMessage("x".repeat(10_000), "large"));
  await journal.capture(logLine("error", "private failure details"));
  let page = await journal.page(null, 0, 50);
  assert.ok(page.items[0].message.msg.content.includes("truncated in catch-up"));
  assert.ok(Buffer.byteLength(JSON.stringify(page.items[0])) < 1024);
  assert.ok(!JSON.stringify(page).includes("private failure details"));
  assert.equal(page.gap, true);
  clock = Date.now() + 2000;
  page = await journal.page(journal.epoch, 0);
  assert.equal(page.items.length, 0);
  assert.equal(page.gap, true);
  await journal.close();
  const filename = (await readdir(join(dir, "recovery"))).find((name) => name.endsWith(".json"));
  await writeFile(join(dir, "recovery", filename), "{broken");
  const issues = [];
  journal = await createSessionRecovery({ sessionId: "limits", baseDir: dir, onIssue: (error) => issues.push(error) });
  assert.equal(issues.length, 1);
  await journal.capture(assistantMessage("Recovered"));
  assert.equal((await journal.page(null, 0)).items[0].message.msg.content, "Recovered");
});

test("machine catch-up budget evicts old caches without resetting the current epoch", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "weft-recovery-budget-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const options = { baseDir: dir, maxBytes: 2048, machineBytes: 3000 };
  const old = await createSessionRecovery({ ...options, sessionId: "old" });
  await old.capture(assistantMessage("x".repeat(1200)));
  await old.close();
  const current = await createSessionRecovery({ ...options, sessionId: "current" });
  const epoch = current.epoch;
  await current.capture(assistantMessage("y".repeat(1200)));
  await current.close();
  const files = (await readdir(join(dir, "recovery"))).filter((name) => name.endsWith(".json"));
  assert.equal(files.length, 1);
  assert.equal(JSON.parse(await readFile(join(dir, "recovery", files[0]), "utf8")).epoch, epoch);
  const stale = `${"a".repeat(64)}.json.0.00000000-0000-0000-0000-000000000001.tmp`;
  const fresh = `${"b".repeat(64)}.json.0.00000000-0000-0000-0000-000000000002.tmp`;
  await writeFile(join(dir, "recovery", stale), "interrupted save");
  await writeFile(join(dir, "recovery", fresh), "save in progress");
  const expired = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000);
  await utimes(join(dir, "recovery", stale), expired, expired);
  const resumed = await createSessionRecovery({ ...options, sessionId: "current" });
  assert.equal(resumed.epoch, epoch);
  const retained = await readdir(join(dir, "recovery"));
  assert.ok(!retained.includes(stale), "expired crash leftovers are removed");
  assert.ok(retained.includes(fresh), "an in-flight atomic save is not removed");
  await resumed.close();
});

test("stalled live delivery does not block durable capture or catch-up requests", async () => {
  await withRelay(async ({ channel, session }) => {
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const send = channel.send.bind(channel);
    channel.send = async (message) => {
      if (message.eventType === EVENT_TYPE.STREAM) await blocked;
      await send(message);
    };
    try {
      session.emitEvent({ type: "assistant.message_delta", data: { deltaContent: "in flight", messageId: "slow" } });
      session.emitEvent({ type: "assistant.message_start", data: {} });
      session.emitEvent({ type: "assistant.message", id: "slow", data: { content: "Saved before delivery" } });
      for (let index = 0; index < 80; index++) {
        session.emitEvent({ type: "assistant.message", id: `queued-${index}`, data: { content: `Queued ${index}` } });
      }
      await flush();
      channel.emit(EVENT_TYPE.CONTROL, recoveryRequest(null, 0, 100));
      channel.emit(EVENT_TYPE.CONTROL, stateRequest());
      await flush();
      const recovered = channel.sent.find((message) => message.eventSubtype === SUBTYPE.CONTROL.RECOVERY).msg.items;
      assert.equal(recovered.length, 81, "trimmed wire frames remain available for replay");
      assert.ok(recovered.some((item) => item.message.msg.content === "Saved before delivery"));
      assert.equal(channel.sent.find((message) => message.eventSubtype === SUBTYPE.CONTROL.STATE_SNAPSHOT).msg.busy, true);
      release();
      await flush();
      const delivered = channel.sent.filter((message) => message.eventSubtype === SUBTYPE.STREAM.ASSISTANT_MESSAGE);
      assert.equal(delivered.length, 64, "stalled delivery bounds the pending frame queue");
      assert.equal(delivered.at(-1).msg.content, "Queued 79");
      assert.equal(channel.sent.find((message) => message.eventSubtype === SUBTYPE.CONTROL.SESSION_STATUS).msg.cursor, 81);
    } finally { release(); }
  });
});

test("relays exit_plan_mode.requested as a three-option approval and answers via the UI RPC", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession();
  const relay = createExitPlanModeRelay({ session, channel });
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
    assert.equal(req.msg.timeoutMs, undefined);
    assert.equal(req.msg.expiresAt, undefined);
    assert.deepEqual(
      req.msg.options.map((o) => ({ id: o.id, label: o.label, recommended: o.recommended })),
      [
        { id: "exit_only", label: "Exit plan mode", recommended: false },
        { id: "autopilot", label: "Accept plan and build", recommended: true },
        { id: "suggest_changes", label: "Suggest changes", recommended: false },
      ],
    );

    await new Promise((r) => setTimeout(r, 45));
    assert.deepEqual(session.exitPlanResponses, []);
    assert.equal(
      channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.COMPLETE),
      undefined,
      "the plan-exit request must not be dismissed automatically",
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
  const t = createPromptOriginTracker();
  assert.equal(t.classify("never typed here"), "terminal");
  t.record("run the tests");
  assert.equal(t.size, 1);
  assert.equal(t.classify("run the tests"), "phone");
  // The match is consumed, so a later identical (terminal) prompt is not mis-attributed.
  assert.equal(t.classify("run the tests"), "terminal");
  assert.equal(t.size, 0);
});

test("createPromptOriginTracker: matches never expire on time (steering + queued alike)", () => {
  const t = createPromptOriginTracker();
  t.record("deploy please");
  // A steering prompt can sit until the current turn reaches a safe boundary, a queued one
  // until the whole turn ends — however long that takes, its echo is still the phone's.
  assert.equal(t.classify("deploy please"), "phone");
  assert.equal(t.size, 0);
});

test("createPromptOriginTracker: forget releases a prompt whose relay send failed", () => {
  const t = createPromptOriginTracker();
  t.record("never delivered");
  t.forget("never delivered");
  assert.equal(t.size, 0);
  assert.equal(t.classify("never delivered"), "terminal");
});

test("createPromptOriginTracker: pending correlations are capped, oldest dropped first", () => {
  const t = createPromptOriginTracker({ maxPending: 2 });
  t.record("one");
  t.record("two");
  t.record("three");
  assert.equal(t.size, 2);
  assert.equal(t.classify("one"), "terminal");
  assert.equal(t.classify("two"), "phone");
  assert.equal(t.classify("three"), "phone");
});

test("createPromptOriginTracker: ignores non-string input", () => {
  const t = createPromptOriginTracker();
  t.record(undefined);
  t.record(42);
  t.forget(undefined);
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

test("does NOT re-broadcast a phone STEERING prompt echoed long after it was relayed", async () => {
  // Regression: a steering prompt sent while the agent is busy is held by the CLI until the
  // current turn reaches a safe boundary. When correlations expired on a timer, a slow turn
  // meant the echo arrived unclaimed, was classed 'terminal', and re-broadcast — so the phone
  // showed the message twice (once optimistically, once as a 'Laptop' bubble).
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.PROMPT, prompt("steer me"));
    await flush();

    // A whole turn's worth of unrelated activity happens before the prompt is admitted.
    session.emitEvent({ type: "user.message", id: "e-other", data: { content: "typed at laptop" } });
    session.emitEvent({ type: "assistant.message", id: "a1", data: { content: "working" } });
    session.emitEvent({ type: "tool.execution_start", id: "t1", data: { toolCallId: "t1", toolName: "bash" } });
    await flush();

    session.emitEvent({ type: "user.message", id: "e3", data: { content: "steer me" } });
    await flush();
    const echoes = channel.sent.filter(
      (m) => m.eventSubtype === SUBTYPE.STREAM.USER_MESSAGE && m.msg.text === "steer me"
    );
    assert.equal(echoes.length, 0);
  });
});

test("re-broadcasts a phone prompt whose relay send failed, if it is later typed at the laptop", async () => {
  await withRelay(async ({ channel, session }) => {
    session.send = async () => {
      throw new Error("session gone");
    };
    channel.emit(EVENT_TYPE.PROMPT, prompt("never delivered"));
    await flush();

    // The prompt never reached the session, so this user.message really is terminal-typed.
    session.emitEvent({ type: "user.message", id: "e4", data: { content: "never delivered" } });
    await flush();
    const echo = channel.sent.find(
      (m) => m.eventSubtype === SUBTYPE.STREAM.USER_MESSAGE && m.msg.text === "never delivered"
    );
    assert.ok(echo, "expected the undelivered prompt's correlation to have been released");
    assert.equal(echo.msg.origin, "terminal");
  });
});

test("relays a queued phone prompt with enqueue delivery", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.PROMPT, prompt("after this", null, "enqueue"));
    await flush();
    assert.deepEqual(session.prompts.at(-1), { prompt: "after this", mode: "enqueue" });
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
  const relay = createElicitationRelay({ session, channel });
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

test("invokes a whitelisted phone command via session.rpc.commands.invoke and relays success", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.CONTROL, invokeCommand("rename", "My Session"));
    await flush();
    assert.deepEqual(session.invokedCommands, [{ name: "rename", input: "My Session" }]);
    const ok = channel.sent.find(
      (m) => m.eventSubtype === SUBTYPE.STREAM.LOG && /Ran \/rename My Session/.test(m.msg.message ?? "")
    );
    assert.ok(ok, "expected a success notice relayed to the phone");
  });
});

test("omits input when invoking a no-arg command", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.CONTROL, invokeCommand("plan"));
    await flush();
    assert.deepEqual(session.invokedCommands, [{ name: "plan" }]);
  });
});

test("refuses a non-whitelisted command and never touches the SDK", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.CONTROL, invokeCommand("resume"));
    await flush();
    assert.deepEqual(session.invokedCommands, []);
    const warn = channel.sent.find(
      (m) => m.eventSubtype === SUBTYPE.STREAM.LOG && /isn't allowed from the phone/i.test(m.msg.message ?? "")
    );
    assert.ok(warn, "expected a not-allowed warning relayed to the phone");
  });
});

test("refuses a required-arg command with no argument", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.CONTROL, invokeCommand("rename"));
    await flush();
    assert.deepEqual(session.invokedCommands, []);
    const warn = channel.sent.find(
      (m) => m.eventSubtype === SUBTYPE.STREAM.LOG && /needs an argument/i.test(m.msg.message ?? "")
    );
    assert.ok(warn, "expected a needs-an-argument warning relayed to the phone");
  });
});

test("canonicalizes an approved model label before invoking the SDK", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.CONTROL, invokeCommand("model", "Claude Sonnet 5"));
    await flush();
    assert.deepEqual(session.invokedCommands, [{ name: "model", input: "claude-sonnet-5" }]);
    const ok = channel.sent.find(
      (m) => m.eventSubtype === SUBTYPE.STREAM.LOG && /Ran \/model Claude Sonnet 5/.test(m.msg.message ?? "")
    );
    assert.ok(ok, "expected the friendly model label in the success notice");
    assert.equal(channel.sent.some((m) => /claude-sonnet-5/.test(m.msg.message ?? "")), false);
  });
});

test("refuses an unlisted model before invoking the SDK", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENT_TYPE.CONTROL, invokeCommand("model", "unlisted-model"));
    await flush();
    assert.deepEqual(session.invokedCommands, []);
    const warn = channel.sent.find(
      (m) => m.eventSubtype === SUBTYPE.STREAM.LOG && /isn't available for \/model/i.test(m.msg.message ?? "")
    );
    assert.ok(warn, "expected an unavailable-option warning relayed to the phone");
  });
});

test("relays a resolved SDK command failure without a success-shaped fallback", async () => {
  await withRelay(async ({ channel, session }) => {
    session.rpc.commands.invoke = async (params) => {
      session.invokedCommands.push(params);
      return { success: false, error: { message: "Model unavailable for this account" } };
    };

    channel.emit(EVENT_TYPE.CONTROL, invokeCommand("model", "auto"));
    await flush();

    const logs = channel.sent.filter((m) => m.eventSubtype === SUBTYPE.STREAM.LOG);
    assert.ok(logs.some((m) => /\/model Auto failed: Model unavailable/i.test(m.msg.message ?? "")));
    assert.equal(logs.some((m) => /Ran \/model Auto/i.test(m.msg.message ?? "")), false);
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

test("keeps an unanswered elicitation pending until it is explicitly completed", async () => {
  const channel = makeFakeChannel();
  const session = makeFakeSession();
  const relay = createElicitationRelay({ session, channel });
  try {
    await relay.offer({
      requestId: "req-4",
      message: "still there?",
      mode: "form",
      requestedSchema: { type: "object", properties: {} },
    });
    await new Promise((r) => setTimeout(r, 45));
    assert.deepEqual(session.elicitationResponses, []);
    assert.equal(
      channel.sent.find((m) => m.eventSubtype === SUBTYPE.ELICITATION.COMPLETE),
      undefined,
      "the phone form must not be dismissed automatically",
    );
    assert.equal(relay.snapshotPending()[0]?.requestId, "req-4");

    await relay.complete({ requestId: "req-4", action: "cancel" });
    assert.deepEqual(relay.snapshotPending(), []);
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

test("keeps a permission request pending until the phone decides", async () => {
  const channel = makeFakeChannel();
  const relay = createPermissionRelay({ channel });
  try {
    const resultPromise = relay.onPermissionRequest({ kind: "shell", toolName: "powershell" });
    await new Promise((r) => setTimeout(r, 45));
    const req = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.REQUEST);
    assert.ok(req, "expected an approval request to be sent to the phone");
    assert.equal(req.msg.timeoutMs, undefined);
    assert.equal(req.msg.expiresAt, undefined);
    assert.equal(
      channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.COMPLETE),
      undefined,
      "the approval must not be dismissed automatically",
    );

    channel.emit(EVENT_TYPE.DECISION, approvalDecision(req.msg.requestId, "denied-interactively-by-user"));
    const result = await resultPromise;
    assert.equal(result.kind, "reject");
    const done = channel.sent.find((m) => m.eventSubtype === SUBTYPE.APPROVAL.COMPLETE);
    assert.equal(done?.msg.decision, "denied-interactively-by-user");
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
    assert.equal(logs.length, 0, "raw approval arguments must not be written to host diagnostics");
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

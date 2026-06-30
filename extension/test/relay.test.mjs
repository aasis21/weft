// SPDX-License-Identifier: Apache-2.0
// Tests for the relay's new behaviors: phone/terminal prompt-origin correlation,
// terminal user.message echoing, and serving history requests. The pure tracker is
// tested directly; the wiring is tested via lightweight fake session/channel objects.

import { test } from "node:test";
import assert from "node:assert/strict";

import { EVENTS, KIND } from "@aasis21/helm-shared";
import { attachRelay, createPermissionRelay, createPromptOriginTracker } from "../src/relay.mjs";

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

function makeFakeSession(sessionId = "unknown-session") {
  let handler = null;
  const prompts = [];
  const abortCalls = [];
  return {
    sessionId,
    cwd: "/repo",
    prompts,
    abortCalls,
    rpc: {
      async abort(params) {
        abortCalls.push(params);
        return { success: true };
      },
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
    const echo = channel.sent.find((m) => m.kind === KIND.USER_MESSAGE);
    assert.ok(echo, "expected a user_message echo");
    assert.equal(echo.text, "typed at laptop");
    assert.equal(echo.origin, "terminal");
    assert.equal(echo.id, "e1");
  });
});

test("does NOT re-broadcast a phone-relayed prompt's echoed user.message", async () => {
  await withRelay(async ({ channel, session }) => {
    // Phone sends a prompt; the relay records it and forwards into the session.
    channel.emit(EVENTS.PROMPT, { kind: KIND.PROMPT, text: "from my phone" });
    await flush();
    assert.deepEqual(session.prompts.at(-1), { prompt: "from my phone", mode: "immediate" });

    // The session then echoes it back as a user.message — must NOT be re-broadcast.
    session.emitEvent({ type: "user.message", id: "e2", data: { content: "from my phone" } });
    await flush();
    const echoes = channel.sent.filter(
      (m) => m.kind === KIND.USER_MESSAGE && m.text === "from my phone"
    );
    assert.equal(echoes.length, 0);
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
    assert.equal(channel.sent.filter((m) => m.kind === KIND.USER_MESSAGE).length, 0);
  });
});

test("answers a HISTORY_REQUEST with a control.history message", async () => {
  await withRelay(async ({ channel }) => {
    channel.emit(EVENTS.CONTROL, { kind: KIND.HISTORY_REQUEST, before: null, limit: 50 });
    await flush();
    const hist = channel.sent.find((m) => m.kind === KIND.HISTORY);
    assert.ok(hist, "expected a control.history response");
    // Unknown session id → empty page, but the shape must be correct.
    assert.deepEqual(hist.items, []);
    assert.equal(hist.nextCursor, null);
    assert.equal(hist.hasMore, false);
  });
});

test("relays a control.interrupt to the SDK turn-abort and notifies the phone", async () => {
  await withRelay(async ({ channel, session }) => {
    channel.emit(EVENTS.CONTROL, { kind: KIND.INTERRUPT });
    await flush();
    assert.deepEqual(session.abortCalls, [{ reason: "remote_command" }]);
    const notice = channel.sent.find(
      (m) => m.kind === KIND.LOG && /stopped from your phone/i.test(m.message ?? "")
    );
    assert.ok(notice, "expected a stop notice to be relayed to the phone");
  });
});

test("forwards turn lifecycle as activity busy=true on message_start, false on idle", async () => {
  await withRelay(async ({ channel, session }) => {
    // A turn begins with the assistant streaming text (no tool yet) — Stop must show here.
    session.emitEvent({ type: "assistant.message_start", id: "m1", data: {} });
    await flush();
    const start = channel.sent.find((m) => m.kind === KIND.ACTIVITY);
    assert.ok(start, "expected an activity message on message_start");
    assert.equal(start.busy, true);

    // The agent's loop goes idle → the turn is over, nothing left to abort.
    session.emitEvent({ type: "assistant.idle", id: "i1", data: {} });
    await flush();
    const idle = channel.sent.filter((m) => m.kind === KIND.ACTIVITY).at(-1);
    assert.equal(idle.busy, false);
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
    const busy = channel.sent.find((m) => m.kind === KIND.ACTIVITY);
    assert.ok(busy && busy.busy === true, "expected activity busy=true alongside the tool start");
  });
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
    const req = channel.sent.find((m) => m.kind === KIND.APPROVAL_REQUEST);
    assert.ok(req, "expected an approval request to be sent to the phone");
    channel.emit(EVENTS.DECISION, {
      kind: KIND.APPROVAL_DECISION,
      requestId: req.requestId,
      optionId,
      raw,
    });
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
  } finally {
    relay.close();
  }
});

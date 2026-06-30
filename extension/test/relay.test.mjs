// SPDX-License-Identifier: Apache-2.0
// Tests for the relay's new behaviors: phone/terminal prompt-origin correlation,
// terminal user.message echoing, and serving history requests. The pure tracker is
// tested directly; the wiring is tested via lightweight fake session/channel objects.

import { test } from "node:test";
import assert from "node:assert/strict";

import { EVENTS, KIND } from "@aasis21/helm-shared";
import { attachRelay, createPromptOriginTracker } from "../src/relay.mjs";

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
  return {
    sessionId,
    cwd: "/repo",
    prompts,
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

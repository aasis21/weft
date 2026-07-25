// Unit tests for the standardized event-envelope factories (shared/messages.mjs).
//
// Every factory returns { eventType, eventSubtype, msg, ts } with ALL type-specific data nested
// under `msg`. Identity fields (channelId/sessionId/senderId/senderName) are stamped later by
// SecureChannel on send, so the factories never set them.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVENT_TYPE,
  SUBTYPE,
  MODES,
  assistantMessage,
  assistantDelta,
  toolStart,
  toolComplete,
  logLine,
  activity,
  userMessage,
  prompt,
  approvalRequest,
  approvalDecision,
  approvalComplete,
  channelUp,
  sessionMeta,
  channelDown,
  heartbeat,
  modeChange,
  interrupt,
  historyRequest,
  history,
  stateRequest,
  stateSnapshot,
  elicitationRequest,
  elicitationResponse,
  elicitationComplete,
  deviceHeartbeat,
  isValidEnvelope,
} from "../messages.mjs";

/** Assert an envelope's classifying fields + timestamp, independent of payload. */
function assertEnvelope(env, eventType, eventSubtype) {
  assert.equal(env.eventType, eventType);
  assert.equal(env.eventSubtype, eventSubtype);
  assert.equal(typeof env.ts, "number");
  assert.equal(typeof env.msg, "object");
  // Factories never stamp identity — that is the channel's job on send.
  assert.equal(env.channelId, undefined);
  assert.equal(env.senderId, undefined);
}

// ---- stream (ext -> phone) -------------------------------------------------

test("assistantMessage nests content + messageId under msg", () => {
  const m = assistantMessage("hi there", "m-1");
  assertEnvelope(m, EVENT_TYPE.STREAM, SUBTYPE.STREAM.ASSISTANT_MESSAGE);
  assert.equal(m.msg.content, "hi there");
  assert.equal(m.msg.messageId, "m-1");
});

test("assistantDelta carries an incremental chunk", () => {
  const m = assistantDelta("tok", "m-1");
  assertEnvelope(m, EVENT_TYPE.STREAM, SUBTYPE.STREAM.ASSISTANT_DELTA);
  assert.equal(m.msg.content, "tok");
  assert.equal(m.msg.messageId, "m-1");
});

test("toolStart / toolComplete carry tool linkage under msg", () => {
  const s = toolStart("call-1", "grep", { pattern: "x" });
  assertEnvelope(s, EVENT_TYPE.STREAM, SUBTYPE.STREAM.TOOL_START);
  assert.equal(s.msg.toolCallId, "call-1");
  assert.equal(s.msg.toolName, "grep");
  assert.deepEqual(s.msg.args, { pattern: "x" });

  const c = toolComplete("call-1", "grep", true, "3 matches");
  assertEnvelope(c, EVENT_TYPE.STREAM, SUBTYPE.STREAM.TOOL_COMPLETE);
  assert.equal(c.msg.toolCallId, "call-1");
  assert.equal(c.msg.success, true);
  assert.equal(c.msg.resultPreview, "3 matches");
});

test("logLine carries level + message", () => {
  const m = logLine("info", "hello");
  assertEnvelope(m, EVENT_TYPE.STREAM, SUBTYPE.STREAM.LOG);
  assert.equal(m.msg.level, "info");
  assert.equal(m.msg.message, "hello");
});

test("activity coerces busy to a boolean under msg", () => {
  const on = activity(1);
  assertEnvelope(on, EVENT_TYPE.STREAM, SUBTYPE.STREAM.ACTIVITY);
  assert.equal(on.msg.busy, true);
  assert.equal(activity(0).msg.busy, false);
});

test("userMessage defaults origin to terminal and carries id/text under msg", () => {
  const m = userMessage("hello laptop", "terminal", "evt-1");
  assertEnvelope(m, EVENT_TYPE.STREAM, SUBTYPE.STREAM.USER_MESSAGE);
  assert.equal(m.msg.text, "hello laptop");
  assert.equal(m.msg.origin, "terminal");
  assert.equal(m.msg.id, "evt-1");
  assert.equal(userMessage("x").msg.origin, "terminal"); // explicit default
  assert.equal(userMessage("y", "phone", "e2").msg.origin, "phone");
});

// ---- prompt (phone -> ext) -------------------------------------------------

test("prompt carries text and only includes attachments when present", () => {
  const bare = prompt("do the thing");
  assertEnvelope(bare, EVENT_TYPE.PROMPT, SUBTYPE.PROMPT.PROMPT);
  assert.equal(bare.msg.text, "do the thing");
  assert.equal(bare.msg.attachments, undefined);
  assert.equal(bare.msg.delivery, undefined);

  const atts = [{ data: "AAAA", mimeType: "image/png", name: "a.png" }];
  const withImg = prompt("look", atts);
  assert.deepEqual(withImg.msg.attachments, atts);
  // Empty array is treated as no attachments.
  assert.equal(prompt("x", []).msg.attachments, undefined);

  const queued = prompt("after this", null, "enqueue");
  assert.equal(queued.msg.delivery, "enqueue");
});

// ---- approval / decision ---------------------------------------------------

test("approvalRequest mirrors the native prompt under msg", () => {
  const opts = [{ id: "allow", label: "Allow" }];
  const m = approvalRequest("req-1", "shell", { cmd: "ls" }, opts, {
    timeoutMs: 120_000,
    expiresAt: 1_900_000_000_000,
  });
  assertEnvelope(m, EVENT_TYPE.APPROVAL, SUBTYPE.APPROVAL.REQUEST);
  assert.equal(m.msg.requestId, "req-1");
  assert.equal(m.msg.toolName, "shell");
  assert.deepEqual(m.msg.toolArgs, { cmd: "ls" });
  assert.deepEqual(m.msg.options, opts);
  assert.equal(m.msg.timeoutMs, 120_000);
  assert.equal(m.msg.expiresAt, 1_900_000_000_000);
  assert.equal(isValidEnvelope(approvalRequest("req-2", "shell", {}, opts)), true);
});

test("approvalDecision echoes the chosen option", () => {
  const m = approvalDecision("req-1", "allow", { extra: 1 });
  assertEnvelope(m, EVENT_TYPE.DECISION, SUBTYPE.DECISION.APPROVAL_DECISION);
  assert.equal(m.msg.requestId, "req-1");
  assert.equal(m.msg.optionId, "allow");
  assert.deepEqual(m.msg.raw, { extra: 1 });
});

test("approvalComplete carries the requestId and terminating decision", () => {
  const m = approvalComplete("req-1", "stopped");
  assertEnvelope(m, EVENT_TYPE.APPROVAL, SUBTYPE.APPROVAL.COMPLETE);
  assert.equal(m.msg.requestId, "req-1");
  assert.equal(m.msg.decision, "stopped");
});

// ---- control ---------------------------------------------------------------

test("channelUp carries only cwd + title (identity is envelope-stamped)", () => {
  const m = channelUp("/home/me/app", "My Session");
  assertEnvelope(m, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.CHANNEL_UP);
  assert.equal(m.msg.cwd, "/home/me/app");
  assert.equal(m.msg.title, "My Session");
  // sessionId/channelId are NOT in the payload anymore.
  assert.equal(m.msg.sessionId, undefined);
  assert.equal(m.msg.channelId, undefined);
});

test("sessionMeta / channelDown carry their small payloads", () => {
  const meta = sessionMeta("New Title", "/cwd");
  assertEnvelope(meta, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.SESSION_META);
  assert.equal(meta.msg.title, "New Title");
  assert.equal(meta.msg.cwd, "/cwd");

  const down = channelDown("terminal closed");
  assertEnvelope(down, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.CHANNEL_DOWN);
  assert.equal(down.msg.reason, "terminal closed");
});

test("heartbeat carries latestTurnIndex + busy under msg, defaulting to null", () => {
  const h = heartbeat(7, true);
  assertEnvelope(h, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.HEARTBEAT);
  assert.equal(h.msg.latestTurnIndex, 7);
  assert.equal(h.msg.busy, true);
  assert.equal(heartbeat().msg.latestTurnIndex, null);
  assert.equal(heartbeat().msg.busy, null);
  assert.equal(heartbeat(3, false).msg.busy, false);
});

test("deviceHeartbeat carries deviceId under msg, defaulting to null", () => {
  const beat = deviceHeartbeat("device-123");
  assertEnvelope(beat, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.DEVICE_HEARTBEAT);
  assert.equal(beat.msg.deviceId, "device-123");
  assert.equal(deviceHeartbeat().msg.deviceId, null);
});

test("modeChange + interrupt", () => {
  const mc = modeChange("plan");
  assertEnvelope(mc, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.MODE);
  assert.equal(mc.msg.mode, "plan");
  assert.ok(MODES.includes("plan"));

  const it = interrupt();
  assertEnvelope(it, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.INTERRUPT);
  assert.deepEqual(it.msg, {});
});

// ---- history backfill ------------------------------------------------------

test("historyRequest defaults before/since to null and passes limit through", () => {
  const r = historyRequest();
  assertEnvelope(r, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.HISTORY_REQUEST);
  assert.equal(r.msg.before, null);
  assert.equal(r.msg.since, null);
  assert.equal(r.msg.limit, undefined);

  const backward = historyRequest(42, 25);
  assert.equal(backward.msg.before, 42);
  assert.equal(backward.msg.limit, 25);
  assert.equal(backward.msg.since, null);

  const forward = historyRequest(null, 50, 12);
  assert.equal(forward.msg.before, null);
  assert.equal(forward.msg.since, 12);
  assert.equal(forward.msg.limit, 50);
});

test("history carries items + pagination cursor + forward `since`", () => {
  const items = [{ turnIndex: 0, role: "user", text: "hi", ts: 1 }];
  const h = history(items, 7, true);
  assertEnvelope(h, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.HISTORY);
  assert.deepEqual(h.msg.items, items);
  assert.equal(h.msg.nextCursor, 7);
  assert.equal(h.msg.hasMore, true);
  assert.equal(h.msg.since, null);

  const empty = history([]);
  assert.equal(empty.msg.nextCursor, null);
  assert.equal(empty.msg.hasMore, false);

  const fwd = history(items, 13, false, 12);
  assert.equal(fwd.msg.since, 12);
});

// ---- state snapshot --------------------------------------------------------

test("stateRequest is a bare control request", () => {
  const r = stateRequest();
  assertEnvelope(r, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.STATE_REQUEST);
  assert.deepEqual(r.msg, {});
});

test("stateSnapshot coerces flags and defaults its pending lists under msg", () => {
  const empty = stateSnapshot();
  assertEnvelope(empty, EVENT_TYPE.CONTROL, SUBTYPE.CONTROL.STATE_SNAPSHOT);
  assert.equal(empty.msg.busy, false);
  assert.equal(empty.msg.abortable, false);
  assert.equal(empty.msg.mode, null);
  assert.equal(empty.msg.latestTurnIndex, null);
  assert.deepEqual(empty.msg.approvals, []);
  assert.deepEqual(empty.msg.elicitations, []);

  const full = stateSnapshot({
    busy: 1,
    abortable: 1,
    mode: "plan",
    latestTurnIndex: 9,
    approvals: [{ requestId: "a" }],
    elicitations: [{ requestId: "e" }],
  });
  assert.equal(full.msg.busy, true);
  assert.equal(full.msg.abortable, true);
  assert.equal(full.msg.mode, "plan");
  assert.equal(full.msg.latestTurnIndex, 9);
  assert.equal(full.msg.approvals.length, 1);
  assert.equal(full.msg.elicitations.length, 1);
});

// ---- elicitation / ask_user (#64) ------------------------------------------

test("elicitationRequest carries message, mode, schema and tool linkage under msg", () => {
  const schema = { type: "object", properties: { env: { type: "string" } }, required: ["env"] };
  const m = elicitationRequest("req-1", "Where to?", "form", schema, "tc-1");
  assertEnvelope(m, EVENT_TYPE.ELICITATION, SUBTYPE.ELICITATION.REQUEST);
  assert.equal(m.msg.requestId, "req-1");
  assert.equal(m.msg.message, "Where to?");
  assert.equal(m.msg.mode, "form");
  assert.deepEqual(m.msg.requestedSchema, schema);
  assert.equal(m.msg.toolCallId, "tc-1");

  assert.equal(elicitationRequest("req-2", "hi").msg.mode, "form"); // default mode
});

test("elicitationResponse only keeps content on accept", () => {
  const ok = elicitationResponse("req-1", "accept", { env: "staging" });
  assertEnvelope(ok, EVENT_TYPE.ELICITATION_RESPONSE, SUBTYPE.ELICITATION_RESPONSE.RESPONSE);
  assert.equal(ok.msg.action, "accept");
  assert.deepEqual(ok.msg.content, { env: "staging" });

  const declined = elicitationResponse("req-1", "decline", { env: "staging" });
  assert.equal(declined.msg.action, "decline");
  assert.equal(declined.msg.content, undefined);
});

test("elicitationComplete records the terminating action", () => {
  const m = elicitationComplete("req-1", "cancel");
  assertEnvelope(m, EVENT_TYPE.ELICITATION, SUBTYPE.ELICITATION.COMPLETE);
  assert.equal(m.msg.requestId, "req-1");
  assert.equal(m.msg.action, "cancel");
});

// ---- validation ------------------------------------------------------------

test("isValidEnvelope accepts every factory and rejects malformed input", () => {
  const valid = [
    assistantMessage("a"),
    assistantDelta("b"),
    toolStart("c", "t"),
    toolComplete("c", "t", true),
    logLine("info", "x"),
    activity(true),
    userMessage("u"),
    prompt("p"),
    approvalRequest("r", "t", {}, []),
    approvalDecision("r", "o"),
    approvalComplete("r", "timeout"),
    channelUp("/cwd", "T"),
    sessionMeta("T"),
    channelDown("bye"),
    heartbeat(3),
    modeChange("plan"),
    interrupt(),
    historyRequest(),
    history([]),
    stateRequest(),
    stateSnapshot(),
    elicitationRequest("r", "m", "form", { type: "object", properties: {} }),
    elicitationResponse("r", "accept", { a: 1 }),
    elicitationComplete("r", "accept"),
  ];
  for (const env of valid) assert.ok(isValidEnvelope(env), `${env.eventType}/${env.eventSubtype}`);

  assert.equal(isValidEnvelope(null), false);
  assert.equal(isValidEnvelope({}), false);
  assert.equal(isValidEnvelope({ eventType: "stream" }), false); // no subtype/ts/msg
  assert.equal(isValidEnvelope({ eventType: "stream", eventSubtype: "x", ts: 1 }), false); // no msg
});

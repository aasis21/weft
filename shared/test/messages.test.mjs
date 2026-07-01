// Unit tests for the new protocol factories + routing (shared/messages.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVENTS,
  KIND,
  userMessage,
  historyRequest,
  history,
  heartbeat,
  stateRequest,
  stateSnapshot,
  activity,
  elicitationRequest,
  elicitationResponse,
  elicitationComplete,
  eventForKind,
  isValidInner,
} from "../messages.mjs";

test("userMessage factory defaults origin to terminal and carries id/text", () => {
  const m = userMessage("hello laptop", "terminal", "evt-1");
  assert.equal(m.kind, KIND.USER_MESSAGE);
  assert.equal(m.text, "hello laptop");
  assert.equal(m.origin, "terminal");
  assert.equal(m.id, "evt-1");
  assert.equal(typeof m.ts, "number");

  const d = userMessage("from phone");
  assert.equal(d.origin, "terminal"); // explicit default
});

test("userMessage can be tagged as phone origin", () => {
  const m = userMessage("typed on phone", "phone", "evt-2");
  assert.equal(m.origin, "phone");
});

test("historyRequest defaults before=null and passes limit through", () => {
  const r = historyRequest();
  assert.equal(r.kind, KIND.HISTORY_REQUEST);
  assert.equal(r.before, null);
  assert.equal(r.limit, undefined);

  const r2 = historyRequest(42, 25);
  assert.equal(r2.before, 42);
  assert.equal(r2.limit, 25);
});

test("historyRequest carries a forward `since` cursor, defaulting to null", () => {
  const fwd = historyRequest(null, 50, 12);
  assert.equal(fwd.kind, KIND.HISTORY_REQUEST);
  assert.equal(fwd.before, null);
  assert.equal(fwd.since, 12);
  assert.equal(fwd.limit, 50);
  // Existing latest/backward callers are unaffected (since stays null).
  assert.equal(historyRequest().since, null);
  assert.equal(historyRequest(42, 25).since, null);
});

test("heartbeat carries an optional latestTurnIndex forward cursor and busy flag", () => {
  const h = heartbeat(7, true);
  assert.equal(h.kind, KIND.HEARTBEAT);
  assert.equal(h.latestTurnIndex, 7);
  assert.equal(h.busy, true);
  assert.equal(typeof h.ts, "number");
  assert.equal(heartbeat().latestTurnIndex, null); // default when unknown
  assert.equal(heartbeat().busy, null); // default when unknown
  assert.equal(heartbeat(3, false).busy, false);
});

test("stateRequest is a bare control request", () => {
  const r = stateRequest();
  assert.equal(r.kind, KIND.STATE_REQUEST);
  assert.equal(typeof r.ts, "number");
});

test("stateSnapshot coerces flags and defaults its pending lists", () => {
  const empty = stateSnapshot();
  assert.equal(empty.kind, KIND.STATE_SNAPSHOT);
  assert.equal(empty.busy, false);
  assert.equal(empty.abortable, false);
  assert.equal(empty.mode, null);
  assert.equal(empty.latestTurnIndex, null);
  assert.deepEqual(empty.approvals, []);
  assert.deepEqual(empty.elicitations, []);

  const full = stateSnapshot({
    busy: 1,
    abortable: 1,
    mode: "plan",
    latestTurnIndex: 9,
    approvals: [{ requestId: "a" }],
    elicitations: [{ requestId: "e" }],
  });
  assert.equal(full.busy, true); // coerced from truthy
  assert.equal(full.abortable, true);
  assert.equal(full.mode, "plan");
  assert.equal(full.latestTurnIndex, 9);
  assert.equal(full.approvals.length, 1);
  assert.equal(full.elicitations.length, 1);
});

test("eventForKind routes the state kinds to CONTROL, and they pass isValidInner", () => {
  assert.equal(eventForKind(KIND.STATE_REQUEST), EVENTS.CONTROL);
  assert.equal(eventForKind(KIND.STATE_SNAPSHOT), EVENTS.CONTROL);
  assert.ok(isValidInner(stateRequest()));
  assert.ok(isValidInner(stateSnapshot()));
  assert.ok(isValidInner(heartbeat(3)));
});

test("history factory carries items + pagination cursor", () => {
  const items = [{ turnIndex: 0, role: "user", text: "hi", ts: 1 }];
  const h = history(items, 7, true);
  assert.equal(h.kind, KIND.HISTORY);
  assert.deepEqual(h.items, items);
  assert.equal(h.nextCursor, 7);
  assert.equal(h.hasMore, true);

  const empty = history([]);
  assert.equal(empty.nextCursor, null);
  assert.equal(empty.hasMore, false);
});

test("activity factory coerces busy to a boolean and routes to STREAM", () => {
  const on = activity(true);
  assert.equal(on.kind, KIND.ACTIVITY);
  assert.equal(on.busy, true);
  assert.equal(typeof on.ts, "number");
  assert.equal(activity(0).busy, false); // coerced
  assert.equal(eventForKind(KIND.ACTIVITY), EVENTS.STREAM);
});

test("eventForKind routes user_message to STREAM and history kinds to CONTROL", () => {
  assert.equal(eventForKind(KIND.USER_MESSAGE), EVENTS.STREAM);
  assert.equal(eventForKind(KIND.HISTORY_REQUEST), EVENTS.CONTROL);
  assert.equal(eventForKind(KIND.HISTORY), EVENTS.CONTROL);
});

test("eventForKind still throws for unknown kinds", () => {
  assert.throws(() => eventForKind("nope"), /unknown kind/);
});

test("the new factories pass isValidInner", () => {
  assert.ok(isValidInner(userMessage("a")));
  assert.ok(isValidInner(historyRequest()));
  assert.ok(isValidInner(history([])));
  assert.ok(isValidInner(activity(true)));
});

// ---- ask_user / elicitation (#64) ------------------------------------------

test("elicitationRequest carries the message, mode, schema and tool linkage", () => {
  const schema = { type: "object", properties: { env: { type: "string" } }, required: ["env"] };
  const m = elicitationRequest("req-1", "Where to?", "form", schema, "tc-1");
  assert.equal(m.kind, KIND.ELICITATION_REQUEST);
  assert.equal(m.requestId, "req-1");
  assert.equal(m.message, "Where to?");
  assert.equal(m.mode, "form");
  assert.deepEqual(m.requestedSchema, schema);
  assert.equal(m.toolCallId, "tc-1");
  assert.equal(typeof m.ts, "number");

  const d = elicitationRequest("req-2", "hi");
  assert.equal(d.mode, "form"); // default mode
});

test("elicitationResponse only keeps content on accept", () => {
  const ok = elicitationResponse("req-1", "accept", { env: "staging" });
  assert.equal(ok.kind, KIND.ELICITATION_RESPONSE);
  assert.equal(ok.action, "accept");
  assert.deepEqual(ok.content, { env: "staging" });

  const declined = elicitationResponse("req-1", "decline", { env: "staging" });
  assert.equal(declined.action, "decline");
  assert.equal(declined.content, undefined); // content dropped when not accepting
});

test("elicitationComplete records the terminating action", () => {
  const m = elicitationComplete("req-1", "cancel");
  assert.equal(m.kind, KIND.ELICITATION_COMPLETE);
  assert.equal(m.requestId, "req-1");
  assert.equal(m.action, "cancel");
});

test("eventForKind routes elicitation kinds to their phone/ext channels", () => {
  assert.equal(eventForKind(KIND.ELICITATION_REQUEST), EVENTS.ELICITATION);
  assert.equal(eventForKind(KIND.ELICITATION_COMPLETE), EVENTS.ELICITATION);
  assert.equal(eventForKind(KIND.ELICITATION_RESPONSE), EVENTS.ELICITATION_RESPONSE);
});

test("the elicitation factories pass isValidInner", () => {
  assert.ok(isValidInner(elicitationRequest("r", "m", "form", { type: "object", properties: {} })));
  assert.ok(isValidInner(elicitationResponse("r", "accept", { a: 1 })));
  assert.ok(isValidInner(elicitationComplete("r", "accept")));
});

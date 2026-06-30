// Unit tests for the new protocol factories + routing (shared/messages.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EVENTS,
  KIND,
  userMessage,
  historyRequest,
  history,
  activity,
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

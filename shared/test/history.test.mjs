// Unit tests for the pure history helpers (shared/history.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  HISTORY_TEXT_CLIP,
  historyItemId,
  clipText,
  compareHistory,
  mergeHistory,
} from "../history.mjs";

const item = (turnIndex, role, text = "x", ts = 0) => ({ turnIndex, role, text, ts });

test("constants are sane", () => {
  assert.equal(HISTORY_PAGE_DEFAULT, 50);
  assert.equal(HISTORY_PAGE_MAX, 50);
  assert.equal(HISTORY_TEXT_CLIP, 4000);
});

test("historyItemId is stable and distinguishes role within a turn", () => {
  assert.equal(historyItemId(item(3, "user")), "3:user");
  assert.equal(historyItemId(item(3, "assistant")), "3:assistant");
  assert.notEqual(historyItemId(item(3, "user")), historyItemId(item(3, "assistant")));
});

test("clipText truncates with an ellipsis only when over the limit", () => {
  assert.equal(clipText("short", 10), "short");
  assert.equal(clipText("abcdef", 3), "abc…");
  assert.equal(clipText("abc", 3), "abc");
  assert.equal(clipText(undefined), "");
  assert.equal(clipText(null), "");
});

test("compareHistory orders ascending by turn, user before assistant", () => {
  assert.ok(compareHistory(item(1, "user"), item(2, "user")) < 0);
  assert.ok(compareHistory(item(2, "user"), item(1, "user")) > 0);
  assert.ok(compareHistory(item(1, "user"), item(1, "assistant")) < 0);
  assert.ok(compareHistory(item(1, "assistant"), item(1, "user")) > 0);
  assert.equal(compareHistory(item(1, "user"), item(1, "user")), 0);
});

test("mergeHistory dedups by id, keeps ascending order, lets incoming win", () => {
  const existing = [item(2, "user", "u2"), item(2, "assistant", "a2")];
  const incoming = [
    item(1, "user", "u1"),
    item(1, "assistant", "a1"),
    item(2, "assistant", "a2-new"), // overlaps existing -> incoming wins
  ];
  const merged = mergeHistory(existing, incoming);
  assert.deepEqual(
    merged.map(historyItemId),
    ["1:user", "1:assistant", "2:user", "2:assistant"]
  );
  assert.equal(merged.find((i) => historyItemId(i) === "2:assistant").text, "a2-new");
});

test("mergeHistory handles empty / missing inputs", () => {
  assert.deepEqual(mergeHistory(), []);
  assert.deepEqual(mergeHistory([item(1, "user")]).map(historyItemId), ["1:user"]);
  assert.deepEqual(
    mergeHistory(undefined, [item(5, "assistant")]).map(historyItemId),
    ["5:assistant"]
  );
});

test("mergeHistory is idempotent when merging the same page twice", () => {
  const page = [item(1, "user"), item(1, "assistant")];
  const once = mergeHistory([], page);
  const twice = mergeHistory(once, page);
  assert.deepEqual(once.map(historyItemId), twice.map(historyItemId));
  assert.equal(twice.length, 2);
});

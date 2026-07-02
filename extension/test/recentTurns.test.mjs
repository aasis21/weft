// SPDX-License-Identifier: Apache-2.0
// Tests for the in-memory recent-turns buffer (extension/src/recentTurns.mjs).
// The buffer captures assistant text LIVE (the CLI store NULLs it for long turns) and serves the last
// N turns to a connecting phone. Pure + injectable clock, so these are plain unit tests.

import { test } from "node:test";
import assert from "node:assert/strict";

import { createRecentTurns } from "../src/recentTurns.mjs";

test("records user/assistant entries in chronological order", () => {
  const buf = createRecentTurns();
  buf.recordUser("hi", 100, "u1");
  buf.recordAssistant("hello", 200, "a1");
  assert.deepEqual(buf.snapshot(), [
    { role: "user", text: "hi", ts: 100, id: "u1" },
    { role: "assistant", text: "hello", ts: 200, id: "a1" },
  ]);
});

test("recordAssistant replaces the last entry when the id matches (delta -> final)", () => {
  const buf = createRecentTurns();
  buf.recordUser("q", 1, "u1");
  buf.recordAssistant("partial", 2, "a1");
  buf.recordAssistant("partial and final", 3, "a1"); // same id -> replace, not append
  assert.equal(buf.size, 2);
  assert.deepEqual(buf.snapshot().at(-1), { role: "assistant", text: "partial and final", ts: 3, id: "a1" });
});

test("recordAssistant appends a new bubble when the id differs", () => {
  const buf = createRecentTurns();
  buf.recordUser("q", 1, "u1");
  buf.recordAssistant("first", 2, "a1");
  buf.recordAssistant("second", 3, "a2");
  assert.equal(buf.size, 3);
  assert.deepEqual(
    buf.snapshot().map((e) => e.text),
    ["q", "first", "second"],
  );
});

test("ignores blank text and trims", () => {
  const buf = createRecentTurns();
  buf.recordUser("   ", 1, "u1");
  buf.recordAssistant("", 2, "a1");
  buf.recordUser("  spaced  ", 3, "u2");
  assert.equal(buf.size, 1);
  assert.deepEqual(buf.snapshot()[0], { role: "user", text: "spaced", ts: 3, id: "u2" });
});

test("caps to the last `max` TURNS (a user message starts a turn)", () => {
  const buf = createRecentTurns({ max: 2 });
  for (let i = 1; i <= 4; i++) {
    buf.recordUser(`u${i}`, i * 10, `u${i}`);
    buf.recordAssistant(`a${i}`, i * 10 + 1, `a${i}`);
  }
  // Only the last 2 turns survive.
  assert.deepEqual(
    buf.snapshot().map((e) => e.text),
    ["u3", "a3", "u4", "a4"],
  );
});

test("snapshot(limit) returns only the last N turns, ascending", () => {
  const buf = createRecentTurns();
  for (let i = 1; i <= 3; i++) {
    buf.recordUser(`u${i}`, i * 10, `u${i}`);
    buf.recordAssistant(`a${i}`, i * 10 + 1, `a${i}`);
  }
  assert.deepEqual(
    buf.snapshot(1).map((e) => e.text),
    ["u3", "a3"],
  );
  assert.deepEqual(
    buf.snapshot(2).map((e) => e.text),
    ["u2", "a2", "u3", "a3"],
  );
});

test("snapshot returns defensive copies (mutation does not corrupt the buffer)", () => {
  const buf = createRecentTurns();
  buf.recordUser("hi", 1, "u1");
  const snap = buf.snapshot();
  snap[0].text = "mutated";
  assert.equal(buf.snapshot()[0].text, "hi");
});

test("seed primes the buffer only when empty", () => {
  const buf = createRecentTurns();
  buf.seed([
    { role: "user", text: "seeded q", ts: 5, turnIndex: 1 },
    { role: "assistant", text: "seeded a", ts: 6, turnIndex: 1 },
  ]);
  assert.deepEqual(
    buf.snapshot().map((e) => e.text),
    ["seeded q", "seeded a"],
  );
  assert.deepEqual(
    buf.snapshot().map((e) => e.id),
    ["seed-1-user", "seed-1-assistant"],
  );

  // A second seed is a no-op once live turns exist.
  buf.recordUser("live q", 10, "u1");
  buf.seed([{ role: "user", text: "should be ignored", ts: 11, turnIndex: 2 }]);
  assert.ok(!buf.snapshot().some((e) => e.text === "should be ignored"));
});

test("falls back to the injected clock when ts is missing", () => {
  let clock = 4242;
  const buf = createRecentTurns({ now: () => clock });
  buf.recordUser("no ts", undefined, "u1");
  assert.equal(buf.snapshot()[0].ts, 4242);
});

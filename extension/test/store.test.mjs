// SPDX-License-Identifier: Apache-2.0
// Tests for the read-only CLI session-store reader (extension/src/store.mjs).
// We build a temporary SQLite DB matching the CLI's `turns`/`sessions` schema,
// populate it writably, then exercise the read-only readHistory/readSummary paths.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHistory, readSummary } from "../src/store.mjs";

const SESSION = "sess-1";
let dir;
let dbPath;

const iso = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  dir = mkdtempSync(join(tmpdir(), "helm-store-"));
  dbPath = join(dir, "session-store.db");
  const db = new DatabaseSync(dbPath); // writable for setup
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, summary TEXT, cwd TEXT);" +
      "CREATE TABLE turns (id INTEGER PRIMARY KEY, session_id TEXT, turn_index INTEGER, " +
      "user_message TEXT, assistant_response TEXT, timestamp TEXT);"
  );
  db.prepare("INSERT INTO sessions (id, summary, cwd) VALUES (?, ?, ?)").run(
    SESSION,
    "My Chat Title",
    "/repo"
  );
  const ins = db.prepare(
    "INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)"
  );
  // 4 complete turns + a 5th in-flight turn (NULL assistant_response).
  ins.run(SESSION, 0, "u0", "a0", iso(0));
  ins.run(SESSION, 1, "u1", "a1", iso(1));
  ins.run(SESSION, 2, "u2", "a2", iso(2));
  ins.run(SESSION, 3, "u3", "a3", iso(3));
  ins.run(SESSION, 4, "u4", null, iso(4));
  // A second session to prove isolation by session_id.
  ins.run("other", 0, "other-u", "other-a", iso(0));
  db.close();
});

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("readSummary returns the session's title", async () => {
  assert.equal(await readSummary(SESSION, dbPath), "My Chat Title");
  assert.equal(await readSummary("nope", dbPath), "");
  assert.equal(await readSummary("", dbPath), "");
});

test("readHistory returns ascending items, skips the in-flight NULL assistant", async () => {
  const { items, nextCursor, hasMore } = await readHistory(SESSION, {}, dbPath);
  // turns 0..4: each complete turn -> user+assistant; turn 4 -> user only.
  assert.equal(items.length, 9);
  assert.deepEqual(
    items.map((i) => `${i.turnIndex}:${i.role}`),
    ["0:user", "0:assistant", "1:user", "1:assistant", "2:user", "2:assistant", "3:user", "3:assistant", "4:user"]
  );
  assert.equal(items.find((i) => i.turnIndex === 4 && i.role === "assistant"), undefined);
  assert.equal(hasMore, false);
  assert.equal(nextCursor, null);
});

test("readHistory parses ISO timestamps to epoch ms", async () => {
  const { items } = await readHistory(SESSION, {}, dbPath);
  assert.equal(items[0].ts, Date.parse(iso(0)));
  assert.ok(Number.isInteger(items[0].ts));
});

test("readHistory paginates newest-first by turn with a cursor", async () => {
  // Latest page of 2 turns => turns 3 and 4 (in source-ascending order within the page).
  const page1 = await readHistory(SESSION, { limit: 2 }, dbPath);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextCursor, 3); // oldest turn_index in the page
  assert.deepEqual(
    page1.items.map((i) => `${i.turnIndex}:${i.role}`),
    ["3:user", "3:assistant", "4:user"]
  );

  // Next older page: turns < 3, limit 2 => turns 1 and 2.
  const page2 = await readHistory(SESSION, { before: page1.nextCursor, limit: 2 }, dbPath);
  assert.equal(page2.hasMore, true);
  assert.equal(page2.nextCursor, 1);
  assert.deepEqual(
    page2.items.map((i) => i.turnIndex),
    [1, 1, 2, 2]
  );

  // Oldest page: turns < 1 => just turn 0, no more.
  const page3 = await readHistory(SESSION, { before: page2.nextCursor, limit: 2 }, dbPath);
  assert.equal(page3.hasMore, false);
  assert.equal(page3.nextCursor, null);
  assert.deepEqual(page3.items.map((i) => i.turnIndex), [0, 0]);
});

test("readHistory isolates by session and clamps the limit", async () => {
  const other = await readHistory("other", {}, dbPath);
  assert.deepEqual(other.items.map((i) => i.role), ["user", "assistant"]);

  // A huge requested limit is clamped to HISTORY_PAGE_MAX (50) — still returns all 9 here.
  const big = await readHistory(SESSION, { limit: 100000 }, dbPath);
  assert.equal(big.items.length, 9);
  assert.equal(big.hasMore, false);
});

test("readHistory clips long messages", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(dbPath);
  db.prepare(
    "INSERT INTO turns (session_id, turn_index, user_message, assistant_response, timestamp) VALUES (?, ?, ?, ?, ?)"
  ).run("long", 0, "x".repeat(9000), "y".repeat(9000), iso(0));
  db.close();

  const { items } = await readHistory("long", {}, dbPath);
  for (const it of items) {
    assert.ok(it.text.length <= 4001, `clipped to ~4000 (+ellipsis), got ${it.text.length}`);
    assert.ok(it.text.endsWith("…"));
  }
});

test("readHistory returns an empty page for unknown session or missing db", async () => {
  assert.deepEqual(await readHistory("", {}, dbPath), {
    items: [],
    nextCursor: null,
    hasMore: false,
  });
  const missing = await readHistory(SESSION, {}, join(dir, "nope.db"));
  assert.deepEqual(missing, { items: [], nextCursor: null, hasMore: false });
});

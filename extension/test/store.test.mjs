// SPDX-License-Identifier: Apache-2.0
// Tests for the read-only CLI session-store reader (extension/src/store.mjs).
// We build a temporary SQLite DB matching the CLI's `turns`/`sessions` schema,
// populate it writably, then exercise the read-only readHistory/readSummary paths.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { listSessions, readHistory, readLatestTurnIndex, readSessionCwd, readSummary } from "../src/store.mjs";

const SESSION = "sess-1";
let dir;
let dbPath;

const iso = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  dir = mkdtempSync(join(tmpdir(), "weft-store-"));
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

test("readHistory forward catch-up returns turns newer than `since`, ascending", async () => {
  // Everything after turn 1: turns 2,3 (complete) + turn 4 (user only, in-flight).
  const page = await readHistory(SESSION, { since: 1 }, dbPath);
  assert.deepEqual(
    page.items.map((i) => `${i.turnIndex}:${i.role}`),
    ["2:user", "2:assistant", "3:user", "3:assistant", "4:user"]
  );
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test("readHistory forward paginates by highest turn_index and takes precedence over before", async () => {
  // since=0, limit 2 => turns 1,2; nextCursor = highest turn in page (2), more remain.
  const p1 = await readHistory(SESSION, { since: 0, before: 3, limit: 2 }, dbPath);
  assert.equal(p1.hasMore, true);
  assert.equal(p1.nextCursor, 2); // newest turn_index in the forward page, not the oldest
  assert.deepEqual(p1.items.map((i) => i.turnIndex), [1, 1, 2, 2]);

  // Continue forward from 2 => turns 3,4; turn 4 has no assistant; nothing newer remains.
  const p2 = await readHistory(SESSION, { since: p1.nextCursor, limit: 2 }, dbPath);
  assert.equal(p2.hasMore, false);
  assert.equal(p2.nextCursor, null);
  assert.deepEqual(
    p2.items.map((i) => `${i.turnIndex}:${i.role}`),
    ["3:user", "3:assistant", "4:user"]
  );
});

test("readHistory forward beyond the latest turn is an empty page", async () => {
  const page = await readHistory(SESSION, { since: 99 }, dbPath);
  assert.deepEqual(page.items, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextCursor, null);
});

test("readLatestTurnIndex returns the max turn_index, null for unknown/empty/missing", async () => {
  assert.equal(await readLatestTurnIndex(SESSION, dbPath), 4);
  assert.equal(await readLatestTurnIndex("other", dbPath), 0);
  assert.equal(await readLatestTurnIndex("nope", dbPath), null);
  assert.equal(await readLatestTurnIndex("", dbPath), null);
  assert.equal(await readLatestTurnIndex(SESSION, join(dir, "nope.db")), null);
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

// ---- listSessions / readSessionCwd (the "Resume a session" list) -----------
// These need the fuller `sessions` schema (repository/branch/updated_at) plus real on-disk cwds,
// so they build a dedicated DB rather than reusing the minimal one above.
let sdir;
let sdbPath;
let liveCwdA;
let liveCwdB;

before(async () => {
  const { DatabaseSync } = await import("node:sqlite");
  sdir = mkdtempSync(join(tmpdir(), "weft-store-sessions-"));
  sdbPath = join(sdir, "session-store.db");
  liveCwdA = mkdtempSync(join(tmpdir(), "weft-live-cwd-a-"));
  liveCwdB = mkdtempSync(join(tmpdir(), "weft-live-cwd-b-"));
  const deletedCwd = join(sdir, "gone"); // never created -> should be filtered out
  const db = new DatabaseSync(sdbPath);
  db.exec(
    "CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, repository TEXT, branch TEXT, " +
      "summary TEXT, created_at TEXT, updated_at TEXT);",
  );
  const ins = db.prepare(
    "INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  // Newest updated_at first once sorted: B (t=3) then A (t=1). "gone" (t=2) is filtered by cwd.
  ins.run("sid-a", liveCwdA, "repo-a", "main", "Fix the bug", iso(0), iso(1));
  ins.run("sid-gone", deletedCwd, "repo-x", "feat", "Deleted worktree", iso(0), iso(2));
  ins.run("sid-b", liveCwdB, null, null, "", iso(0), iso(3));
  // A row with NULL cwd must be skipped (WHERE cwd IS NOT NULL + defensive filter).
  ins.run("sid-null", null, "repo-y", "x", "No cwd", iso(0), iso(4));
  db.close();
});

after(() => {
  for (const d of [sdir, liveCwdA, liveCwdB]) if (d) rmSync(d, { recursive: true, force: true });
});

test("listSessions returns live-cwd sessions newest-first, filtering deleted/NULL cwds", async () => {
  const sessions = await listSessions({}, sdbPath);
  assert.deepEqual(sessions.map((s) => s.sessionId), ["sid-b", "sid-a"]);
  // sid-b: empty summary -> title falls back to the cwd basename; null repo/branch preserved.
  assert.equal(sessions[0].sessionId, "sid-b");
  assert.equal(sessions[0].title, join(liveCwdB).split(/[\\/]/).pop());
  assert.equal(sessions[0].repository, null);
  assert.equal(sessions[0].branch, null);
  assert.equal(sessions[0].updatedAt, Date.parse(iso(3)));
  // sid-a: full metadata.
  assert.deepEqual(sessions[1], {
    sessionId: "sid-a",
    title: "Fix the bug",
    cwd: liveCwdA,
    repository: "repo-a",
    branch: "main",
    updatedAt: Date.parse(iso(1)),
  });
});

test("listSessions clamps the limit and degrades to [] on a missing db", async () => {
  const capped = await listSessions({ limit: 1 }, sdbPath);
  assert.equal(capped.length, 1);
  assert.equal(capped[0].sessionId, "sid-b", "newest survives the cap");
  assert.deepEqual(await listSessions({}, join(sdir, "nope.db")), []);
});

test("readSessionCwd returns the stored cwd, null for unknown/missing", async () => {
  assert.equal(await readSessionCwd("sid-a", sdbPath), liveCwdA);
  assert.equal(await readSessionCwd("nope", sdbPath), null);
  assert.equal(await readSessionCwd("", sdbPath), null);
  assert.equal(await readSessionCwd("sid-a", join(sdir, "nope.db")), null);
});

// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// sessionLog keeps module-level enabled/logDir/logFile state, so each test loads a FRESH copy of
// the module (cache-busted import) for a clean, independent instance — mirroring stationLog's test.
async function freshSessionLog() {
  return import(`../src/sessionLog.mjs?fresh=${Math.random()}`);
}

let home;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "weft-sessionlog-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("appendSessionLog is a no-op until enableSessionLog is called", async () => {
  const { appendSessionLog } = await freshSessionLog();
  appendSessionLog("should.not.write", { a: 1 });
  assert.equal(existsSync(join(home, "sessions")), false);
});

test("enableSessionLog creates ~/.weft/sessions/<id>.log with an opening marker", async () => {
  const { enableSessionLog } = await freshSessionLog();
  const path = enableSessionLog({ sessionId: "abc-123", baseDir: home });
  assert.equal(path, join(home, "sessions", "abc-123.log"));
  const body = readFileSync(path, "utf8");
  assert.match(body, /session\.log_opened/);
  assert.match(body, /sessionId=abc-123/);
});

test("appendSessionLog writes timestamped, leveled key=value lines", async () => {
  const { enableSessionLog, appendSessionLog } = await freshSessionLog();
  enableSessionLog({ sessionId: "s1", baseDir: home });
  appendSessionLog("device.paired", { phone: "brave otter" });
  appendSessionLog("connection.lost", { reason: "idle" }, { level: "warn" });

  const lines = readFileSync(join(home, "sessions", "s1.log"), "utf8").trim().split("\n");
  const paired = lines.find((l) => l.includes("device.paired"));
  const lost = lines.find((l) => l.includes("connection.lost"));

  assert.match(paired, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+INFO\s+device\.paired/);
  assert.match(paired, /phone="brave otter"/);
  assert.match(lost, /\s+WARN\s+connection\.lost reason=idle/);
});

test("sanitizes an unsafe session id into a filesystem-safe filename", async () => {
  const { enableSessionLog } = await freshSessionLog();
  const path = enableSessionLog({ sessionId: "../../evil id/x", baseDir: home });
  // No path separators or traversal survive — the file stays inside sessions/ (slashes/spaces
  // become "_", dots are safe mid-name, and any leading dots are stripped).
  assert.equal(path, join(home, "sessions", "_.._evil_id_x.log"));
  assert.equal(existsSync(path), true);
});

test("falls back to a pid-based name when the session id is empty", async () => {
  const { enableSessionLog } = await freshSessionLog();
  const path = enableSessionLog({ sessionId: "", baseDir: home });
  assert.equal(path, join(home, "sessions", `session-${process.pid}.log`));
});

test("rotates to <id>.log.1 once the cap is exceeded, then starts fresh", async () => {
  const { enableSessionLog, appendSessionLog } = await freshSessionLog();
  enableSessionLog({ sessionId: "rot", baseDir: home });
  const path = join(home, "sessions", "rot.log");

  writeFileSync(path, "x".repeat(1_000_001));
  appendSessionLog("after.rotation", { n: 1 });

  assert.equal(existsSync(join(home, "sessions", "rot.log.1")), true, "old log moved to backup");
  const fresh = readFileSync(path, "utf8");
  assert.match(fresh, /after\.rotation/);
  assert.equal(fresh.includes("xxxxx"), false);
});

test("prunes old session logs beyond the retention cap on enable", async () => {
  const { enableSessionLog } = await freshSessionLog();
  const dir = join(home, "sessions");
  // Pre-seed 130 stale session logs with increasing mtimes so ordering is deterministic.
  const { mkdirSync } = await import("node:fs");
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 130; i++) {
    const f = join(dir, `old-${String(i).padStart(3, "0")}.log`);
    writeFileSync(f, "stale\n");
    const t = new Date(Date.now() - (130 - i) * 1000); // older files have older mtimes
    utimesSync(f, t, t);
  }
  // Enabling a new session triggers pruning to the newest 100 (plus the new one it creates).
  enableSessionLog({ sessionId: "newest", baseDir: home });
  const remaining = readdirSync(dir).filter((n) => n.endsWith(".log"));
  assert.ok(remaining.length <= 101, `expected <=101 logs after prune, got ${remaining.length}`);
  // The very oldest must have been pruned; the newest pre-seeded ones survive.
  assert.equal(remaining.includes("old-000.log"), false);
  assert.equal(remaining.includes("old-129.log"), true);
  assert.equal(remaining.includes("newest.log"), true);
});

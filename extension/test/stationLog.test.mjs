// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// stationLog keeps module-level enabled/logDir state, so each test loads a FRESH copy of the
// module (cache-busted import) to get a clean, independent instance — otherwise enabling it in
// one test would leak into the next.
async function freshStationLog() {
  return import(`../src/stationLog.mjs?fresh=${Math.random()}`);
}

let home;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "weft-stationlog-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

test("appendStationLog is a no-op until enableStationLog is called", async () => {
  const { appendStationLog } = await freshStationLog();
  appendStationLog("should.not.write", { a: 1 });
  assert.equal(existsSync(join(home, "station.log")), false);
});

test("enableStationLog creates the log and writes an opening marker", async () => {
  const { enableStationLog } = await freshStationLog();
  const path = enableStationLog({ baseDir: home });
  assert.equal(path, join(home, "station.log"));
  const body = readFileSync(path, "utf8");
  assert.match(body, /station\.log_opened/);
});

test("appendStationLog writes timestamped, leveled key=value lines", async () => {
  const { enableStationLog, appendStationLog } = await freshStationLog();
  enableStationLog({ baseDir: home });
  appendStationLog("device.connected", { phone: "private phone name", phase: "waiting for phone" });
  appendStationLog("transport.disconnected", { reason: "idle" }, { level: "warn" });

  const lines = readFileSync(join(home, "station.log"), "utf8").trim().split("\n");
  const connected = lines.find((l) => l.includes("device.connected"));
  const dropped = lines.find((l) => l.includes("transport.disconnected"));

  // ISO timestamp prefix + level.
  assert.match(connected, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+INFO\s+device\.connected/);
  // A value with whitespace is quoted so the line stays single-line/greppable.
  assert.match(connected, /phase="waiting for phone"/);
  assert.ok(!connected.includes("private phone name"));
  assert.match(dropped, /\s+WARN\s+transport\.disconnected reason=idle/);
});

test("rotates to station.log.1 once the cap is exceeded, then starts fresh", async () => {
  const { enableStationLog, appendStationLog } = await freshStationLog();
  enableStationLog({ baseDir: home });
  const path = join(home, "station.log");

  // Push the current log past the ~1MB rotation cap, then one more append triggers the rotation.
  writeFileSync(path, "x".repeat(1_000_001));
  appendStationLog("after.rotation", { n: 1 });

  assert.equal(existsSync(join(home, "station.log.1")), true, "old log moved to backup");
  const fresh = readFileSync(path, "utf8");
  assert.match(fresh, /after\.rotation/);
  assert.ok(fresh.length < 1_000_000, "fresh log started small after rotation");
  // The pre-rotation bytes live in the backup, not the fresh file.
  assert.equal(fresh.includes("xxxxx"), false);
});

test("per-device logging switch disables writes live and preserves existing logs", async () => {
  const { enableStationLog, appendStationLog, readStationDiagnostics } = await freshStationLog();
  const config = join(home, "weft.config.json");
  writeFileSync(config, JSON.stringify({ diagnostics: { enabled: false } }));
  enableStationLog({ baseDir: home });
  appendStationLog("disabled");
  assert.equal(existsSync(join(home, "station.log")), false);
  writeFileSync(config, JSON.stringify({ diagnostics: { enabled: true } }));
  appendStationLog("launch.failed", { code: "TERMINAL_LAUNCH_FAILED", prompt: "private prompt",
    token: "private token", file: "private file", error: "private error details" }, { level: "error" });
  const body = readFileSync(join(home, "station.log"), "utf8");
  assert.match(body, /TERMINAL_LAUNCH_FAILED/);
  assert.ok(!body.includes("private"));
  writeFileSync(config, JSON.stringify({ diagnostics: { enabled: false } }));
  appendStationLog("disabled.again");
  assert.equal(readFileSync(join(home, "station.log"), "utf8"), body);
  assert.equal(readStationDiagnostics({ baseDir: home })[0].event, "launch.failed");
});

test("scoped diagnostics honor the selected home and sanitize older log entries", async () => {
  const { appendStationLog, readStationDiagnostics } = await freshStationLog();
  appendStationLog("session.list.sent", { count: 3, elapsedMs: 120, path: "private folder" }, { baseDir: home });
  assert.equal(readStationDiagnostics({ baseDir: home })[0].fields.count, "3");
  writeFileSync(join(home, "station.log"),
    '2026-01-01T00:00:00.000Z ERROR launch.failed code=ENOENT path="private folder" error="private error"\n' +
    'private-timestamp INFO ignored code=SECRET\n');
  const entries = readStationDiagnostics({ baseDir: home });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].fields, { code: "ENOENT" });
  assert.ok(!JSON.stringify(entries).includes("private"));
});

test("failed rotation reports once and does not grow an oversized diagnostic file", async () => {
  const { enableStationLog, appendStationLog } = await freshStationLog();
  enableStationLog({ baseDir: home });
  const path = join(home, "station.log");
  const body = "x".repeat(1_000_001);
  writeFileSync(path, body);
  mkdirSync(join(home, "station.log.1"));
  const notices = [];
  const original = console.error;
  console.error = (...args) => notices.push(args.join(" "));
  try {
    appendStationLog("blocked.rotation");
    appendStationLog("blocked.rotation");
  } finally {
    console.error = original;
  }
  assert.equal(readFileSync(path, "utf8"), body);
  assert.equal(notices.length, 1);
  assert.match(notices[0], /could not be written/);
});

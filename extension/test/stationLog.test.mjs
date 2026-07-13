// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
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
  appendStationLog("device.connected", { phone: "brave otter" });
  appendStationLog("transport.disconnected", { reason: "idle" }, { level: "warn" });

  const lines = readFileSync(join(home, "station.log"), "utf8").trim().split("\n");
  const connected = lines.find((l) => l.includes("device.connected"));
  const dropped = lines.find((l) => l.includes("transport.disconnected"));

  // ISO timestamp prefix + level.
  assert.match(connected, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s+INFO\s+device\.connected/);
  // A value with whitespace is quoted so the line stays single-line/greppable.
  assert.match(connected, /phone="brave otter"/);
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

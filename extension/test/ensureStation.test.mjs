// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  decideStationAction, ensureStationRunning, cleanupNodePtyBackups, stationSummaryLines,
} from "../src/ensureStation.mjs";

const expected = { version: "0.2.75", installId: "new-install" };

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), "weft-ensure-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test("decideStationAction covers every row of the decision table", () => {
  const decide = (observed) => decideStationAction({ expected, ...observed });
  assert.equal(decide({ state: "ready", version: "0.2.75", installId: "new-install" }).action, "already-running");
  assert.equal(decide({ state: "ready", version: "0.2.75", installId: "new-install" }).label, "Running ✓");
  assert.equal(decide({ state: "waiting-network", version: "0.2.75", installId: "new-install" }).action, "already-running",
    "a Station waiting on the network is not unresponsive");
  const update = decide({ state: "ready", version: "0.2.74", installId: "old-install" });
  assert.deepEqual([update.action, update.reason, update.label], ["replace", "update", "Restart to update (0.2.74 → 0.2.75)"]);
  const other = decide({ state: "ready", version: "0.2.75", installId: "other-install" });
  assert.deepEqual([other.action, other.reason, other.label], ["replace", "different-install", "Repair Station"]);
  assert.equal(decide({ state: "unresponsive", silentMs: 14_999 }).action, "wait");
  assert.equal(decide({ state: "unresponsive", silentMs: 15_000 }).action, "force-restart");
  assert.equal(decide({ state: "unresponsive" }).label, "Repair Station", "UI has no silence measurement and offers repair");
  assert.equal(decide({ state: "crash-looping" }).action, "repair");
  assert.deepEqual(decide({ state: "foreground", pid: 77 }), { action: "foreground", pid: 77, label: "Station runs in a terminal" });
  assert.deepEqual(decide({ state: "stopped" }), { action: "start", label: "Start Station", replaceDefinition: false });
  assert.equal(decide({ state: "stopped", taskInstallId: "old-install" }).replaceDefinition, true);
  assert.equal(decide({ state: "stopping" }).action, "wait");
});

function fakeBackground({ worker, task = { state: "Running", installId: expected.installId }, startStatus }) {
  const calls = [];
  let current = worker;
  return {
    calls,
    background: {
      command: async (role, command) => { calls.push(`${role}.${command}`); return current; },
      task: async (operation) => { calls.push(`task.${operation}`); return task; },
      stop: async (role, _options, { timeoutMs } = {}) => { calls.push(`stop.${role}:${timeoutMs}`); current = null; return { state: "stopped" }; },
      forceStop: async (role) => { calls.push(`forceStop.${role}`); current = null; return { state: "stopped" }; },
      start: async (role, _options, { localTimeoutMs, allowNetworkPending, onProgress }) => {
        calls.push(`start.${role}:${localTimeoutMs}:${allowNetworkPending}`);
        onProgress?.({ state: "starting", stage: "connecting-station" });
        current = startStatus;
        return startStatus;
      },
    },
  };
}

function clock() {
  let now = 1_000_000;
  return { now: () => now, sleep: async (ms) => { now += ms; } };
}

test("A8: update while Station runs older code restarts it on the new version and keeps pairing", async (t) => {
  const baseDir = await home(t);
  const pairing = join(baseDir, "pairing-identity.json");
  await writeFile(pairing, '{"paired":true,"peer":"phone-key"}');
  const { calls, background } = fakeBackground({
    worker: { state: "ready", version: "0.2.74", installId: "old-install", paired: true, startedAt: 1 },
    startStatus: { state: "ready", version: "0.2.75", installId: "new-install", paired: true, connected: true, deviceName: "Laptop", startedAt: 2 },
  });
  const progress = [];
  const result = await ensureStationRunning({
    reason: "update", baseDir, expected, background, crashReport: () => null, readForeground: () => null,
    prepare: async () => calls.push("prepare"), onProgress: (event) => progress.push(event.label), ...clock(),
  });
  assert.deepEqual(calls, ["station.status", "prepare", "stop.station:10000", "start.station:30000:true"]);
  assert.equal(result.outcome, "restarted");
  assert.equal(result.version, "0.2.75");
  assert.equal(result.paired, true);
  assert.equal(result.network, "ready");
  assert.deepEqual(progress, [
    "Checking Station…", "Installed version 0.2.75 · Station running 0.2.74",
    "Restarting Station on 0.2.75 (was 0.2.74)…", "Connecting relay…",
  ]);
  assert.equal(await readFile(pairing, "utf8"), '{"paired":true,"peer":"phone-key"}', "device trust is untouched");
  assert.match(stationSummaryLines(result, { now: 2 + 65_000 }).join("\n"), /restarted on 0\.2\.75 \(was 0\.2\.74\)[\s\S]*Uptime   1m[\s\S]*paired · connected/);
});

test("a task whose worker stays silent for 15 seconds is force-restarted; shorter silence is re-checked", async (t) => {
  const baseDir = await home(t);
  const { calls, background } = fakeBackground({
    worker: null, task: { state: "Running", installId: expected.installId },
    startStatus: { state: "ready", version: "0.2.75", installId: "new-install" },
  });
  const time = clock();
  const started = time.now();
  const result = await ensureStationRunning({
    baseDir, expected, background, crashReport: () => null, readForeground: () => null, ...time,
  });
  assert.ok(time.now() - started >= 15_000, "silence was observed for the full window before acting");
  assert.equal(calls.filter((call) => call === "station.status").length > 2, true);
  assert.deepEqual(calls.slice(-2), ["forceStop.station", "start.station:30000:true"]);
  assert.equal(result.outcome, "repaired");
});

test("a Station from a different installation is replaced; one already running is left alone", async (t) => {
  const baseDir = await home(t);
  const replaced = fakeBackground({
    worker: { state: "ready", version: "0.2.75", installId: "checkout-install" },
    startStatus: { state: "ready", version: "0.2.75", installId: "new-install" },
  });
  const result = await ensureStationRunning({ baseDir, expected, background: replaced.background, crashReport: () => null, ...clock() });
  assert.equal(result.outcome, "restarted");
  assert.deepEqual(replaced.calls.slice(1), ["stop.station:10000", "start.station:30000:true"]);

  const running = fakeBackground({ worker: { state: "ready", version: "0.2.75", installId: "new-install", startedAt: 5, deviceName: "Laptop" } });
  let prepared = false;
  const fast = await ensureStationRunning({
    baseDir, expected, background: running.background, crashReport: () => null, prepare: async () => { prepared = true; }, ...clock(),
  });
  assert.equal(fast.outcome, "already-running");
  assert.deepEqual(running.calls, ["station.status"], "no stop, task change or start");
  assert.equal(prepared, false);
  assert.match(stationSummaryLines(fast)[0], /already running/);
});

test("a foreground Station is replaced only after confirmation; a repeated crash reports the last error and log", async (t) => {
  const baseDir = await home(t);
  const idle = fakeBackground({ worker: null, startStatus: { state: "ready", version: "0.2.75" } });
  await assert.rejects(ensureStationRunning({ baseDir, expected, background: idle.background, readForeground: () => 4321, crashReport: () => null, ...clock() }),
    (error) => error.code === "foreground-owned" && error.pid === 4321);
  assert.ok(!idle.calls.some((call) => call.startsWith("start.")));
  const stopped = [];
  const replaced = await ensureStationRunning({
    baseDir, expected, background: idle.background, readForeground: () => 4321, replaceForeground: true,
    stopForeground: async (pid) => stopped.push(pid), crashReport: () => null, ...clock(),
  });
  assert.deepEqual(stopped, [4321]);
  assert.equal(replaced.outcome, "replaced-foreground");

  const time = clock();
  const crash = { repeated: true, quickCrashesInARow: 6, lastCrashAt: time.now() - 1000, exit: { code: "1" },
    lastError: { name: "Error", message: "listen EADDRINUSE" } };
  const looping = fakeBackground({ worker: null, task: { state: "Running" } });
  looping.background.start = async () => { throw new Error("Weft station did not answer locally within 30 seconds."); };
  await assert.rejects(ensureStationRunning({ baseDir, expected, background: looping.background, readForeground: () => null, crashReport: () => crash, ...time }),
    (error) => error.code === "station-crashing" && /EADDRINUSE/.test(error.message) && error.logPath.startsWith(baseDir));
  assert.ok(looping.calls.includes("stop.station:10000"), "crash loop gets exactly one stop and start");
});

test("leftover node-pty backup folders are removed and folders still in use are reported", async (t) => {
  const dir = await home(t);
  const modules = join(dir, "node_modules");
  for (const name of [".node-pty.1.2.backup", ".node-pty.3.4.backup", "node-pty", ".other.backup"]) await mkdir(join(modules, name), { recursive: true });
  const result = cleanupNodePtyBackups(dir, {
    remove: (path) => {
      if (path.endsWith(".node-pty.3.4.backup")) throw Object.assign(new Error("busy"), { code: "EPERM" });
      return rmSync(path, { recursive: true, force: true });
    },
  });
  assert.deepEqual(result, { removed: [".node-pty.1.2.backup"], remaining: [{ name: ".node-pty.3.4.backup", code: "EPERM" }] });
  assert.deepEqual((await readdir(modules)).sort(), [".node-pty.3.4.backup", ".other.backup", "node-pty"]);
  assert.deepEqual(cleanupNodePtyBackups(join(dir, "missing")), { removed: [], remaining: [] });
});

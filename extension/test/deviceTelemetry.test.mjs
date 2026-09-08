// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDeviceTelemetryCollector, _test } from "../src/deviceTelemetry.mjs";

function fakeOs() {
  let cpuRead = 0;
  return {
    cpus() {
      cpuRead += 1;
      return [{
        times: cpuRead % 2 === 1
          ? { user: 10, nice: 0, sys: 10, idle: 80, irq: 0 }
          : { user: 30, nice: 0, sys: 20, idle: 150, irq: 0 },
      }];
    },
    totalmem: () => 1_000,
    freemem: () => 250,
    uptime: () => 3_600,
  };
}

test("collector returns fresh system metrics and privacy-safe visible applications", async () => {
  let powerShellCalls = 0;
  let cpuSampleMs = null;
  const collector = createDeviceTelemetryCollector({
    platform: "win32",
    now: () => 1_000,
    osApi: fakeOs(),
    wait: async (ms) => {
      cpuSampleMs = ms;
    },
    statfsFn: async () => ({ bsize: 10, blocks: 100, bavail: 25 }),
    execFn: async (_file, args) => {
      powerShellCalls += 1;
      const script = args.at(-1);
      return script.includes("Get-Process")
        ? {
            stdout: JSON.stringify([
              { id: "code", name: "Code", processCount: 2, windowCount: 2, memoryBytes: 400 },
              { id: "msedge", name: "msedge", processCount: 1, windowCount: 1, memoryBytes: 600 },
              { id: "taskmgr", name: "Taskmgr", processCount: 1, windowCount: 1, memoryBytes: 50 },
            ]),
          }
        : { stdout: JSON.stringify({ percent: 78, charging: true }) };
    },
  });

  const snapshot = await collector.collectDeviceSnapshot();

  assert.equal(snapshot.capturedAt, 1_000);
  assert.equal(snapshot.system.cpuPercent, 30);
  assert.equal(snapshot.system.memoryUsedBytes, 750);
  assert.equal(snapshot.system.diskUsedBytes, 750);
  assert.equal(snapshot.system.batteryPercent, 78);
  assert.equal(cpuSampleMs, 500);
  assert.deepEqual(snapshot.apps.map((app) => app.name), ["Microsoft Edge", "Visual Studio Code"]);
  assert.equal("windowTitle" in snapshot.apps[0], false);
  assert.deepEqual(snapshot.issues, []);
  assert.equal(powerShellCalls, 2);
});

test("collector caches application, disk, and battery observations independently", async () => {
  let clock = 1_000;
  let diskCalls = 0;
  let powerShellCalls = 0;
  const collector = createDeviceTelemetryCollector({
    platform: "win32",
    now: () => clock,
    osApi: fakeOs(),
    wait: async () => {},
    statfsFn: async () => {
      diskCalls += 1;
      return { bsize: 10, blocks: 100, bavail: 25 };
    },
    execFn: async (_file, args) => {
      powerShellCalls += 1;
      return args.at(-1).includes("Get-Process")
        ? { stdout: JSON.stringify({ id: "code", name: "Code", processCount: 1, windowCount: 1, memoryBytes: 400 }) }
        : { stdout: "null" };
    },
  });

  const first = await collector.collectDeviceSnapshot();
  clock = 11_000;
  const second = await collector.collectDeviceSnapshot();

  assert.equal(diskCalls, 1);
  assert.equal(powerShellCalls, 2);
  assert.equal(second.observedAt.apps, first.observedAt.apps);
  assert.equal(second.observedAt.disk, first.observedAt.disk);
  assert.equal(second.observedAt.battery, first.observedAt.battery);
});

test("collector reports stable partial-failure codes and keeps available metrics", async () => {
  let diskCalls = 0;
  let powerShellCalls = 0;
  const collector = createDeviceTelemetryCollector({
    platform: "win32",
    now: () => 2_000,
    osApi: fakeOs(),
    wait: async () => {},
    statfsFn: async () => {
      diskCalls += 1;
      throw new Error("C:\\private\\disk");
    },
    execFn: async () => {
      powerShellCalls += 1;
      const error = new Error("secret local failure");
      error.killed = true;
      throw error;
    },
  });

  const snapshot = await collector.collectDeviceSnapshot();

  assert.equal(snapshot.system.cpuPercent, 30);
  assert.equal(snapshot.system.memoryUsedBytes, 750);
  assert.equal(snapshot.system.diskTotalBytes, null);
  assert.deepEqual(snapshot.apps, []);
  assert.deepEqual(snapshot.issues.toSorted((left, right) => left.component.localeCompare(right.component)), [
    { component: "apps", code: "timeout" },
    { component: "battery", code: "timeout" },
    { component: "disk", code: "unavailable" },
  ]);
  assert.equal(JSON.stringify(snapshot).includes("private"), false);
  assert.equal(JSON.stringify(snapshot).includes("secret"), false);

  await collector.collectDeviceSnapshot();
  assert.equal(diskCalls, 1);
  assert.equal(powerShellCalls, 2);
});

test("collector marks visible applications unavailable on unsupported platforms", async () => {
  const collector = createDeviceTelemetryCollector({
    platform: "linux",
    now: () => 3_000,
    osApi: fakeOs(),
    wait: async () => {},
    statfsFn: async () => ({ bsize: 10, blocks: 100, bavail: 25 }),
  });

  const snapshot = await collector.collectDeviceSnapshot();

  assert.deepEqual(snapshot.apps, []);
  assert.equal(snapshot.observedAt.apps, null);
  assert.deepEqual(snapshot.issues, [{ component: "apps", code: "unavailable" }]);
});

test("normalizeApps maps friendly names and excludes Task Manager", () => {
  assert.deepEqual(
    _test.normalizeApps([
      { id: "windowsterminal", name: "WindowsTerminal", processCount: 3, windowCount: 2, memoryBytes: 100 },
      { id: "taskmgr", name: "Taskmgr", processCount: 1, windowCount: 1, memoryBytes: 50 },
    ]),
    [{
      id: "windowsterminal",
      name: "Terminal",
      processCount: 3,
      windowCount: 2,
      memoryBytes: 100,
    }],
  );
});

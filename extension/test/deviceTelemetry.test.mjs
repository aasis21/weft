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
        : { stdout: JSON.stringify({ percent: 78, charging: true, onAcPower: true }) };
    },
  });

  const snapshot = await collector.collectDeviceSnapshot();

  assert.equal(snapshot.capturedAt, 1_000);
  assert.equal(snapshot.system.cpuPercent, 30);
  assert.equal(snapshot.system.memoryUsedBytes, 750);
  assert.equal(snapshot.system.diskUsedBytes, 750);
  assert.equal(snapshot.system.batteryPercent, 78);
  assert.equal(snapshot.system.onAcPower, true);
  assert.equal(snapshot.system.uptimeSeconds, 3_600);
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
  assert.equal(snapshot.system.onAcPower, null);
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

test("power telemetry reads AC independently, including desktops and unknown battery values", async () => {
  for (const power of [
    { percent: null, charging: null, onAcPower: true },
    { percent: 51, charging: false, onAcPower: false },
    { percent: 90, charging: true, onAcPower: true },
    { percent: null, charging: null, onAcPower: null },
    { percent: "", charging: "false", onAcPower: 0 },
  ]) {
    const collector = createDeviceTelemetryCollector({
      platform: "win32", osApi: fakeOs(), wait: async () => {},
      statfsFn: async () => ({ bsize: 10, blocks: 100, bavail: 25 }),
      execFn: async (_file, args, options) => {
        if (args.at(-1).includes("Get-Process")) return { stdout: "[]" };
        assert.ok(args.at(-1).includes("GetSystemPowerStatus"));
        assert.ok(args.at(-1).includes("BatteryLifePercent"));
        assert.ok(args.at(-1).includes("BatteryFlag -band 8"));
        assert.ok(args.at(-1).includes("Win32_Battery"));
        assert.ok(args.at(-1).includes("$null -ne $battery.EstimatedChargeRemaining"));
        assert.equal(options.windowsHide, true);
        assert.equal(options.timeout, 5_000);
        return { stdout: JSON.stringify(power) };
      },
    });
    const { system } = await collector.collectDeviceSnapshot();
    assert.equal(system.batteryPercent, typeof power.percent === "number" ? power.percent : null);
    assert.equal(system.batteryCharging, typeof power.charging === "boolean" ? power.charging : null);
    assert.equal(system.onAcPower, typeof power.onAcPower === "boolean" ? power.onAcPower : null);
    assert.equal(system.uptimeSeconds, 3_600);
  }
});

test("power telemetry retains independent successful fields on partial battery/AC failures and uses the slow cache", async () => {
  let clock = 1_000;
  let powerCalls = 0;
  let power = { percent: 60, charging: false, onAcPower: false };
  const collector = createDeviceTelemetryCollector({
    platform: "win32", now: () => clock, osApi: fakeOs(), wait: async () => {},
    statfsFn: async () => ({ bsize: 10, blocks: 100, bavail: 25 }),
    execFn: async (_file, args) => {
      if (args.at(-1).includes("Get-Process")) return { stdout: "[]" };
      powerCalls++;
      return { stdout: JSON.stringify(power) };
    },
  });
  const first = await collector.collectDeviceSnapshot();
  clock += 60_000;
  power = { batteryUnavailable: true, onAcPower: true };
  const batteryFailed = await collector.collectDeviceSnapshot();
  assert.equal(batteryFailed.system.batteryPercent, 60);
  assert.equal(batteryFailed.system.onAcPower, true);
  assert.equal(batteryFailed.observedAt.battery, first.observedAt.battery);
  assert.deepEqual(batteryFailed.issues, [{ component: "battery", code: "unavailable" }]);
  await collector.collectDeviceSnapshot();
  assert.equal(powerCalls, 2);

  clock += 60_000;
  power = { percent: 80, charging: true, powerUnavailable: true };
  const acFailed = await collector.collectDeviceSnapshot();
  assert.equal(acFailed.system.batteryPercent, 80);
  assert.equal(acFailed.system.onAcPower, true);
  assert.deepEqual(acFailed.issues, [{ component: "battery", code: "unavailable" }]);
});

test("a failing battery provider does not hide independently observed desktop AC power", async () => {
  const collector = createDeviceTelemetryCollector({
    platform: "win32", osApi: fakeOs(), wait: async () => {},
    statfsFn: async () => ({ bsize: 10, blocks: 100, bavail: 25 }),
    execFn: async (_file, args) => ({
      stdout: args.at(-1).includes("Get-Process") ? "[]" : '{"onAcPower":true,"batteryUnavailable":true}',
    }),
  });

  const snapshot = await collector.collectDeviceSnapshot();
  assert.equal(snapshot.system.onAcPower, true);
  assert.equal(snapshot.system.batteryPercent, null);
  assert.equal(snapshot.system.batteryCharging, null);
  assert.deepEqual(snapshot.issues, [{ component: "battery", code: "unavailable" }]);
});

test("macOS power telemetry parses battery states and battery-free desktop AC power without private identifiers", async () => {
  for (const [source, row, percent, charging, onAcPower] of [
    ["Battery Power", "88%; discharging; 3:15 remaining", 88, false, false],
    ["AC Power", "45%; charging; 1:15 remaining", 45, true, true],
    ["AC Power", "100%; charged; 0:00 remaining", 100, false, true],
    ["AC Power", "80%; not charging; 0:00 remaining", 80, false, true],
    ["AC Power", "99%; finishing charge; 0:00 remaining", 99, true, true],
    ["AC Power", null, null, null, true],
  ]) {
    const collector = createDeviceTelemetryCollector({
      platform: "darwin", now: () => 1_000, osApi: fakeOs(), wait: async () => {},
      statfsFn: async () => ({ bsize: 10, blocks: 100, bavail: 25 }),
      execFn: async (file, args, options) => {
        assert.equal(file, "/usr/bin/pmset");
        assert.deepEqual(args, ["-g", "batt"]);
        assert.equal(options.timeout, 5_000);
        assert.equal(options.env.LC_ALL, "C");
        return { stdout: `Now drawing from '${source}'\n${row ? ` -InternalBattery-0 (id=private-id)\t${row}; present: true\n` : ""}` };
      },
    });
    const snapshot = await collector.collectDeviceSnapshot();
    assert.equal(snapshot.system.batteryPercent, percent);
    assert.equal(snapshot.system.batteryCharging, charging);
    assert.equal(snapshot.system.onAcPower, onAcPower);
    assert.equal(snapshot.observedAt.battery, 1_000);
    assert.deepEqual(snapshot.issues, [{ component: "apps", code: "unavailable" }]);
    assert.equal(JSON.stringify(snapshot).includes("private-id"), false);
  }
});

test("macOS power telemetry caches successful observations and preserves them on malformed output or native failure", async () => {
  let clock = 1_000;
  let calls = 0;
  let output = "Now drawing from 'Battery Power'\n -InternalBattery-0\t65%; discharging; 2:00 remaining\n";
  const collector = createDeviceTelemetryCollector({
    platform: "darwin", now: () => clock, osApi: fakeOs(), wait: async () => {},
    statfsFn: async () => ({ bsize: 10, blocks: 100, bavail: 25 }),
    execFn: async () => {
      calls++;
      if (output === null) throw Object.assign(new Error("private failure"), { killed: true });
      return { stdout: output };
    },
  });
  const first = await collector.collectDeviceSnapshot();
  await collector.collectDeviceSnapshot();
  assert.equal(calls, 1);
  for (const malformed of ["private garbage", "Now drawing from 'Battery Power'\n",
    "Now drawing from 'AC Power'\n -InternalBattery-0\t101%; charged;\n", null]) {
    clock += 60_000;
    output = malformed;
    const snapshot = await collector.collectDeviceSnapshot();
    assert.equal(snapshot.system.batteryPercent, 65);
    assert.equal(snapshot.observedAt.battery, first.observedAt.battery);
    assert.ok(snapshot.issues.some((issue) => issue.component === "battery" &&
      issue.code === (malformed === null ? "timeout" : "unavailable")));
    assert.equal(JSON.stringify(snapshot).includes("private"), false);
    const before = calls;
    await collector.collectDeviceSnapshot();
    assert.equal(calls, before);
  }
});

test("native macOS power telemetry reports real AC/battery observations", {
  skip: process.platform !== "darwin" || process.env.WEFT_NATIVE_MACOS_TEST !== "1",
}, async () => {
  const snapshot = await createDeviceTelemetryCollector({ wait: async () => {} }).collectDeviceSnapshot();
  assert.equal(typeof snapshot.system.onAcPower, "boolean");
  assert.notEqual(snapshot.observedAt.battery, null);
  assert.equal(snapshot.issues.some((issue) => issue.component === "battery"), false);
});

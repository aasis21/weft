// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import {
  backgroundTaskScript, backgroundTaskOperation, backgroundTaskName, backgroundSupervisorScript,
  startBackground, stopBackground, createBackgroundControl, backgroundCommand,
  backgroundLaunchAgentPlist, runBackgroundSupervisor,
  describeExitCode, summarizeWorkerError, readWorkerCrashReport, readUnexpectedTaskExit,
  describeWorkerProblem, restartStateFileName, workerFailureFileName,
} from "../src/backgroundLifecycle.mjs";

const options = { baseDir: "C:\\User's files\\Weft", cliPath: "C:\\Weft tools\\weft.mjs", nodePath: "C:\\node\\node.exe" };

test("background tasks are user-scoped, manual, limited, and safely quoted", () => {
  const script = backgroundTaskScript("start", { ...options, role: "station" });
  assert.match(script, /-LogonType Interactive -RunLevel Limited/);
  assert.match(script, /RestartCount 999/);
  assert.match(script, /MultipleInstances IgnoreNew/);
  assert.ok(!script.includes("-Trigger"));
  assert.ok(!script.includes("-AtLogOn"));
  const supervisor = backgroundSupervisorScript({ ...options, role: "station" });
  assert.ok(supervisor.includes("User''s files"));
  assert.ok(supervisor.includes("$workerExitCode -eq 0"));
  assert.ok(supervisor.includes("Start-Sleep -Milliseconds $restartDelayMs"));
  assert.ok(supervisor.includes("$restartDelayInitialMs=1000"));
  assert.ok(supervisor.includes("$restartDelayMaxMs=30000"));
  assert.match(script, /belongs to another identity/);
  assert.match(script, /different installation or an earlier Weft version/);
  assert.ok(script.includes(restartStateFileName("station")) && script.includes(workerFailureFileName("station")),
    "a fresh start clears the previous run's crash information");
  assert.notEqual(backgroundTaskName("station", options), backgroundTaskName("relay", options));
  assert.match(backgroundTaskScript("stop", { ...options, role: "station" }), /Weft did not stop/);
  const status = backgroundTaskScript("status", { ...options, role: "station" });
  assert.match(status, /Get-ScheduledTaskInfo/);
  assert.match(status, /lastResult=\$lastTaskResult/);
});

test("macOS launchd jobs are manually started and keep their job file outside LaunchAgents", () => {
  const plist = backgroundLaunchAgentPlist({
    role: "station", baseDir: "/Users/example/Weft & data",
    cliPath: "/Applications/Weft & Tools/weft.mjs", nodePath: "/opt/node/bin/node",
  });
  assert.match(plist, /<key>RunAtLoad<\/key><false\/>/);
  assert.match(plist, /<key>KeepAlive<\/key><false\/>/);
  assert.match(plist, /Weft &amp; data/);
  assert.match(plist, /Weft &amp; Tools\\weft\.mjs/);
  assert.match(plist, /__background-supervisor/);
  assert.doesNotMatch(plist, /Library\/LaunchAgents/);
});

test("macOS lifecycle operations bootstrap, inspect, and unload the explicit job", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "weft-launchd-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const calls = [];
  let loaded = false;
  let state = "not running";
  const exec = async (executable, args) => {
    assert.equal(executable, "launchctl");
    calls.push(args);
    if (args[0] === "print") {
      if (!loaded) throw Object.assign(new Error("launch service missing"), { stderr: "Could not find service" });
      return { stdout: `state = ${state}\nlast exit code = 0\n` };
    }
    if (args[0] === "bootstrap") { loaded = true; return { stdout: "" }; }
    if (args[0] === "kickstart") { state = "running"; return { stdout: "" }; }
    if (args[0] === "bootout") { loaded = false; state = "not running"; return { stdout: "" }; }
    throw new Error(`Unexpected launchctl operation: ${args[0]}`);
  };
  const macOptions = {
    ...options, role: "station", baseDir, platform: "darwin", uid: 501,
    cliPath: "/Users/example/.copilot/extensions/weft/weft.mjs",
    nodePath: "/opt/homebrew/bin/node",
  };
  const started = await backgroundTaskOperation("start", macOptions, { exec });
  assert.equal(started.state, "Starting");
  assert.deepEqual(calls.map((args) => args[0]), ["print", "bootstrap", "kickstart"]);
  const running = await backgroundTaskOperation("status", macOptions, { exec });
  assert.equal(running.state, "Running");
  const existingStart = await backgroundTaskOperation("start", macOptions, { exec });
  assert.equal(existingStart.state, "Starting");
  assert.equal(calls.filter((args) => args[0] === "kickstart").length, 1);
  const disabled = await backgroundTaskOperation("disable", macOptions, { exec });
  assert.equal(disabled.state, "Disabled");
  assert.ok(existsSync(join(baseDir, "background-station.stop")));
  const stopped = await backgroundTaskOperation("stop", macOptions, { exec });
  assert.equal(stopped.state, "Stopped");
  assert.equal((await backgroundTaskOperation("status", macOptions, { exec })).state, "NotRegistered");
  assert.equal(existsSync(join(baseDir, "background-station.plist")), false);
});

test("macOS supervisor records repeated worker crashes and stops retrying on its marker", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "weft-launchd-supervisor-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const cliPath = join(baseDir, "worker.mjs");
  await writeFile(cliPath, `
    import { existsSync, readFileSync, writeFileSync } from "node:fs";
    import { join } from "node:path";
    const attemptsPath = join(process.argv[4], "attempts");
    const attempts = (existsSync(attemptsPath) ? Number(readFileSync(attemptsPath, "utf8")) : 0) + 1;
    writeFileSync(attemptsPath, String(attempts));
    process.exit(1);
  `);
  let clock = 0;
  const result = await runBackgroundSupervisor("station", baseDir, {
    cliPath, nodePath: process.execPath,
    restartDelayInitialMs: 1, restartDelayMaxMs: 4, now: () => clock,
    sleep: async (ms) => {
      clock += ms;
      const attempts = Number(await readFile(join(baseDir, "attempts"), "utf8"));
      if (attempts === 5) await writeFile(join(baseDir, "background-station.stop"), "stopped");
    },
  });
  assert.equal(result, 0);
  assert.equal(Number(await readFile(join(baseDir, "attempts"), "utf8")), 5);
  const restarts = JSON.parse(await readFile(join(baseDir, restartStateFileName("station")), "utf8"));
  assert.equal(restarts.quickCrashesInARow, 5);
  assert.equal(restarts.lastExitCode, 1);
  assert.ok(restarts.nextRestartAt > restarts.lastCrashAt);
});

test("exit codes and fatal errors are described plainly without stacks, addresses or secrets", () => {
  assert.deepEqual(describeExitCode(-1073741510), { code: "0xC000013A", meaning: describeExitCode(0xC000013A).meaning });
  assert.match(describeExitCode(0xC000013A).meaning, /interrupted or closed/);
  assert.equal(describeExitCode(1).code, "1");
  assert.equal(describeExitCode(null).code, "unknown");
  const error = new TypeError("listener.start is not a function\nsecond line https://private.example/x token=abc");
  error.stack = "TypeError: listener.start is not a function\n    at start (C:\\Users\\me\\private\\weft.mjs:812:17)\n    at main (C:\\x\\y.mjs:1:1)";
  assert.deepEqual(summarizeWorkerError(error), {
    name: "TypeError", code: null, message: "listener.start is not a function", location: "weft.mjs:812",
  });
  const secret = summarizeWorkerError(Object.assign(new Error("connect to https://host.example/a failed, Bearer abc123 token=xyz"), { code: "ECONNRESET" }));
  assert.equal(secret.code, "ECONNRESET");
  assert.ok(!/host\.example|abc123|xyz/.test(secret.message));
});

test("crash reports distinguish repeated quick crashes, one-off crashes, recovery and unexpected task exits", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "weft-crash-report-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const now = 10_000_000;
  const writeRestarts = (fields) => writeFile(join(baseDir, restartStateFileName("station")), JSON.stringify({
    role: "station", totalCrashes: 7, quickCrashesInARow: 6, quickCrashStreakStartedAt: now - 60_000,
    lastExitCode: 1, lastCrashAt: now - 5_000, lastRunSeconds: 2.1, nextRestartAt: now + 25_000, ...fields,
  }));
  assert.equal(readWorkerCrashReport("station", { baseDir, now }), null);
  await writeRestarts({});
  await writeFile(join(baseDir, workerFailureFileName("station")), JSON.stringify({
    at: now - 5_200, name: "Error", code: "EADDRINUSE", message: "listen EADDRINUSE: address already in use", location: "listener.mjs:301",
  }));
  const repeated = readWorkerCrashReport("station", { baseDir, now });
  assert.equal(repeated.repeated, true);
  assert.equal(repeated.quickCrashesInARow, 6);
  assert.equal(repeated.lastError.code, "EADDRINUSE");
  assert.match(describeWorkerProblem("station", { crash: repeated }),
    /Station is crashing repeatedly: 6 crashes in a row.*exit code 1.*EADDRINUSE: address already in use \(listener\.mjs:301\)/);

  await writeRestarts({ quickCrashesInARow: 4 });
  assert.equal(readWorkerCrashReport("station", { baseDir, now }).repeated, false);
  assert.equal(readWorkerCrashReport("station", { baseDir, now: now + 3 * 60_000 }), null, "old crash information expires");
  assert.equal(readWorkerCrashReport("station", { baseDir, now: now + 70_000, workerStartedAt: now - 1_000 }), null,
    "a worker that stayed up for a healthy minute is no longer reported");

  assert.equal(readUnexpectedTaskExit("station", { state: "Disabled", lastResult: 1 }, { baseDir }), null);
  assert.equal(readUnexpectedTaskExit("station", { state: "Ready", lastResult: 0x41303 }, { baseDir }), null);
  const stopped = readUnexpectedTaskExit("station", { state: "Ready", lastResult: 3221225786 }, { baseDir });
  assert.equal(stopped.exit.code, "0xC000013A");
  assert.match(describeWorkerProblem("station", { unexpectedStop: stopped }), /stopped unexpectedly \(exit code 0xC000013A/);
});

test("native supervisor records a crash loop and a stop marker ends the retries", {
  skip: process.platform !== "win32", timeout: 60_000,
}, async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "weft-crash-loop-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  const cliPath = join(baseDir, "always-crashes.mjs");
  await writeFile(cliPath, "process.exit(3);\n");
  const supervisor = backgroundSupervisorScript({
    role: "relay", baseDir, cliPath, restartDelayInitialMs: 50, restartDelayMaxMs: 200,
  });
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
    Buffer.from(supervisor, "utf16le").toString("base64")], { windowsHide: true, stdio: "ignore" });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const restartStatePath = join(baseDir, restartStateFileName("relay"));
  let restarts = null;
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (existsSync(restartStatePath)) {
      try { restarts = JSON.parse(await readFile(restartStatePath, "utf8")); } catch { restarts = null; }
      if (restarts?.quickCrashesInARow >= 5) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(restarts?.quickCrashesInARow >= 5, "the supervisor counted quick crashes in a row");
  assert.equal(restarts.lastExitCode, 3);
  assert.ok(restarts.nextRestartAt > restarts.lastCrashAt);
  const report = readWorkerCrashReport("relay", { baseDir });
  assert.equal(report.repeated, true);
  assert.equal(report.exit.code, "3");
  await writeFile(join(baseDir, "background-relay.stop"), "stopped");
  assert.equal(await exited, 0, "the stop marker ends the retry loop cleanly");
});

test("task execution sends an encoded script without a shell argument interpolation", async () => {
  let call;
  await backgroundTaskOperation("start", { ...options, role: "relay" }, {
    exec: async (...args) => { call = args; return { stdout: '{"state":"Starting","taskName":"Weft-relay"}' }; },
  });
  assert.equal(call[0], "powershell.exe");
  assert.ok(call[1].includes("-NonInteractive"));
  assert.equal(Buffer.from(call[1].at(-1), "base64").toString("utf16le"),
    backgroundTaskScript("start", { ...options, role: "relay" }));
});

test("startup waits for authenticated ready state, not merely task registration", async () => {
  let clock = 0;
  let attempts = 0;
  const operations = [];
  const progress = [];
  const result = await startBackground("station", options, {
    now: () => clock, sleep: async (ms) => { clock += ms; },
    taskOperation: async (op) => { operations.push(op); },
    inspect: async () => ++attempts === 3 ? { state: "ready" } : { state: "starting" },
    onProgress: (status) => progress.push(status.state),
  });
  assert.equal(result.state, "ready");
  assert.deepEqual(operations, ["start"]);
  assert.equal(attempts, 3);
  assert.deepEqual(progress, ["starting", "starting", "ready"]);
  await assert.rejects(startBackground("station", options, {
    taskOperation: async () => {}, inspect: async () => ({ state: "failed", error: "Sign in required" }),
  }), /Sign in required/);
});

test("intentional stop disables restart before quiescing, then confirms task stop", async () => {
  const operations = [];
  const result = await stopBackground("relay", options, {
    taskOperation: async (op) => { operations.push(op); },
    quiesce: async () => { operations.push("quiesce"); return { state: "stopping" }; },
    inspect: async () => null,
  });
  assert.deepEqual(operations, ["disable", "quiesce", "stop"]);
  assert.equal(result.graceful, true);
  await assert.rejects(stopBackground("relay", options, {
    taskOperation: async (op) => { if (op === "stop") throw new Error("Could not stop"); },
    quiesce: async () => null,
  }), /Could not stop/);
});

test("background readiness uses the real authenticated local IPC and cleans its registry", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "weft-background-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const control = await createBackgroundControl("station", {
    baseDir: dir, status: () => ({ state: "ready" }), stop: async () => {},
    getStartTime: async () => 12345,
  });
  t.after(() => control.close());
  const status = await backgroundCommand("station", "status", null, { baseDir: dir });
  assert.equal(status.state, "ready");
  assert.equal(status.pid, process.pid);
  assert.equal(status.startedAt, 12345);
  assert.match(status.version, /^\d+\.\d+\.\d+/);
  await control.close();
  assert.equal(await backgroundCommand("station", "status", null, { baseDir: dir }), null);
});

test("a busy worker during startup is retried instead of failing Station start", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "weft-background-busy-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let busy = true;
  const control = await createBackgroundControl("relay", {
    baseDir: dir, status: () => busy ? new Promise(() => {}) : { state: "ready" }, stop: async () => {},
    getStartTime: async () => 12345,
  });
  t.after(() => control.close());
  let polls = 0;
  const result = await startBackground("relay", { ...options, baseDir: dir }, {
    taskOperation: async () => {}, sleep: async () => {},
    inspect: async () => {
      if (++polls === 3) busy = false;
      return backgroundCommand("relay", "status", null, { baseDir: dir, timeoutMs: 100 });
    },
  });
  assert.equal(result.state, "ready");
  assert.ok(polls >= 3);
});

test("native Windows supervision survives a crash and intentional stop stays stopped", {
    skip: process.platform !== "win32" || process.env.WEFT_NATIVE_BACKGROUND_TEST !== "1",
    timeout: 180_000,
  }, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "weft-native-task-"));
    const cliPath = join(dir, "worker.mjs");
    const taskOptions = { baseDir: dir, cliPath };
    const taskName = backgroundTaskName("station", taskOptions);
    const exec = promisify(execFile);
    t.after(async () => {
      try { await stopBackground("station", taskOptions); }
      finally {
        await exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
          `$task=Get-ScheduledTask -TaskName '${taskName}' -TaskPath '\\' -ErrorAction SilentlyContinue; if ($task) { Disable-ScheduledTask -TaskName '${taskName}' | Out-Null; Stop-ScheduledTask -TaskName '${taskName}'; Unregister-ScheduledTask -TaskName '${taskName}' -TaskPath '\\' -Confirm:$false }`,
        ], { windowsHide: true });
        await rm(dir, { recursive: true, force: true });
      }
    });
    await writeFile(cliPath, `
      import { existsSync, unlinkSync } from "node:fs";
      import { join } from "node:path";
      import { createBackgroundControl } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "..", "src", "backgroundLifecycle.mjs")).href)};
      const home = process.argv[4];
      let control;
      control = await createBackgroundControl("station", {
        baseDir: home, status: () => ({state:"ready", pid:process.pid}),
        stop: async () => { await control.close(); process.exit(0); },
      });
      setInterval(() => {
        const marker = join(home,"crash.once");
        if (existsSync(marker)) { unlinkSync(marker); process.exit(1); }
      }, 100);
    `);
    const initial = await startBackground("station", taskOptions, { timeoutMs: 30_000 });
    assert.ok(initial.pid);
    await writeFile(join(dir, "crash.once"), "crash");
    const deadline = Date.now() + 110_000;
    let restarted = null;
    while (Date.now() < deadline) {
      const current = await backgroundCommand("station", "status", null, { baseDir: dir });
      if (current?.pid && current.pid !== initial.pid) { restarted = current; break; }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(restarted, "Task Scheduler restarted the crashed workload");
    await stopBackground("station", taskOptions);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(await backgroundCommand("station", "status", null, { baseDir: dir }), null);
    assert.equal((await backgroundTaskOperation("status", { ...taskOptions, role: "station" })).state, "Disabled");
});

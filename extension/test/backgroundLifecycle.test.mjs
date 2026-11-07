// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  backgroundTaskScript, backgroundTaskOperation, backgroundTaskName, backgroundSupervisorScript,
  startBackground, stopBackground, createBackgroundControl, backgroundCommand,
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
  assert.ok(supervisor.includes("$code -eq 0"));
  assert.ok(supervisor.includes("Start-Sleep -Seconds $delay"));
  assert.match(script, /belongs to another identity/);
  assert.match(script, /running from another installation/);
  assert.notEqual(backgroundTaskName("station", options), backgroundTaskName("relay", options));
  assert.match(backgroundTaskScript("stop", { ...options, role: "station" }), /Weft did not stop/);
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
  const result = await startBackground("station", options, {
    now: () => clock, sleep: async (ms) => { clock += ms; },
    taskOperation: async (op) => { operations.push(op); },
    inspect: async () => ++attempts === 3 ? { state: "ready" } : { state: "starting" },
  });
  assert.equal(result.state, "ready");
  assert.deepEqual(operations, ["start"]);
  assert.equal(attempts, 3);
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
  assert.deepEqual(await backgroundCommand("station", "status", null, { baseDir: dir }), { state: "ready" });
  await control.close();
  assert.equal(await backgroundCommand("station", "status", null, { baseDir: dir }), null);
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

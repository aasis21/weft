// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { request } from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { createControlCenterHost, openControlCenter, stopControlCenter, openControlCenterBrowser, findControlCenterBrowser } from "../src/controlCenter.mjs";
import { createManagement } from "../src/management.mjs";
import { saveTransportConfig } from "../src/transportConfig.mjs";
import { backgroundTaskName, stopBackground } from "../src/backgroundLifecycle.mjs";

async function host(t, management, extra = {}) {
  const app = await createControlCenterHost({ management, publish: false, renderPage: () => "<!doctype html><title>Weft Control Center</title>", ...extra });
  const bootstrap = await fetch(app.url, { redirect: "manual" });
  const cookie = bootstrap.headers.get("set-cookie").split(";")[0];
  t.after(() => app.close());
  return { app, cookie,
    get: (path) => fetch(app.origin + path, { headers: { Cookie: cookie } }),
    post: (input, path = "/api/operations", headers = {}) => fetch(app.origin + path, {
      method: "POST", headers: { Cookie: cookie, Origin: app.origin, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(input),
    }),
  };
}
async function completed(get, id) {
  for (let n = 0; n < 100; n++) {
    const op = await (await get(`/api/operations/${id}`)).json();
    if (op.state !== "running") return op;
    await new Promise((done) => setTimeout(done, 10));
  }
  assert.fail("Operation did not complete.");
}

test("app-window mode uses an installed browser and private Weft profile without a shell", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "weft-window-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  let launched;
  const result = await openControlCenterBrowser("http://127.0.0.1:4321/open/test", {
    baseDir, findBrowser: () => ({ name: "Test Chromium", path: "test-browser" }),
    spawnBrowser: (path, args, options) => {
      launched = { path, args, options };
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("spawn"));
      return child;
    },
    execute: async () => assert.fail("Default-browser command must not run in app mode."),
  });
  assert.equal(result.mode, "app-window");
  assert.ok(launched.args.includes("--app=http://127.0.0.1:4321/open/test"));
  assert.ok(launched.args.includes("--user-data-dir=" + join(baseDir, "control-center-profile")));
  assert.equal(launched.options.shell, false);
  assert.ok(!launched.args.includes("--no-sandbox"));
  assert.equal(findControlCenterBrowser({ exists: () => false }), null);
});

test("browser fallback is explicit and an app launch error is not silently retried", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "weft-window-error-"));
  t.after(() => rm(baseDir, { recursive: true, force: true }));
  let launches = 0;
  const options = {
    platform: "win32", findBrowser: () => null,
    execute: async (command) => { launches++; assert.equal(command, "rundll32.exe"); },
  };
  assert.deepEqual(await openControlCenterBrowser("http://127.0.0.1:4321/", options), { mode: "browser", fallback: true });
  assert.deepEqual(await openControlCenterBrowser("http://127.0.0.1:4321/", {
    ...options, browserMode: true, findBrowser: () => assert.fail("Explicit browser mode must not select another browser."),
  }), { mode: "browser", fallback: false });
  assert.equal(launches, 2);
  await assert.rejects(openControlCenterBrowser("http://127.0.0.1:4321/", {
    ...options, baseDir, findBrowser: () => ({ name: "Test Chromium", path: "test-browser" }),
    spawnBrowser: () => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("Browser blocked")));
      return child;
    },
  }), (error) => error.code === "window-launch-failed");
  assert.equal(launches, 2, "Failed launch never falls back silently.");
  await assert.rejects(openControlCenterBrowser("http://127.0.0.1:4321/open/private-capability", {
    ...options, execute: async () => { throw new Error("Failed command includes private-capability"); },
  }), (error) => error.code === "browser-launch-failed" && !error.message.includes("private-capability"));
});
test("private local API rejects unauthenticated, cross-origin, forged-host and invalid actions", async (t) => {
  const h = await host(t, { state: async () => ({ station: { state: "stopped" } }) });
  assert.equal((await fetch(h.app.origin + "/api/state")).status, 401);
  assert.equal((await h.get("/")).status, 200);
  assert.equal((await h.post({ id: randomUUID(), action: "station.start", payload: {} }, "/api/operations", { Origin: "https://attacker.test" })).status, 403);
  const forged = await new Promise((resolve, reject) => {
    const req = request(h.app.origin + "/api/state", { headers: { Cookie: h.cookie, Host: "attacker.test" } }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    req.on("error", reject); req.end();
  });
  assert.equal(forged, 403);
  assert.equal((await h.post({ id: randomUUID(), action: "execute-shell", payload: {} })).status, 400);
  assert.equal((await h.post({ id: randomUUID(), action: "relay.stop", payload: {} })).status, 400);
  assert.equal((await h.post({ id: randomUUID(), action: "project.add", payload: { name: "work", path: "x".repeat(70_000) } })).status, 400);
  assert.equal((await h.get("/api/state")).headers.get("cache-control"), "no-store");
});
test("accepted operation is deduplicated, tracks real completion, and keeps host alive", async (t) => {
  let release, calls = 0;
  const blocked = new Promise((done) => { release = done; });
  const h = await host(t, { execute: async (_action, _payload, { onProgress }) => {
    calls++;
    onProgress({ stage: "hosting", label: "Hosting the saved tunnel", progressAt: Date.now() });
    await blocked;
    return { state: "ready" };
  } });
  const input = { id: randomUUID(), action: "station.start", payload: {} };
  const result = await (await h.post(input)).json();
  assert.equal(result.state, "running");
  await h.post(input);
  assert.equal(calls, 1);
  const pending = await (await h.get(`/api/operations/${input.id}`)).json();
  assert.equal(pending.progress.stage, "hosting");
  assert.ok(pending.startedAt > 0);
  assert.equal((await h.post({ ...input, action: "relay.start" })).status, 409);
  assert.equal((await h.post({}, "/api/close")).status, 409);
  release();
  assert.equal((await completed(h.get, input.id)).state, "succeeded");
  assert.equal((await completed(h.get, input.id)).signature, undefined);
});
test("failed operations are explicit and do not leak raw diagnostic secrets", async (t) => {
  const h = await host(t, { execute: async () => { throw new Error("secret credentials or tool result"); } });
  const id = randomUUID();
  await h.post({ id, action: "station.start", payload: {} });
  const op = await completed(h.get, id);
  assert.equal(op.state, "failed");
  assert.equal(op.error.code, "operation-failed");
  assert.ok(!JSON.stringify(op).includes("secret credentials"));
});

test("real UI host launches independently, reuses its identity and changes only its temporary home", async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "weft-ui-native-"));
  t.after(async () => {
    await stopControlCenter({ baseDir });
    await rm(baseDir, { recursive: true, force: true });
  });

  const cliPath = fileURLToPath(new URL("../bin/weft.mjs", import.meta.url));
  const first = await openControlCenter({ baseDir, cliPath, launchBrowser: false });
  const second = await openControlCenter({ baseDir, cliPath, launchBrowser: false });
  assert.equal(first.pid, second.pid);
  const record = JSON.parse(await readFile(join(baseDir, "control-center.json"), "utf8"));
  const cookie = `weft_control=${record.capability}`;
  const state = await (await fetch(record.origin + "/api/state", { headers: { Cookie: cookie } })).json();
  assert.equal(state.sessions.length, 0);
  assert.ok(!JSON.stringify(state).includes(record.capability));
  const id = randomUUID();
  await fetch(record.origin + "/api/operations", { method: "POST",
    headers: { Cookie: cookie, Origin: record.origin, "Content-Type": "application/json" },
    body: JSON.stringify({ id, action: "project.add", payload: { name: "native-test", path: baseDir } }),
  });
  const get = (path) => fetch(record.origin + path, { headers: { Cookie: cookie } });
  assert.equal((await completed(get, id)).state, "succeeded");
  assert.equal(JSON.parse(await readFile(join(baseDir, "projects.json"), "utf8")).projects[0].name, "native-test");
});

test("native local Control Center starts and stops a real isolated background Station", {
  skip: process.platform !== "win32" || process.env.WEFT_NATIVE_CONTROL_TEST !== "1",
}, async (t) => {
  const baseDir = await mkdtemp(join(tmpdir(), "weft-ui-station-"));
  const cliPath = fileURLToPath(new URL("../bin/weft.mjs", import.meta.url));
  const management = createManagement({ baseDir, cliPath });
  const taskName = backgroundTaskName("station", { baseDir });
  t.after(async () => {
    await stopBackground("station", { baseDir, cliPath });
    await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
      `Unregister-ScheduledTask -TaskName '${taskName}' -TaskPath '\\' -Confirm:$false -ErrorAction SilentlyContinue`]);
    await rm(baseDir, { recursive: true, force: true });
  });
  saveTransportConfig({ kind: "local" }, { baseDir });
  await management.execute("project.add", { name: "test", path: baseDir });
  const h = await host(t, management, { baseDir, cliPath });
  async function nativeOperation(action, payload) {
    const id = randomUUID();
    await h.post({ id, action, payload });
    for (let n = 0; n < 180; n++) {
      const op = await (await h.get(`/api/operations/${id}`)).json();
      if (op.state !== "running") return op;
      await new Promise((done) => setTimeout(done, 1000));
    }
    assert.fail("Native operation did not complete.");
  }
  const started = await nativeOperation("station.start", {});
  assert.equal(started.state, "succeeded", JSON.stringify(started.error));
  assert.equal(started.result.state, "ready");
  assert.equal((await (await h.get("/api/state")).json()).station.state, "ready");
  const stopped = await nativeOperation("station.stop", { confirmed: true });
  assert.equal(stopped.state, "succeeded", JSON.stringify(stopped.error));
  assert.equal((await (await h.get("/api/state")).json()).station.state, "stopped");
});

test("native Windows opens a visible standalone Control Center window", {
  skip: process.platform !== "win32" || process.env.WEFT_NATIVE_CONTROL_TEST !== "1",
}, async (t) => {
  if (!findControlCenterBrowser()) { t.skip("No supported installed Chromium browser."); return; }
  const baseDir = await mkdtemp(join(tmpdir(), "weft-native-window-"));
  let child;
  const app = await createControlCenterHost({
    baseDir, publish: false, management: { state: async () => ({
      version: "test", checkedAt: Date.now(), platform: "win32", deviceName: "Window test",
      station: { state: "stopped" }, relay: { state: "stopped" }, projects: [], sessions: [],
      settings: { transport: null, pairingMode: "persistent", files: { enabled: false, roots: [] } },
    }) },
  });
  t.after(async () => {
    await app.close();
    const profile = join(basename(baseDir), "control-center-profile").replaceAll("'", "''");
    const cleanup = `$profile=[regex]::Escape('${profile}')
Get-CimInstance -Query "SELECT ProcessId,Name,CommandLine FROM Win32_Process WHERE Name='msedge.exe' OR Name='chrome.exe' OR Name='chromium.exe' OR Name='crashpad_handler.exe' OR Name='msedge_crashpad_handler.exe' OR Name='chrome_crashpad_handler.exe'" | Where-Object {
  $_.Name -match '^(msedge|chrome|chromium|crashpad_handler)(?:_crashpad_handler)?\\.exe$' -and
  $_.CommandLine -and $_.CommandLine -match $profile
} | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
    await promisify(execFile)("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand",
      Buffer.from(cleanup, "utf16le").toString("base64"),
    ], { timeout: 30_000, windowsHide: true });
    await rm(baseDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  const result = await openControlCenterBrowser(app.url, {
    baseDir, spawnBrowser: (...args) => { child = spawn(...args); return child; },
  });
  assert.equal(result.mode, "app-window");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const { stdout } = await promisify(execFile)("powershell.exe", [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
      `$p=Get-Process -Id ${child.pid} -ErrorAction Stop; if ($p.MainWindowHandle -ne 0 -and $p.MainWindowTitle -like '*Control Center*') { 'visible' }`,
    ], { windowsHide: true, timeout: 5000 });
    if (stdout.trim() === "visible") return;
    await new Promise((done) => setTimeout(done, 500));
  }
  assert.fail("The app browser did not expose a visible Control Center window.");
});

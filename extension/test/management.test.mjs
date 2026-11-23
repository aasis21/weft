// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createManagement, withManagementLock } from "../src/management.mjs";
import { saveTransportConfig, saveSupabaseCredentials } from "../src/transportConfig.mjs";
import { shortcutScript, installControlCenterShortcut } from "../src/controlCenterShortcut.mjs";
import { resolveVersion } from "../src/version.mjs";

const EMPTY_SCAN = { live: [], foreign: [], unverified: [], sessions: [], legacyOwners: [] };
function liveRecord(runtimeId, sessionId, state = "dormant") {
  return {
    schema: 1,
    session: { storeAuthority: "sha256:store", sessionId },
    run: { runtimeId, generation: 1, pid: 1, processStartedAt: 1, version: "0.2.75", openedBy: null, cwd: null },
    control: { pipe: `pipe-${runtimeId}` },
    link: { generation: 1, state, attempt: 0, deadlineAt: null, lastError: null, controllerRevision: 0, lastPhoneContactAt: null, phoneWatching: null, endpointRevision: 0 },
    offer: null,
    updatedAt: 1,
  };
}
const scanOf = (live) => ({ ...EMPTY_SCAN, live, sessions: live.map((record) => ({ key: record.session, runtimes: [record], ownerConflict: false })) });

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), "weft-management-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("management validates full settings before one atomic write and preserves unrelated keys", async (t) => {
  const baseDir = await home(t);
  await writeFile(join(baseDir, "weft.config.json"), JSON.stringify({ custom: "preserved", terminal: { enabled: false, extra: true } }));
  const manager = createManagement({ baseDir, platform: "linux", scan: async () => EMPTY_SCAN });
  await assert.rejects(manager.execute("settings.save", { deviceName: "New name", files: { enabled: true, roots: [] } }), /confirm|root/i);
  assert.equal(JSON.parse(await readFile(join(baseDir, "weft.config.json"), "utf8")).deviceName, undefined);
  await manager.execute("settings.save", { deviceName: "Laptop", permissionMode: "default", terminalEnabled: false });
  const config = JSON.parse(await readFile(join(baseDir, "weft.config.json"), "utf8"));
  assert.equal(config.custom, "preserved");
  assert.equal(config.terminal.extra, true);
  assert.equal(config.deviceName, "Laptop");
  await assert.rejects(manager.execute("settings.save", { permissionMode: "allow-all" }), /Confirm/);
  await manager.execute("settings.save", { permissionMode: "allow-all", confirmed: true });
  assert.equal(manager.settings().permissionMode, "allow-all");
  const snapshot = await manager.state();
  await manager.execute("settings.save", { deviceName: "Changed through CLI" });
  await assert.rejects(manager.execute("settings.save", {
    deviceName: "Stale browser edit", expectedRevision: snapshot.settingsRevision,
  }), (error) => error.code === "settings-conflict");
  assert.equal(manager.settings().deviceName, "Changed through CLI");
});
test("project operations are shared, remove only registration, and serialize conflicting mutations", async (t) => {
  const baseDir = await home(t);
  const folder = join(baseDir, "source");
  await mkdir(folder);
  await writeFile(join(folder, "saved.txt"), "source");
  const manager = createManagement({ baseDir });
  await Promise.all([
    manager.execute("project.add", { name: "one", path: folder, makeDefault: true }),
    manager.execute("project.add", { name: "two", path: folder }),
  ]);
  assert.equal(manager.projects().length, 2);
  await manager.execute("project.default", { name: "two" });
  assert.equal(manager.projects().find((p) => p.default).name, "two");
  await assert.rejects(manager.execute("project.remove", { name: "two" }), /Confirm/);
  await manager.execute("project.remove", { name: "two", confirmed: true });
  assert.equal(await readFile(join(folder, "saved.txt"), "utf8"), "source");
  await assert.rejects(manager.execute("project.add", { name: "relative", path: "relative" }), /absolute/);
  await assert.rejects(manager.execute("shell", { command: "unsafe" }), /not supported/);
});
test("status probes do not activate dormant sessions or expose pairing payloads", async (t) => {
  const baseDir = await home(t);
  const commands = [];
  const manager = createManagement({
    baseDir, platform: "linux",
    scan: async () => scanOf([liveRecord("one", "one", "dormant"), liveRecord("two", "two", "connecting")]),
    sessionClient: (record) => ({ command: async (command) => {
      commands.push(command);
      return { state: record.link.state, pairingPayload: { token: "private-pairing-token" }, paired: true };
    } }),
  });
  const state = await manager.state();
  assert.deepEqual(commands, ["status", "status"]);
  assert.equal(state.sessions[0].connected, false, "dormant means Weft has no remote session link");
  assert.equal(state.sessions[0].watchLevel, "off");
  assert.equal(state.sessions[0].label, "dormant", "health comes from the shared projection");
  assert.equal(state.sessions[1].connected, false, "only a linked session counts as connected");
  assert.equal(state.sessions[1].watchLevel, null);
  assert.ok(!JSON.stringify(state).includes("private-pairing-token"));
  await manager.execute("session.activate", { runtimeId: "two" });
  assert.equal(commands.at(-1), "activate");
  await assert.rejects(manager.execute("station.start"), /Windows/);
});

test("reloading Weft in open sessions is confirmed and reports sessions that cannot reload", async (t) => {
  const baseDir = await home(t);
  const asked = [];
  const manager = createManagement({
    baseDir, platform: "linux",
    scan: async () => scanOf([liveRecord("one", "one"), liveRecord("two", "two"), liveRecord("three", "three")]),
    sessionClient: (record) => ({ command: async (command) => {
      asked.push([record.run.runtimeId, command]);
      if (record.run.runtimeId === "two") throw Object.assign(new Error("old Copilot"), { code: "unsupported" });
      if (record.run.runtimeId === "three") throw Object.assign(new Error("timed out"), { code: "timeout", timeout: true });
      return { state: "reloading" };
    } }),
  });
  await assert.rejects(manager.execute("sessions.reloadAll", {}), /Confirm/);
  assert.deepEqual(asked, []);
  const result = await manager.execute("sessions.reloadAll", { confirmed: true });
  assert.deepEqual([result.reloaded, result.unsupported, result.failed], [1, 1, 1]);
  assert.match(result.message, /\/extensions reload/);
  assert.ok(asked.every(([, command]) => command === "reloadExtension"));
});
test("Station management shares relay startup, confirms stops, and never claims readiness early", async (t) => {
  const baseDir = await home(t);
  saveTransportConfig({ kind: "devtunnel" }, { baseDir });
  const calls = [];
  const manager = createManagement({
    baseDir, platform: "win32", cliPath: "fake.mjs", relayHealth: async () => ({ baseUrl: "wss://test" }),
    background: {
      command: async () => null,
      start: async (role) => { calls.push(`start-${role}`); return { state: "ready", pairingPayload: { token: "secret" } }; },
      stop: async (role) => { calls.push(`stop-${role}`); return { state: "stopped" }; },
      task: async () => ({ state: "Ready" }),
    },
  });
  await assert.rejects(manager.execute("station.start"), /Register/);
  await manager.execute("project.add", { name: "work", path: baseDir });
  const started = await manager.execute("station.start");
  assert.deepEqual(calls, ["start-relay", "start-station"]);
  assert.equal(started.pairingPayload, undefined);
  await assert.rejects(manager.execute("relay.stop"), /Confirm/);
  await manager.execute("station.stop", { confirmed: true });
  assert.equal(calls.at(-1), "stop-station");
  assert.ok(!calls.includes("stop-relay"));
});

test("macOS management exposes background Station, relay, and Station traffic", async (t) => {
  const baseDir = await home(t);
  saveTransportConfig({ kind: "devtunnel" }, { baseDir });
  const calls = [];
  let stationRunning = false;
  const manager = createManagement({
    baseDir, platform: "darwin",
    scan: async () => EMPTY_SCAN,
    relayHealth: async () => ({ baseUrl: "https://relay.example.test" }),
    background: {
      command: async (role, command) => {
        calls.push(`${role}.${command}`);
        if (command === "traffic") return { entries: [{ id: "phone-message", direction: "in", lastAt: Date.now(), count: 1 }] };
        if (command === "status") return role === "station" && !stationRunning ? null : { state: "ready", paired: true, version: resolveVersion() };
        return null;
      },
      start: async (role) => { calls.push(`start-${role}`); if (role === "station") stationRunning = true; return { state: "ready", deviceName: "Mac", paired: true }; },
      stop: async (role) => { calls.push(`stop-${role}`); return { state: "stopped" }; },
      task: async () => ({ state: "NotRegistered" }),
    },
  });
  await manager.execute("project.add", { name: "work", path: baseDir });
  await manager.execute("station.start");
  assert.deepEqual(calls.filter((call) => call.startsWith("start-")), ["start-relay", "start-station"]);
  const calledBefore = calls.length;
  assert.equal((await manager.execute("station.start")).outcome, "already-running");
  assert.ok(!calls.slice(calledBefore).some((call) => call.startsWith("start-") || call.startsWith("stop-")), "a running current Station is not restarted");
  const state = await manager.state();
  assert.equal(state.station.supported, true);
  assert.equal(state.relay.supported, true);
  assert.equal(state.station.state, "ready");
  const traffic = await manager.traffic();
  assert.equal(traffic.sources[0].kind, "station");
  assert.equal(traffic.entries[0].source, "Station");
  await manager.execute("station.stop", { confirmed: true });
  assert.ok(calls.includes("stop-station"));
});

test("operational telemetry keeps worker identity, relay health and secrets separate", async (t) => {
  const baseDir = await home(t);
  const startedAt = Date.now() - 60_000;
  await writeFile(join(baseDir, "devtunnel.json"), JSON.stringify({
    alive: true, pid: process.pid, startedAt, baseUrl: "wss://relay.example.test",
  }));
  const manager = createManagement({
    baseDir, platform: "win32",
    background: {
      command: async () => ({ state: "ready", pid: 123, startedAt: startedAt - 10_000, version: "0.2.40",
        paired: true, connected: true, phoneName: "Phone", lastPeerContactAt: startedAt,
        pairingPayload: { token: "private-pairing-token" } }),
    },
    scan: async () => EMPTY_SCAN,
    relayHealth: async () => ({ baseUrl: "wss://relay.example.test" }),
    publicProbe: async () => "ok",
  });
  const state = await manager.state();
  assert.equal(state.station.version, "0.2.40");
  assert.equal(state.station.lastPeerContactAt, startedAt);
  assert.equal(state.station.connected, true);
  assert.equal(state.relay.pid, process.pid);
  assert.equal(state.relay.startedAt, startedAt);
  assert.equal(state.relay.managerPid, 123);
  assert.equal(state.relay.managerStartedAt, startedAt - 10_000);
  assert.equal(state.relay.forwarding, "ok");
  assert.ok(state.relay.lastHealthyAt > startedAt);
  assert.ok(!JSON.stringify(state).includes("private-pairing-token"));
});

test("stopped Station preserves saved trust and does not infer a missing phone", async (t) => {
  const baseDir = await home(t);
  await writeFile(join(baseDir, "pairing-identity.json"), JSON.stringify({
    channelId: "saved", privateKeyJwk: { secret: "private-key" }, peerPublicKeyB64: "public-peer",
  }));
  const manager = createManagement({ baseDir, platform: "win32",
    scan: async () => EMPTY_SCAN,
    background: { command: async () => null, task: async () => ({ state: "NotRegistered" }) },
  });
  const state = await manager.state();
  assert.equal(state.station.state, "stopped");
  assert.equal(state.station.paired, true);
  assert.equal(state.station.connected, false);
  const pairing = await manager.pairing();
  assert.equal(pairing.paired, true);
  assert.equal(pairing.code, null);
  assert.equal(pairing.qr, null);
  assert.ok(!JSON.stringify(state).includes("private-key"));
  await writeFile(join(baseDir, "pairing-identity.json"), "{corrupt");
  assert.equal((await manager.state()).station.paired, null);
});

test("selected transport scopes cached authentication and avoids claiming a different live connection", async (t) => {
  const baseDir = await home(t);
  saveTransportConfig({ kind: "devtunnel" }, { baseDir });
  let reads = 0;
  const manager = createManagement({ baseDir, platform: "win32",
    scan: async () => EMPTY_SCAN,
    background: { command: async () => ({ state: "ready", transportKind: "devtunnel", transportState: "connected" }) },
    authentication: async () => { reads++; return { state: "signed-in", provider: "GitHub", account: "example", checkedAt: Date.now() }; },
  });
  await manager.state(); await manager.state();
  assert.equal(reads, 1);
  await manager.refreshAuthentication();
  assert.equal(reads, 2);
  saveTransportConfig({ kind: "supabase" }, { baseDir });
  saveSupabaseCredentials({ url: "https://project.example.test/path?private=query", anonKey: "private-key" }, { baseDir });
  const state = await manager.state();
  assert.equal(state.connection.kind, "supabase");
  assert.equal(state.connection.auth, null);
  assert.equal(state.connection.endpoint, "https://project.example.test");
  assert.equal(state.connection.liveState, "restart-needed");
  assert.equal(state.connection.unusedRelay, true);
  assert.ok(!JSON.stringify(state).includes("private-key"));
  await manager.refreshAuthentication();
  assert.equal(reads, 2);
});

test("status reports partial failures and unexpected worker exits without failing the dashboard", async (t) => {
  const baseDir = await home(t);
  saveTransportConfig({ kind: "devtunnel" }, { baseDir });
  let taskState = "Ready";
  let authReads = 0;
  let releaseAuth;
  const manager = createManagement({ baseDir, platform: "win32",
    scan: async () => { throw Object.assign(new Error("private discovery detail"), { code: "EPERM" }); },
    background: {
      command: async (role) => {
        if (role === "relay") throw Object.assign(new Error("private relay detail"), { code: "EIO" });
        return null;
      },
      task: async () => ({ state: taskState, taskName: "Weft-station", lastResult: 3221225786 }),
    },
    authentication: () => { authReads++; return new Promise((resolve) => { releaseAuth = resolve; }); },
  });
  const state = await manager.state();
  assert.equal(state.station.state, "stopped");
  assert.equal(state.station.unexpectedStop.exit.code, "0xC000013A");
  assert.match(state.station.error, /stopped unexpectedly/);
  assert.equal(state.relay.state, "unknown");
  assert.deepEqual(state.sessions, []);
  assert.ok(state.warnings.some((warning) => /discovery is temporarily unavailable/.test(warning)));
  assert.equal(state.connection.auth.state, "checking");
  assert.ok(!JSON.stringify(state).includes("private"));
  releaseAuth({ state: "signed-in", provider: "GitHub", account: "example", checkedAt: Date.now() });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await manager.state()).connection.auth.state, "signed-in");
  assert.equal(authReads, 1);
  taskState = "Disabled";
  const stopped = await manager.state();
  assert.equal(stopped.station.unexpectedStop, undefined);
  assert.equal(stopped.station.error, undefined);
  const log = await readFile(join(baseDir, "station.log"), "utf8");
  assert.equal(log.match(/worker\.unexpected_stop role=station code=0xC000013A/g).length, 1);
  assert.match(log, /ui\.status_part_failed phase=sessions code=EPERM/);
  assert.match(log, /ui\.status_part_failed phase=relay code=EIO/);
  assert.ok(!log.includes("private"));
});

test("a worker stuck crashing is reported as crash-looping with its exact last error, logged once", async (t) => {
  const baseDir = await home(t);
  const now = Date.now();
  await writeFile(join(baseDir, "background-station-restarts.json"), JSON.stringify({
    role: "station", totalCrashes: 6, quickCrashesInARow: 6, quickCrashStreakStartedAt: now - 40_000,
    lastExitCode: 1, lastCrashAt: now - 2_000, lastRunSeconds: 1.4, nextRestartAt: now + 28_000,
  }));
  await writeFile(join(baseDir, "background-station-failure.json"), JSON.stringify({
    at: now - 2_100, name: "Error", code: "EADDRINUSE", message: "listen EADDRINUSE: address already in use 127.0.0.1:4590", location: "listener.mjs:301",
  }));
  let workerReady = false;
  const manager = createManagement({ baseDir, platform: "win32", scan: async () => EMPTY_SCAN,
    background: {
      command: async (role) => role === "station" && workerReady ? { state: "ready", pid: 4242, startedAt: now - 1_000 } : null,
      task: async (_operation, { role }) => ({ state: role === "station" ? "Running" : "Disabled", taskName: `Weft-${role}`, lastResult: 267009 }),
    },
    authentication: async () => ({ state: "signed-in" }),
  });
  const state = await manager.state();
  assert.equal(state.station.state, "crash-looping");
  assert.equal(state.station.crash.repeated, true);
  assert.equal(state.station.crash.quickCrashesInARow, 6);
  assert.deepEqual({ ...state.station.crash.lastError, at: undefined }, {
    name: "Error", code: "EADDRINUSE", message: "listen EADDRINUSE: address already in use 127.0.0.1:4590", location: "listener.mjs:301", at: undefined,
  });
  assert.match(state.station.error, /crashing repeatedly: 6 crashes in a row.*EADDRINUSE: address already in use/);
  assert.equal(state.relay.crash, undefined);
  await manager.state();
  workerReady = true;
  const recovered = await manager.state();
  assert.equal(recovered.station.state, "ready", "a worker that came back up is not shown as crash-looping");
  assert.equal(recovered.station.crash.repeated, true);
  const log = await readFile(join(baseDir, "station.log"), "utf8");
  assert.equal(log.match(/worker\.crash_loop role=station count=6 code=1/g).length, 1);
});

test("phone traffic merges Station and session sources, newest first, without unsupported workers failing it", async (t) => {
  const baseDir = await home(t);
  const at = Date.now();
  const sessions = [liveRecord("runtime-current", "s1"), liveRecord("runtime-older", "s2")];
  const manager = createManagement({ baseDir, platform: "win32",
    scan: async () => scanOf(sessions),
    background: {
      command: async (role, command) => {
        assert.equal(role, "station");
        assert.equal(command, "traffic");
        return { entries: [
          { id: 1, at: at - 9000, lastAt: at - 9000, direction: "in", event: "Session list requested", count: 1, bytes: 120, result: "replied", replyMs: 6100 },
          { id: 2, at: at - 8000, lastAt: at - 1000, direction: "out", event: "Station heartbeat", count: 4, bytes: 80, result: "sent", heartbeat: true },
        ] };
      },
    },
    sessionClient: (record) => ({ command: async (command) => {
      assert.equal(command, "traffic");
      if (record.run.runtimeId === "runtime-older") throw Object.assign(new Error("unsupported"), { code: "UNSUPPORTED_COMMAND" });
      return { title: "Fix login\u0007 bug", entries: [
        { id: 1, at: at - 5000, lastAt: at - 5000, direction: "out", event: "Launch result", count: 1, bytes: 300, result: "failed" },
      ] };
    } }),
  });
  const result = await manager.traffic();
  assert.deepEqual(result.entries.map((e) => [e.source, e.sourceKind, e.event]), [
    ["Station", "station", "Station heartbeat"],
    ["Fix login  bug", "session", "Launch result"],
    ["Station", "station", "Session list requested"],
  ]);
  assert.equal(new Set(result.entries.map((e) => e.id)).size, 3);
  assert.deepEqual(result.summary, { received: 1, sent: 5, lastFromPhone: at - 9000, problems: 1 });
  assert.deepEqual(result.sources.map((s) => [s.kind, s.state]).sort(), [["session", "reporting"], ["session", "unsupported"], ["station", "reporting"]]);
});

test("interrupted management ownership is explicit and is not automatically deleted", async (t) => {
  const baseDir = await home(t);
  await writeFile(join(baseDir, "management.lock"), JSON.stringify({ pid: 2147483647, token: "old" }));
  await assert.rejects(withManagementLock(baseDir, async () => {}), /stale lock/);
  assert.ok(await readFile(join(baseDir, "management.lock")));
});

test("concurrent status polling shares one verified discovery and releases it for fresh polling", async (t) => {
  const baseDir = await home(t);
  let calls = 0;
  const manager = createManagement({ baseDir, platform: "linux", scan: async (options) => {
    calls++;
    assert.equal(options.cleanup, false, "status polling never deletes records");
    await new Promise((done) => setTimeout(done, 20));
    return EMPTY_SCAN;
  } });
  await Promise.all([manager.state(), manager.state(), manager.state()]);
  assert.equal(calls, 1);
  await manager.state();
  assert.equal(calls, 2);
});

test("a hung Task Scheduler probe is bounded, shared by overlapping polls, and its late result is reused", async (t) => {
  const baseDir = await home(t);
  let taskCalls = 0;
  let release, released = false;
  const manager = createManagement({ baseDir, platform: "win32", statusProbeTimeoutMs: 50,
    scan: async () => EMPTY_SCAN,
    background: {
      command: async () => null,
      task: (_operation, { role }) => {
        taskCalls++;
        if (role === "relay" || released) return Promise.resolve({ state: role === "relay" ? "Disabled" : "Running", taskName: `Weft-${role}` });
        return new Promise((resolve) => { release = () => { released = true; resolve({ state: "Running", taskName: "Weft-station" }); }; });
      },
    },
  });
  const started = Date.now();
  const first = await manager.state();
  assert.ok(Date.now() - started < 2_000, "status must not wait for a hung probe");
  assert.equal(first.station.state, "unknown");
  assert.equal(first.station.checking, true);
  assert.equal(first.relay.state, "stopped");
  const second = await manager.state();
  assert.equal(second.station.state, "unknown");
  assert.equal(taskCalls, 3, "the second poll joins the in-flight station probe instead of starting another");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  const third = await manager.state();
  assert.equal(third.station.state, "unresponsive");
  assert.equal(third.station.checking, undefined);
});

test("a registry record from an exited worker is reported as stopped without contacting it", async (t) => {
  const baseDir = await home(t);
  await writeFile(join(baseDir, "background-station.json"), JSON.stringify({ role: "station", pid: 2147483647 }));
  const contacted = [];
  const manager = createManagement({ baseDir, platform: "win32", statusProbeTimeoutMs: 50,
    scan: async () => EMPTY_SCAN,
    background: {
      command: async (role) => { contacted.push(role); return null; },
      task: (_operation, { role }) => role === "station" ? new Promise(() => {}) : Promise.resolve({ state: "Disabled", taskName: "Weft-relay" }),
    },
  });
  const state = await manager.state();
  assert.deepEqual(contacted, ["relay"]);
  assert.equal(state.station.state, "stopped");
  assert.equal(state.station.staleWorker, true);
  assert.equal(state.station.checking, true);
  assert.equal(state.station.connected, false);
});

test("slow session discovery is bounded and later polls reuse its verified result", async (t) => {
  const baseDir = await home(t);
  let calls = 0;
  let release;
  const manager = createManagement({ baseDir, platform: "linux", statusProbeTimeoutMs: 50,
    scan: () => { calls++; return new Promise((resolve) => { release = resolve; }); },
    sessionClient: () => ({ command: async () => ({ state: "dormant", title: "Verified" }) }),
  });
  const first = await manager.state();
  assert.deepEqual(first.sessions, []);
  assert.ok(first.warnings.some((warning) => /still running/.test(warning)));
  await manager.state();
  assert.equal(calls, 1);
  release(scanOf([liveRecord("runtime-1", "s1")]));
  await new Promise((resolve) => setImmediate(resolve));
  const next = await manager.state();
  assert.equal(next.sessions[0]?.title, "Verified");
});
test("shortcut targets the installed CLI, quotes paths, and guards unrelated links", () => {
  const script = shortcutScript({ installDir: "C:\\Weft's Install", directory: "C:\\Test Desktop" });
  assert.match(script, /Weft''s Install/);
  assert.match(script, /unrelated shortcut/);
  assert.match(script, /weft\.cmd/);
  assert.ok(!script.includes("/open/"));
  assert.match(shortcutScript({ installDir: "C:\\Weft", directory: "C:\\Test", remove: true }), /Remove-Item -LiteralPath/);
});

test("native Windows shortcut is created in an isolated folder and refuses unrelated ownership", {
  skip: process.platform !== "win32" || process.env.WEFT_NATIVE_CONTROL_TEST !== "1",
}, async (t) => {
  const baseDir = await home(t);
  await writeFile(join(baseDir, "weft.cmd"), "@echo off\r\n");
  await installControlCenterShortcut({ installDir: baseDir, directory: baseDir });
  const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${join(baseDir, "Weft Control Center.lnk").replaceAll("'", "''")}'); $s.Arguments; $s.TargetPath`;
  const { stdout } = await promisify(execFile)("powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  assert.ok(stdout.includes("weft.cmd"));
  assert.ok(stdout.includes(" ui"));
  await assert.rejects(installControlCenterShortcut({ installDir: join(baseDir, "other"), directory: baseDir }));
});

test("packaged installation creates a branded shortcut with no checkout asset dependency", {
  skip: process.platform !== "win32" || process.env.WEFT_NATIVE_CONTROL_TEST !== "1",
}, async (t) => {
  const baseDir = await home(t);
  const dist = fileURLToPath(new URL("../dist/", import.meta.url));
  const cli = join(dist, "weft.mjs");
  const skill = fileURLToPath(new URL("../../mobile/public/weft-skill.md", import.meta.url));
  const installDir = join(baseDir, "code");
  await promisify(execFile)(process.execPath, [cli, "install", "--from", dist, "--skill", skill], {
    env: { ...process.env, WEFT_INSTALL_DIR: installDir, WEFT_SKILL_DIR: join(baseDir, "skill"), WEFT_SHORTCUT_DIR: baseDir },
  });
  const ico = await readFile(join(installDir, "weft-control-center.ico"));
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.subarray(22, 30).toString("hex"), "89504e470d0a1a0a");
  const script = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${join(baseDir, "Weft Control Center.lnk").replaceAll("'", "''")}'); $s.Arguments; $s.IconLocation`;
  const { stdout } = await promisify(execFile)("powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  assert.ok(stdout.includes(join(installDir, "weft.cmd")));
  assert.ok(stdout.includes("weft-control-center.ico"));
});

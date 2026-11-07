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
import { saveTransportConfig } from "../src/transportConfig.mjs";
import { shortcutScript, installControlCenterShortcut } from "../src/controlCenterShortcut.mjs";

async function home(t) {
  const dir = await mkdtemp(join(tmpdir(), "weft-management-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
test("management validates full settings before one atomic write and preserves unrelated keys", async (t) => {
  const baseDir = await home(t);
  await writeFile(join(baseDir, "weft.config.json"), JSON.stringify({ custom: "preserved", terminal: { enabled: false, extra: true } }));
  const manager = createManagement({ baseDir, platform: "linux", discover: async () => ({ runtimes: [], status: "none" }) });
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
    discover: async () => ({ status: "multiple", runtimes: [
      { runtimeInstanceId: "one", sessionId: "one", pid: 1 },
      { runtimeInstanceId: "two", sessionId: "two", pid: 2 },
    ] }),
    runtimeClient: (p) => ({ command: async (command) => {
      commands.push(command);
      return { ok: true, result: { state: p.sessionId === "one" ? "dormant" : "active",
        pairingPayload: { token: "private-pairing-token" }, paired: true } };
    } }),
  });
  const state = await manager.state();
  assert.deepEqual(commands, ["status", "status"]);
  assert.equal(state.sessions[1].connected, null);
  assert.equal(state.sessions[1].watchLevel, null);
  assert.ok(!JSON.stringify(state).includes("private-pairing-token"));
  await manager.execute("session.activate", { runtimeId: "two" });
  assert.equal(commands.at(-1), "activate");
  await assert.rejects(manager.execute("station.start"), /Windows/);
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
test("interrupted management ownership is explicit and is not automatically deleted", async (t) => {
  const baseDir = await home(t);
  await writeFile(join(baseDir, "management.lock"), JSON.stringify({ pid: 2147483647, token: "old" }));
  await assert.rejects(withManagementLock(baseDir, async () => {}), /stale lock/);
  assert.ok(await readFile(join(baseDir, "management.lock")));
});

test("concurrent status polling shares one verified discovery and releases it for fresh polling", async (t) => {
  const baseDir = await home(t);
  let calls = 0;
  const manager = createManagement({ baseDir, platform: "linux", discover: async (options) => {
    calls++;
    assert.equal(typeof options.verifyBatch, "function");
    assert.equal(options.cleanup, false);
    await new Promise((done) => setTimeout(done, 20));
    return { status: "none", runtimes: [] };
  } });
  await Promise.all([manager.state(), manager.state(), manager.state()]);
  assert.equal(calls, 1);
  await manager.state();
  assert.equal(calls, 2);
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

// SPDX-License-Identifier: Apache-2.0
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { spawn as childSpawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { exportKeyPair, generateKeyPair, importKeyPair } from "@aasis21/weft-shared";
import { launchCopilotSession, writeIdentityFile, detectTerminal } from "../src/terminalLauncher.mjs";
import {
  cleanupIdentityAfterPairing,
  persistHandoffController,
  readIdentityFile,
} from "../src/handoffIdentity.mjs";

const cleanupFiles = [];
const cleanupDirs = [];

test("macOS launches a visible Terminal.app without inherited TERM_PROGRAM and preserves quoted handoff arguments", async (t) => {
  const oldTerm = process.env.TERM_PROGRAM;
  delete process.env.TERM_PROGRAM;
  t.after(() => {
    if (oldTerm === undefined) delete process.env.TERM_PROGRAM;
    else process.env.TERM_PROGRAM = oldTerm;
  });
  assert.equal(detectTerminal({}, "darwin"), "macos-terminal");
  const directory = mkdtempSync(join(tmpdir(), "weft-mac-launch-"));
  cleanupDirs.push(directory);
  const captured = join(directory, "captured.json");
  const executable = join(directory, "fake copilot's $cli.mjs");
  writeFileSync(executable, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(captured)}, JSON.stringify({
  args: process.argv.slice(2), cwd: process.cwd(),
  identity: process.env.WEFT_IDENTITY_FILE, channel: process.env.WEFT_CHANNEL_ID,
}));
`, { mode: 0o700 });
  let launcher;
  const result = await launchCopilotSession({
    project: { path: directory }, baseDir: directory, platform: "darwin",
    name: "Mac's $session", mode: "allow-all", identity: await identity("mac-launch"),
    copilotExecutable: executable,
    spawnFn(command, args, options) {
      assert.equal(command, "osascript");
      assert.equal(options.shell, false);
      assert.match(args[1], /tell application "Terminal" to do script/);
      launcher = args.at(-1);
      cleanupFiles.push(launcher, options.env.WEFT_IDENTITY_FILE);
      const child = new EventEmitter();
      child.pid = 12_345;
      child.unref = () => {};
      queueMicrotask(() => child.emit("close", 0));
      return child;
    },
  });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.pid, null, "Terminal broker is not the Copilot runtime.");
  assert.match(readFileSync(launcher, "utf8"), /export WEFT_IDENTITY_FILE=/);
  if (process.platform !== "win32") {
    await promisify(execFile)("/bin/bash", [launcher], { timeout: 5_000 });
    assert.deepEqual(JSON.parse(readFileSync(captured, "utf8")), {
      args: ["-n", "Mac's $session", "--allow-all"], cwd: realpathSync(directory),
      identity: result.identityFile, channel: "mac-launch",
    });
  }
});

test("macOS Terminal.app failure cleans the launcher and private identity instead of reporting success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "weft-mac-failed-"));
  cleanupDirs.push(directory);
  const files = [];
  const result = await launchCopilotSession({
    project: { path: directory }, baseDir: directory, platform: "darwin",
    identity: await identity("mac-failed"),
    spawnFn(_command, args, options) {
      files.push(args.at(-1), options.env.WEFT_IDENTITY_FILE);
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("close", 1));
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Terminal launcher exited with code 1/);
  assert.ok(files.every((file) => !existsSync(file)));
});

afterEach(() => {
  for (const file of cleanupFiles.splice(0)) {
    try { unlinkSync(file); } catch {}
  }
  for (const dir of cleanupDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function identity(channelId = "chan-test") {
  const keyPair = await generateKeyPair();
  const exported = await exportKeyPair(keyPair);
  return { channelId, ...exported };
}

test("writeIdentityFile writes 0600 JSON that can be imported", async () => {
  const material = await identity();
  const file = writeIdentityFile(material);
  cleanupFiles.push(file);
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(parsed.channelId, material.channelId);
  assert.equal(parsed.publicKeyB64, material.publicKeyB64);
  const imported = await importKeyPair({ privateKeyJwk: parsed.privateKeyJwk });
  assert.equal(imported.publicKeyB64, material.publicKeyB64);
  if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600);
});

test("handoff identity can be read by replacement extension processes", async () => {
  const material = await identity("chan-reload");
  const file = writeIdentityFile(material);
  cleanupFiles.push(file);

  const first = await readIdentityFile(file);
  const replacement = await readIdentityFile(file);

  assert.equal(first.channelId, material.channelId);
  assert.equal(first.laptopKeys.publicKeyB64, material.publicKeyB64);
  assert.equal(replacement.channelId, material.channelId);
  assert.equal(replacement.laptopKeys.publicKeyB64, material.publicKeyB64);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).channelId, material.channelId);
});

test("durable handoff identity survives pairing for extension reloads", async () => {
  const weftHome = mkdtempSync(join(tmpdir(), "weft-durable-handoff-"));
  cleanupDirs.push(weftHome);
  const file = writeIdentityFile(await identity("chan-durable-reload"), {
    baseDir: weftHome,
  });
  cleanupFiles.push(file);

  assert.equal(cleanupIdentityAfterPairing(file, { durable: true }), false);
  assert.equal((await readIdentityFile(file)).channelId, "chan-durable-reload");
});

test("transient handoff identity is removed after pairing", async () => {
  const file = writeIdentityFile(await identity("chan-transient"));

  assert.equal(cleanupIdentityAfterPairing(file), true);
  assert.throws(() => readFileSync(file, "utf8"), /ENOENT/);
});

test("handoff identity preserves the one-time pairing grant for the spawned extension", async () => {
  const material = {
    ...(await identity("chan-pairing-grant")),
    pairingToken: "t".repeat(43),
    pairingExpiresAt: Date.now() + 60_000,
  };
  const file = writeIdentityFile(material);
  cleanupFiles.push(file);

  const restored = await readIdentityFile(file);
  assert.equal(restored.pairingToken, material.pairingToken);
  assert.equal(restored.pairingExpiresAt, material.pairingExpiresAt);
});

test("durable handoff persists the claimed phone identity for replacement processes", async () => {
  const material = {
    ...(await identity("chan-controller-recovery")),
    requestId: "request-a",
    operationOwnerToken: "owner-a",
  };
  const file = writeIdentityFile(material);
  cleanupFiles.push(file);

  persistHandoffController(file, {
    trustedPeerPublicKeyB64: "phone-public-key",
    controllerDeviceId: "phone-a",
    controllerName: "WebApp",
    requestId: "request-a",
    operationOwnerToken: "owner-a",
  });

  const restored = await readIdentityFile(file);
  assert.equal(restored.trustedPeerPublicKeyB64, "phone-public-key");
  assert.equal(restored.controllerDeviceId, "phone-a");
  assert.equal(restored.controllerName, "WebApp");
  assert.throws(
    () => persistHandoffController(file, {
      trustedPeerPublicKeyB64: "other-phone",
      requestId: "request-a",
      operationOwnerToken: "wrong-owner",
    }),
    /ownership changed/,
  );
  assert.throws(
    () => persistHandoffController(file, {
      trustedPeerPublicKeyB64: "other-phone",
      requestId: "request-b",
      operationOwnerToken: "owner-a",
    }),
    /ownership changed/,
  );
});

test("launchCopilotSession builds argv/env for headless spawn without shell", async () => {
  const oldWt = process.env.WT_SESSION;
  const oldTerm = process.env.TERM_PROGRAM;
  const oldGnome = process.env.GNOME_TERMINAL_SCREEN;
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-project-"));
  cleanupDirs.push(projectDir);
  const calls = [];
  const result = await launchCopilotSession({
    project: { name: "app", path: projectDir },
    name: "brave-otter",
    mode: "allow-all",
    platform: "linux",
    identity: await identity("chan-spawn"),
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      cleanupFiles.push(options.env.WEFT_IDENTITY_FILE);
      return { unref() {} };
    },
  });
  process.env.WT_SESSION = oldWt;
  process.env.TERM_PROGRAM = oldTerm;
  process.env.GNOME_TERMINAL_SCREEN = oldGnome;

  assert.equal(result.ok, true);
  assert.equal(result.pid, null);
  assert.ok(result.identityFile);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "copilot");
  assert.deepEqual(calls[0].args, ["-n", "brave-otter", "--allow-all"]);
  assert.equal(calls[0].options.cwd, projectDir);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.WEFT_CHANNEL_ID, "chan-spawn");
  assert.ok(calls[0].options.env.WEFT_IDENTITY_FILE);
  assert.equal(JSON.parse(readFileSync(calls[0].options.env.WEFT_IDENTITY_FILE, "utf8")).channelId, "chan-spawn");
});

test("background Windows Station launches an interactive console without WT_SESSION", async () => {
  const old = process.env.WT_SESSION;
  delete process.env.WT_SESSION;
  try {
    assert.equal(detectTerminal({}, "win32"), "windows-console");
    const projectDir = mkdtempSync(join(tmpdir(), "weft-background-spawn-"));
    cleanupDirs.push(projectDir);
    let call;
    const result = await launchCopilotSession({
      platform: "win32", project: { path: projectDir }, identity: await identity("console-test"),
      name: "test % value", spawnFn(command, args, options) {
        call = { command, args, options };
        return { pid: 4321, unref() {} };
      },
    });
    cleanupFiles.push(result.identityFile);
    assert.equal(result.ok, true);
    assert.equal(result.pid, null, "terminal broker PID is not a proven Copilot writer");
    assert.match(call.command, /cmd\.exe$/i);
    const broker = call.args.at(-1);
    cleanupFiles.push(broker);
    const script = readFileSync(broker, "utf8");
    assert.match(script, /start "" "%ComSpec%"/);
    const launcher = script.match(/\/k "([^"]+\.cmd)"/)[1].replaceAll("%%", "%");
    cleanupFiles.push(launcher);
    const body = readFileSync(launcher, "utf8");
    assert.match(body, /setlocal DisableDelayedExpansion/);
    assert.match(body, /copilot -n "test %% value"/);
    assert.equal(call.options.shell, false);
  } finally {
    if (old === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = old;
  }
});

test("launchCopilotSession bakes identity into a launcher script for windows-terminal", async () => {
  const oldWt = process.env.WT_SESSION;
  process.env.WT_SESSION = "1"; // force windows-terminal branch regardless of host
  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-project-"));
  cleanupDirs.push(projectDir);
  const calls = [];
  const result = await launchCopilotSession({
    project: { name: "app", path: projectDir },
    name: "brave otter", // deliberate space to exercise arg quoting
    mode: "allow-all",
    identity: await identity("chan-wt"),
    platform: "win32",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      cleanupFiles.push(options.env.WEFT_IDENTITY_FILE);
      return { unref() {} };
    },
  });
  process.env.WT_SESSION = oldWt;

  assert.equal(result.ok, true);
  assert.equal(calls[0].command, "wt.exe");
  // Last argv element is the launcher script routed through cmd.exe /k.
  const launcherPath = calls[0].args.at(-1);
  cleanupFiles.push(launcherPath);
  assert.match(launcherPath, /weft-launch-.*\.cmd$/);
  assert.deepEqual(calls[0].args.slice(0, 5), ["new-tab", "--startingDirectory", projectDir, "cmd.exe", "/k"]);

  const script = readFileSync(launcherPath, "utf8");
  const identityFile = calls[0].options.env.WEFT_IDENTITY_FILE;
  assert.ok(script.includes(`set "WEFT_IDENTITY_FILE=${identityFile}"`));
  assert.ok(script.includes(`set "WEFT_CHANNEL_ID=chan-wt"`));
  assert.ok(script.includes(`cd /d "${projectDir}"`));
  assert.ok(script.includes(`copilot -n "brave otter" --allow-all`));
});

test("launchCopilotSession resumes an existing session by id in its cwd (no -n name)", async () => {
  const oldWt = process.env.WT_SESSION;
  const oldTerm = process.env.TERM_PROGRAM;
  const oldGnome = process.env.GNOME_TERMINAL_SCREEN;
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const sessionCwd = mkdtempSync(join(tmpdir(), "weft-resume-cwd-"));
  cleanupDirs.push(sessionCwd);
  const calls = [];
  const result = await launchCopilotSession({
    project: { name: "resume", path: sessionCwd },
    mode: "allow-all",
    platform: "linux",
    identity: await identity("chan-resume"),
    resumeSessionId: "sid-123",
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      cleanupFiles.push(options.env.WEFT_IDENTITY_FILE);
      return { unref() {} };
    },
  });
  process.env.WT_SESSION = oldWt;
  process.env.TERM_PROGRAM = oldTerm;
  process.env.GNOME_TERMINAL_SCREEN = oldGnome;

  assert.equal(result.ok, true);
  assert.equal(calls[0].command, "copilot");
  assert.deepEqual(calls[0].args, ["--resume=sid-123", "--allow-all"]);
  assert.equal(calls[0].options.cwd, sessionCwd);
  assert.equal(calls[0].options.env.WEFT_CHANNEL_ID, "chan-resume");
});

test("launchCopilotSession leaves an unnamed fresh session for Copilot to title (no -n placeholder)", async () => {
  const saved = { WT_SESSION: process.env.WT_SESSION, GNOME_TERMINAL_SCREEN: process.env.GNOME_TERMINAL_SCREEN };
  delete process.env.WT_SESSION;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-unnamed-"));
  cleanupDirs.push(projectDir);
  const calls = [];
  try {
    const result = await launchCopilotSession({
      project: { name: "app", path: projectDir },
      platform: "linux",
      identity: await identity("chan-unnamed"),
      spawnFn(command, args, options) {
        calls.push({ command, args, options });
        cleanupFiles.push(options.env.WEFT_IDENTITY_FILE);
        return { unref() {} };
      },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0].args, []);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("launchCopilotSession reports spawn errors and cleans up identity file", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-project-"));
  cleanupDirs.push(projectDir);
  let identityPath;
  const result = await launchCopilotSession({
    project: { name: "app", path: projectDir },
    name: "plain",
    identity: await identity("chan-fail"),
    spawnFn(_command, _args, options) {
      identityPath = options.env.WEFT_IDENTITY_FILE;
      throw new Error("boom");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
  assert.throws(() => statSync(identityPath), /ENOENT/);
});

test("launchCopilotSession surfaces an asynchronous child error before spawn", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-project-"));
  cleanupDirs.push(projectDir);
  let identityPath;
  const result = await launchCopilotSession({
    project: { name: "app", path: projectDir },
    identity: await identity("chan-async-fail"),
    spawnFn(_command, _args, options) {
      identityPath = options.env.WEFT_IDENTITY_FILE;
      const child = new EventEmitter();
      child.unref = () => {};
      queueMicrotask(() => child.emit("error", new Error("async boom")));
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /async boom/);
  assert.throws(() => statSync(identityPath), /ENOENT/);
});

test("launchCopilotSession returns a reliable direct child pid and persists request handoff", async () => {
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-project-"));
  const weftHome = mkdtempSync(join(tmpdir(), "weft-launch-home-"));
  cleanupDirs.push(projectDir, weftHome);
  const result = await launchCopilotSession({
    project: { name: "app", path: projectDir },
    identity: await identity("chan-operation"),
    requestId: "req-operation",
    operationOwnerToken: "owner-secret",
    baseDir: weftHome,
    platform: "linux",
    spawnFn() {
      return { pid: 4321, unref() {} };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.pid, 4321);
  const parsed = JSON.parse(readFileSync(result.identityFile, "utf8"));
  assert.equal(parsed.requestId, "req-operation");
  assert.equal("operationId" in parsed, false);
  assert.equal(parsed.operationOwnerToken, "owner-secret");
  assert.ok(parsed.privateKeyJwk);
  const restored = await readIdentityFile(result.identityFile);
  assert.equal(restored.requestId, "req-operation");
  assert.equal(restored.operationOwnerToken, "owner-secret");
});

test("a failed visible terminal broker cannot report a successful session launch", async () => {
  const home = mkdtempSync(join(tmpdir(), "weft-failed-broker-"));
  cleanupDirs.push(home);
  const files = [];
  const result = await launchCopilotSession({
    project: { path: home }, identity: await identity(), baseDir: home, platform: "win32",
    spawnFn(_command, args, options) {
      const broker = args.at(-1);
      const launcher = broker.endsWith(".broker.cmd")
        ? readFileSync(broker, "utf8").match(/\/k "([^"]+\.cmd)"/)[1].replaceAll("%%", "%")
        : broker;
      files.push(options.env.WEFT_IDENTITY_FILE, broker, launcher);
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => { child.emit("spawn"); child.emit("close", 1); });
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Terminal launcher exited with code 1/);
  assert.ok(files.every((file) => !existsSync(file)));
  assert.match(readFileSync(join(home, "station.log"), "utf8"), /launch.failed.*TERMINAL_LAUNCH_FAILED/);
});

test("native background-style Windows launch runs the interactive shell command with its handoff", {
  skip: process.platform !== "win32" || process.env.WEFT_NATIVE_SPAWN_TEST !== "1",
}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-console-launch-"));
  cleanupDirs.push(dir);
  const output = join(dir, "result.json");
  const script = join(dir, "fake-copilot.mjs");
  const command = join(dir, "fake-copilot.cmd");
  writeFileSync(script, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  args: process.argv.slice(2), channel: process.env.WEFT_CHANNEL_ID,
  handoff: process.env.WEFT_IDENTITY_FILE, cwd: process.cwd()
}));`);
  writeFileSync(command, `@echo off\r\n"${process.execPath}" "${script}" %*\r\nexit\r\n`);
  const old = process.env.WT_SESSION;
  delete process.env.WT_SESSION;
  try {
    let brokerError = "";
    const result = await launchCopilotSession({
      project: { path: dir }, platform: "win32", name: "native % test",
      identity: await identity("native-console"), copilotExecutable: command,
      spawnFn: (exe, args, options) => {
        const broker = args.at(-1);
        cleanupFiles.push(broker);
        const launcher = readFileSync(broker, "utf8").match(/\/k "([^"]+\.cmd)"/)[1].replaceAll("%%", "%");
        cleanupFiles.push(launcher);
        const child = childSpawn(exe, args, { ...options, stdio: ["ignore", "ignore", "pipe"] });
        child.stderr.on("data", (chunk) => { brokerError = (brokerError + chunk.toString()).slice(-4000); });
        return child;
      },
    });
    assert.equal(result.ok, true, result.error ?? brokerError);
    cleanupFiles.push(result.identityFile);
    const deadline = Date.now() + 20_000;
    while (!existsSync(output) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100));
    assert.ok(existsSync(output), "the visible console executed the requested command");
    const data = JSON.parse(readFileSync(output, "utf8"));
    assert.deepEqual(data.args, ["-n", "native % test"]);
    assert.equal(data.channel, "native-console");
    assert.equal(data.handoff, result.identityFile);
    assert.equal(data.cwd.toLowerCase(), dir.toLowerCase());
    assert.equal(result.pid, null);
  } finally {
    if (old === undefined) delete process.env.WT_SESSION;
    else process.env.WT_SESSION = old;
  }
});

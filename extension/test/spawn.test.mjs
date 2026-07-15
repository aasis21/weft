// SPDX-License-Identifier: Apache-2.0
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportKeyPair, generateKeyPair, importKeyPair } from "@aasis21/weft-shared";
import { spawnCopilotSession, writeIdentityFile } from "../src/spawn.mjs";
import { readIdentityFile } from "../src/handoffIdentity.mjs";

const cleanupFiles = [];
const cleanupDirs = [];

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

test("spawnCopilotSession builds argv/env for headless spawn without shell", async () => {
  const oldWt = process.env.WT_SESSION;
  const oldTerm = process.env.TERM_PROGRAM;
  const oldGnome = process.env.GNOME_TERMINAL_SCREEN;
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-project-"));
  cleanupDirs.push(projectDir);
  const calls = [];
  const result = spawnCopilotSession({
    project: { name: "app", path: projectDir },
    name: "brave-otter",
    mode: "allow-all",
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

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "copilot");
  assert.deepEqual(calls[0].args, ["-n", "brave-otter", "--allow-all"]);
  assert.equal(calls[0].options.cwd, projectDir);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.WEFT_CHANNEL_ID, "chan-spawn");
  assert.ok(calls[0].options.env.WEFT_IDENTITY_FILE);
  assert.equal(JSON.parse(readFileSync(calls[0].options.env.WEFT_IDENTITY_FILE, "utf8")).channelId, "chan-spawn");
});

test("spawnCopilotSession bakes identity into a launcher script for windows-terminal", async () => {
  const oldWt = process.env.WT_SESSION;
  process.env.WT_SESSION = "1"; // force windows-terminal branch regardless of host
  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-project-"));
  cleanupDirs.push(projectDir);
  const calls = [];
  const result = spawnCopilotSession({
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

  assert.deepEqual(result, { ok: true });
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

test("spawnCopilotSession resumes an existing session by id in its cwd (no -n name)", async () => {
  const oldWt = process.env.WT_SESSION;
  const oldTerm = process.env.TERM_PROGRAM;
  const oldGnome = process.env.GNOME_TERMINAL_SCREEN;
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const sessionCwd = mkdtempSync(join(tmpdir(), "weft-resume-cwd-"));
  cleanupDirs.push(sessionCwd);
  const calls = [];
  const result = spawnCopilotSession({
    project: { name: "resume", path: sessionCwd },
    mode: "allow-all",
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

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].command, "copilot");
  assert.deepEqual(calls[0].args, ["--resume=sid-123", "--allow-all"]);
  assert.equal(calls[0].options.cwd, sessionCwd);
  assert.equal(calls[0].options.env.WEFT_CHANNEL_ID, "chan-resume");
});

test("spawnCopilotSession reports spawn errors and cleans up identity file", async () => {  const projectDir = mkdtempSync(join(tmpdir(), "weft-spawn-project-"));
  cleanupDirs.push(projectDir);
  let identityPath;
  const result = spawnCopilotSession({
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

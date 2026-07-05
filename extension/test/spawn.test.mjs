// SPDX-License-Identifier: Apache-2.0
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportKeyPair, generateKeyPair, importKeyPair } from "@aasis21/helm-shared";
import { spawnCopilotSession, writeIdentityFile } from "../src/spawn.mjs";

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

test("spawnCopilotSession builds argv/env for headless spawn without shell", async () => {
  const oldWt = process.env.WT_SESSION;
  const oldTerm = process.env.TERM_PROGRAM;
  const oldGnome = process.env.GNOME_TERMINAL_SCREEN;
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const projectDir = mkdtempSync(join(tmpdir(), "helm-spawn-project-"));
  cleanupDirs.push(projectDir);
  const calls = [];
  const result = spawnCopilotSession({
    project: { name: "app", path: projectDir },
    name: "brave-otter",
    mode: "allow-all",
    identity: await identity("chan-spawn"),
    spawnFn(command, args, options) {
      calls.push({ command, args, options });
      cleanupFiles.push(options.env.HELM_IDENTITY_FILE);
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
  assert.equal(calls[0].options.env.HELM_CHANNEL_ID, "chan-spawn");
  assert.ok(calls[0].options.env.HELM_IDENTITY_FILE);
  assert.equal(JSON.parse(readFileSync(calls[0].options.env.HELM_IDENTITY_FILE, "utf8")).channelId, "chan-spawn");
});

test("spawnCopilotSession reports spawn errors and cleans up identity file", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "helm-spawn-project-"));
  cleanupDirs.push(projectDir);
  let identityPath;
  const result = spawnCopilotSession({
    project: { name: "app", path: projectDir },
    name: "plain",
    identity: await identity("chan-fail"),
    spawnFn(_command, _args, options) {
      identityPath = options.env.HELM_IDENTITY_FILE;
      throw new Error("boom");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /boom/);
  assert.throws(() => statSync(identityPath), /ENOENT/);
});

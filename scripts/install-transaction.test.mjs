// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { commitStagedFiles, renameWithRetry } from "./install-transaction.mjs";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "weft-install-transaction-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const files = [
    { name: "weft.mjs", dest: join(directory, "weft.mjs"), stage: join(directory, ".weft.stage"), backup: join(directory, ".weft.backup") },
    { name: "node-pty", dest: join(directory, "node-pty"), stage: join(directory, ".pty.stage"), backup: join(directory, ".pty.backup"), recursive: true },
  ];
  writeFileSync(files[0].dest, "old JS");
  writeFileSync(files[0].stage, "new JS");
  for (const [path, bytes] of [[files[1].dest, "old native"], [files[1].stage, "new native"]]) {
    mkdirSync(path);
    writeFileSync(join(path, "pty.node"), bytes);
  }
  return files;
}

test("Windows rename retries bounded transient sharing errors", () => {
  const waits = [];
  let attempts = 0;
  renameWithRetry("source", "destination", {
    platform: "win32", wait: (milliseconds) => waits.push(milliseconds),
    rename() {
      if (++attempts < 4) throw Object.assign(new Error("scanner sharing lock"), { code: "EPERM" });
    },
  });
  assert.equal(attempts, 4);
  assert.deepEqual(waits, [80, 160, 320]);
});

test("persistent Windows rename errors fail after a bounded wait", () => {
  const waits = [];
  let attempts = 0;
  assert.throws(() => renameWithRetry("source", "destination", {
    platform: "win32", wait: (milliseconds) => waits.push(milliseconds),
    rename() {
      attempts++;
      throw Object.assign(new Error("persistent sharing lock"), { code: "EACCES" });
    },
  }), /persistent sharing lock/);
  assert.equal(attempts, 8);
  assert.equal(waits.reduce((total, milliseconds) => total + milliseconds, 0), 2560);
});

test("non-Windows and non-sharing rename failures are not retried", () => {
  for (const [platform, code] of [["linux", "EPERM"], ["win32", "ENOENT"]]) {
    assert.throws(() => renameWithRetry("source", "destination", {
      platform, wait() { assert.fail("unexpected retry"); },
      rename() { throw Object.assign(new Error("hard failure"), { code }); },
    }), /hard failure/);
  }
});

test("native replacement failure rolls back already-replaced JS and the original native package", (t) => {
  const files = fixture(t);
  assert.throws(() => commitStagedFiles(files, {
    rename(source, destination) {
      if (source === files[1].stage) throw new Error("simulated native replacement failure");
      renameSync(source, destination);
    },
  }), /simulated native replacement failure/);
  assert.equal(readFileSync(files[0].dest, "utf8"), "old JS");
  assert.equal(readFileSync(join(files[1].dest, "pty.node"), "utf8"), "old native");
  assert.ok(files.every((file) => !existsSync(file.backup)));
});

test("failure on a fresh install removes already-placed JS", (t) => {
  const files = fixture(t);
  rmSync(files[0].dest);
  rmSync(files[1].dest, { recursive: true });
  assert.throws(() => commitStagedFiles(files, {
    rename(source, destination) {
      if (source === files[1].stage) throw new Error("simulated native replacement failure");
      renameSync(source, destination);
    },
  }), /simulated native replacement failure/);
  assert.ok(files.every((file) => !existsSync(file.dest)));
});

test("locked old DLL cleanup warns but never rolls back a committed release", (t) => {
  const files = fixture(t);
  const warnings = [];
  commitStagedFiles(files, {
    remove(path, options) {
      if (path === files[1].backup) throw Object.assign(new Error("locked DLL"), { code: "EPERM" });
      rmSync(path, options);
    },
    warn: (message) => warnings.push(message),
  });
  assert.equal(readFileSync(files[0].dest, "utf8"), "new JS");
  assert.equal(readFileSync(join(files[1].dest, "pty.node"), "utf8"), "new native");
  assert.equal(readFileSync(join(files[1].backup, "pty.node"), "utf8"), "old native");
  assert.match(warnings[0], /old recovery copy.*EPERM/);
});

test("rollback failure retains recovery copies and reports their paths", (t) => {
  const files = fixture(t);
  assert.throws(() => commitStagedFiles(files, {
    rename(source, destination) {
      if (source === files[1].stage) throw new Error("simulated native replacement failure");
      renameSync(source, destination);
    },
    remove(path, options) {
      if (path === files[0].dest) throw new Error("cannot remove new bundle");
      rmSync(path, options);
    },
  }), /recovery copy retained/);
  assert.equal(readFileSync(files[0].backup, "utf8"), "old JS");
  assert.equal(readFileSync(join(files[1].dest, "pty.node"), "utf8"), "old native");
});

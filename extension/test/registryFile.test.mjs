// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { clearRegistry, isPidAlive, readRegistry, writeRegistryAtomic } from "../src/registryFile.mjs";

test("readRegistry returns null when the file doesn't exist", () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-registry-"));
  try {
    assert.equal(readRegistry("nope.json", { baseDir: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readRegistry returns null for corrupt JSON instead of throwing", () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-registry-"));
  try {
    writeRegistryAtomic("bad.json", { ok: true }, { baseDir: dir });
    // Corrupt it directly.
    const file = join(dir, "bad.json");
    writeFileSync(file, "{not json");
    assert.equal(readRegistry("bad.json", { baseDir: dir }), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRegistryAtomic round-trips through readRegistry", () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-registry-"));
  try {
    const ok = writeRegistryAtomic("thing.json", { pid: 123, url: "wss://x" }, { baseDir: dir });
    assert.equal(ok, true);
    assert.deepEqual(readRegistry("thing.json", { baseDir: dir }), { pid: 123, url: "wss://x" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeRegistryAtomic never leaves a stray .tmp file behind on success", () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-registry-"));
  try {
    writeRegistryAtomic("thing.json", { a: 1 }, { baseDir: dir });
    const entries = readdirSync(dir);
    assert.deepEqual(entries, ["thing.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearRegistry removes the file and is a no-op if it's already gone", () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-registry-"));
  try {
    writeRegistryAtomic("thing.json", { a: 1 }, { baseDir: dir });
    assert.ok(existsSync(join(dir, "thing.json")));
    clearRegistry("thing.json", { baseDir: dir });
    assert.equal(existsSync(join(dir, "thing.json")), false);
    // Second call on an already-absent file must not throw.
    clearRegistry("thing.json", { baseDir: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("isPidAlive is true for this process's own pid", () => {
  assert.equal(isPidAlive(process.pid), true);
});

test("isPidAlive is false for a pid that doesn't exist", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"]);
  const exitedPid = await new Promise((resolve) => child.once("exit", () => resolve(child.pid)));
  // Give the OS a beat to fully reap the process/pid slot.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(isPidAlive(exitedPid), false);
});

test("isPidAlive rejects non-positive/non-integer input without throwing", () => {
  assert.equal(isPidAlive(0), false);
  assert.equal(isPidAlive(-5), false);
  assert.equal(isPidAlive(1.5), false);
  assert.equal(isPidAlive(undefined), false);
});

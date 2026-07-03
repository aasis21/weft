// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getOrCreateDeviceId } from "../src/deviceIdentity.mjs";

test("getOrCreateDeviceId persists a stable, non-secret id across calls (restarts)", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "helm-device-id-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const first = getOrCreateDeviceId({ baseDir: dir });
  assert.ok(first, "mints an id on first call");

  const second = getOrCreateDeviceId({ baseDir: dir });
  assert.equal(second, first, "reuses the persisted id on a later call (simulating a restart)");

  const onDisk = readFileSync(join(dir, "device-id"), "utf8").trim();
  assert.equal(onDisk, first, "the id is actually persisted to disk");
});

test("getOrCreateDeviceId mints independent ids for independent homes", async (t) => {
  const dirA = mkdtempSync(join(tmpdir(), "helm-device-id-a-"));
  const dirB = mkdtempSync(join(tmpdir(), "helm-device-id-b-"));
  t.after(() => {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  });

  const a = getOrCreateDeviceId({ baseDir: dirA });
  const b = getOrCreateDeviceId({ baseDir: dirB });
  assert.notEqual(a, b);
});

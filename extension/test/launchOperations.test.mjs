// SPDX-License-Identifier: Apache-2.0
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  beginLaunchOperation,
  launchOperationPath,
  listLaunchOperations,
  pruneLaunchOperations,
  publicLaunchDetails,
  readLaunchOperation,
  updateLaunchOperation,
} from "../src/launchOperations.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), "weft-launch-operations-"));
  dirs.push(dir);
  return dir;
}

test("duplicate request fields replay one durable entry while conflicts are rejected", async () => {
  const baseDir = home();
  const request = {
    requestId: "req-1",
    operation: "new",
    projectName: "app",
    mode: "allow-all",
    name: "phone",
  };
  const first = await beginLaunchOperation(request, { baseDir, now: 10 });
  const duplicate = await beginLaunchOperation({ ...request }, { baseDir, now: 20 });
  const conflict = await beginLaunchOperation({ ...request, projectName: "other" }, { baseDir, now: 30 });
  assert.equal(first.kind, "created");
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.record.ownerToken, first.record.ownerToken);
  assert.equal(conflict.kind, "conflict");
  assert.equal(listLaunchOperations({ baseDir }).length, 1);
});

test("operations survive module-style restart reads and late readiness cannot regress", async () => {
  const baseDir = home();
  const first = await beginLaunchOperation(
    { requestId: "req-ready", operation: "new", projectName: "app" },
    { baseDir, now: 10 },
  );
  const ready = await updateLaunchOperation(
    "req-ready",
    { state: "ready", pairingPayload: { v: 1, channelId: "c", pub: "p" } },
    { baseDir, ownerToken: first.record.ownerToken, now: 30 },
  );
  const lateStationWrite = await updateLaunchOperation(
    "req-ready",
    { state: "launched", pid: 42 },
    { baseDir, ownerToken: first.record.ownerToken, now: 40 },
  );
  assert.equal(readLaunchOperation("req-ready", { baseDir }).state, "ready");
  assert.equal(lateStationWrite.state, "ready");
  assert.equal(lateStationWrite.pid, 42);
  assert.equal(ready.readyAt, 30);
  assert.equal(
    await updateLaunchOperation("req-ready", { state: "claimed" }, { baseDir, ownerToken: "wrong" }),
    null,
    "a different owner cannot mutate the entry",
  );
});

test("a different unresolved resume request is tombstoned and never acquires the reservation", async () => {
  const baseDir = home();
  const first = await beginLaunchOperation(
    { requestId: "resume-1", operation: "resume", sessionId: "sid-1" },
    { baseDir, now: 10 },
  );
  const second = await beginLaunchOperation(
    { requestId: "resume-2", operation: "resume", sessionId: "sid-1" },
    { baseDir, now: 20 },
  );
  assert.equal(first.kind, "created");
  assert.equal(second.kind, "reserved");
  assert.equal(second.record.state, "failed");
  assert.match(second.record.error, /resume-1/);

  await updateLaunchOperation(
    "resume-1",
    { state: "claimed" },
    { baseDir, ownerToken: first.record.ownerToken, now: 30 },
  );
  const third = await beginLaunchOperation(
    { requestId: "resume-3", operation: "resume", sessionId: "sid-1" },
    { baseDir, now: 40 },
  );
  assert.equal(third.kind, "created", "a terminal owner releases the reservation explicitly");
});

test("pruning keeps resume safety, abandons stale new launches, and later removes tombstones", async () => {
  const baseDir = home();
  const oldNew = await beginLaunchOperation(
    { requestId: "old-new", operation: "new", projectName: "app" },
    { baseDir, now: 1 },
  );
  const oldResume = await beginLaunchOperation(
    { requestId: "old-resume", operation: "resume", sessionId: "sid-old" },
    { baseDir, now: 1 },
  );
  await pruneLaunchOperations({ baseDir, now: 1_000, unresolvedNewTtlMs: 100, resolvedTtlMs: 100 });
  assert.equal(readLaunchOperation("old-new", { baseDir }).state, "abandoned");
  assert.equal(readLaunchOperation("old-resume", { baseDir }).state, "accepted");

  await pruneLaunchOperations({ baseDir, now: 1_200, unresolvedNewTtlMs: 100, resolvedTtlMs: 100 });
  assert.equal(existsSync(launchOperationPath("old-new", { baseDir })), false);
  assert.equal(readLaunchOperation("old-resume", { baseDir }).ownerToken, oldResume.record.ownerToken);
  assert.ok(oldNew.record.ownerToken);
});

test("public launch details omit ownership and private identity material", async () => {
  const baseDir = home();
  const first = await beginLaunchOperation(
    { requestId: "req-public", operation: "new", projectName: "app" },
    { baseDir },
  );
  const record = await updateLaunchOperation(
    "req-public",
    {
      state: "launched",
      identityFile: "private.json",
      pairingPayload: { v: 1, channelId: "c", pub: "p" },
    },
    { baseDir, ownerToken: first.record.ownerToken },
  );
  const details = publicLaunchDetails(record);
  assert.equal(details.identityFile, undefined);
  assert.equal(details.ownerToken, undefined);
  assert.deepEqual(details.payload, record.pairingPayload);
});

test("terminal tombstones replay forever until pruning and cannot be overwritten", async () => {
  const baseDir = home();
  const first = await beginLaunchOperation(
    { requestId: "req-terminal", operation: "new", projectName: "app" },
    { baseDir, now: 10 },
  );
  const failed = await updateLaunchOperation(
    "req-terminal",
    { state: "failed", error: "spawn failed" },
    { baseDir, ownerToken: first.record.ownerToken, now: 20 },
  );
  const duplicate = await beginLaunchOperation(
    { requestId: "req-terminal", operation: "new", projectName: "app" },
    { baseDir, now: 30 },
  );
  const staleReady = await updateLaunchOperation(
    "req-terminal",
    { state: "ready", error: null },
    { baseDir, ownerToken: first.record.ownerToken, now: 40 },
  );
  assert.equal(duplicate.kind, "duplicate");
  assert.equal(duplicate.record.state, "failed");
  assert.equal(staleReady.state, "failed");
  assert.equal(staleReady.error, failed.error);
});

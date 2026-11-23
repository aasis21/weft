// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REQUEST_RETENTION_MS, createOpenRequests, sessionLockName } from "../src/openRequests.mjs";

function fixture(t, now = () => 1_000) {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-open-requests-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  return { baseDir, requests: createOpenRequests({ baseDir, now }) };
}

const KEY = { storeAuthority: "sha256:store", sessionId: "session-a" };
const begin = (requests, requestId, overrides = {}) => requests.begin({
  requestId, fingerprint: "fp-1", requester: "phone-1", target: { sessionId: KEY.sessionId, storeAuthority: KEY.storeAuthority },
  options: { permissionMode: "default", title: null }, lockKey: KEY, ...overrides,
});

test("the same request replays one durable entry; a reused id with other fields is a conflict", async (t) => {
  const { baseDir, requests } = fixture(t);
  const created = await begin(requests, "open-1");
  assert.equal(created.kind, "created");
  assert.equal(created.record.stage, "accepted");
  assert.equal(created.record.revision, 0);
  const duplicate = await begin(requests, "open-1");
  assert.equal(duplicate.kind, "duplicate");
  assert.deepEqual(duplicate.record, created.record);
  assert.equal((await begin(requests, "open-1", { fingerprint: "fp-2" })).kind, "conflict");
  assert.deepEqual(createOpenRequests({ baseDir }).read("open-1"), created.record, "a restarted Station reads the same entry");
});

test("revisions only grow, stages never move back, and terminal outcomes never change", async (t) => {
  const { requests } = fixture(t);
  const { record } = await begin(requests, "open-1");
  const resolving = await requests.update("open-1", { stage: "resolving" }, { expectRevision: record.revision });
  assert.equal(resolving.applied, true);
  assert.equal(resolving.record.revision, 1);
  const stale = await requests.update("open-1", { stage: "dispatching" }, { expectRevision: 0 });
  assert.equal(stale.applied, false, "a stale revision never applies");
  const dispatched = await requests.update("open-1", { stage: "dispatching", result: { action: "resume" } });
  assert.ok(dispatched.record.dispatchedAt);
  const back = await requests.update("open-1", { stage: "resolving" });
  assert.equal(back.record.stage, "dispatching", "stage order is monotonic");
  const done = await requests.update("open-1", { outcome: "done", result: { runtimeId: "r" } });
  assert.deepEqual(done.record.result, { action: "resume", runtimeId: "r" }, "results merge");
  assert.ok(done.record.finishedAt);
  const after = await requests.update("open-1", { outcome: "cancelled" });
  assert.equal(after.applied, false);
  assert.equal(requests.read("open-1").outcome, "done");
  assert.ok(after.record.revision > back.record.revision - 1);
});

test("one non-terminal request holds a saved session; a second one joins it until the first ends", async (t) => {
  const { requests } = fixture(t);
  await begin(requests, "open-1");
  const second = await begin(requests, "open-2", { fingerprint: "fp-other" });
  assert.equal(second.kind, "joined");
  assert.equal(second.record.joinedRequestId, "open-1");
  assert.equal(second.record.lockKey, null, "a follower never holds the lock");
  await requests.update("open-1", { outcome: "failed", reason: "not-found" });
  const third = await begin(requests, "open-3", { fingerprint: "fp-3" });
  assert.equal(third.kind, "created", "the lock is released with the terminal outcome");
  const other = await begin(requests, "open-4", { lockKey: { ...KEY, sessionId: "session-b" } });
  assert.equal(other.kind, "created", "independent sessions never wait on each other");
});

test("Station start recovers locks whose request ended or vanished, never a live one", async (t) => {
  const { baseDir, requests } = fixture(t);
  await begin(requests, "open-live");
  const lockDir = join(baseDir, "requests", ".by-session");
  writeFileSync(join(lockDir, sessionLockName({ ...KEY, sessionId: "ghost" })), JSON.stringify({ requestId: "vanished" }));
  requests.recoverLocks();
  assert.deepEqual(readdirSync(lockDir), [sessionLockName(KEY)]);
});

test("finished requests are pruned after three days unless a live session still references them", async (t) => {
  let clock = 1_000;
  const { requests } = fixture(t, () => clock);
  for (const id of ["old-done", "old-referenced", "fresh-done", "never-finished"]) {
    await begin(requests, id, { lockKey: { ...KEY, sessionId: id } });
  }
  for (const id of ["old-done", "old-referenced"]) await requests.update(id, { outcome: "done" });
  clock += REQUEST_RETENTION_MS + 1;
  await requests.update("fresh-done", { outcome: "cancelled" });
  clock += 10;
  const removed = requests.prune({ at: clock, isReferenced: (id) => id === "old-referenced" });
  assert.equal(removed, 1);
  assert.equal(requests.read("old-done"), null);
  for (const id of ["old-referenced", "fresh-done", "never-finished"]) assert.ok(requests.read(id), id);
});

test("the private launch identity lives inside the request folder", async (t) => {
  const { baseDir, requests } = fixture(t);
  await begin(requests, "open-1");
  const file = requests.identityPath("open-1");
  assert.ok(file.startsWith(join(baseDir, "requests")));
  assert.ok(file.endsWith("identity.json"));
  assert.ok(existsSync(join(file, "..")));
});

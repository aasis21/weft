// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTACT_WRITE_INTERVAL_MS,
  FAILURE_WRITE_INTERVAL_MS,
  capabilityPath,
  cleanupLegacyStores,
  createCachedVerifier,
  getTerminalInstanceId,
  liveDirectory,
  liveOffers,
  nextSessionRuntime,
  ownerOf,
  publishSessionRecord,
  readSessionCapability,
  recordPath,
  scanSessions,
} from "../src/sessionRegistry.mjs";

function fixture(t) {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-session-registry-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  return baseDir;
}

const KEY = { storeAuthority: "sha256:store", sessionId: "session-a" };

function publish(baseDir, { runtimeId = "runtime-a", session = KEY, pid = 4242, processStartedAt = 100, generation = 1, ...rest } = {}, options = {}) {
  return publishSessionRecord({
    session,
    run: { runtimeId, generation, pid, processStartedAt, terminalInstanceId: "terminal-a", version: "0.2.75", ...rest.run },
    pipe: `pipe-${runtimeId}`,
    ...(rest.link ? { link: rest.link } : {}),
  }, { baseDir, now: () => 1_000, ...options });
}

const liveFor = (pids) => async (candidates) => candidates.map(({ pid }) =>
  pids[pid] === "dead" ? { live: false, reason: "process-exited" }
    : pids[pid] === "unknown" ? { live: null, reason: "process-unverifiable" }
      : pids[pid] === "reused" ? { live: false, reason: "pid-reused" }
        : { live: true });

test("runtime identity is stable across reloads in one process while the generation advances", () => {
  const scope = {};
  const first = nextSessionRuntime(KEY, { scope, randomId: () => "runtime-x" });
  const reload = nextSessionRuntime(KEY, { scope, randomId: () => "runtime-y" });
  assert.equal(reload.runtimeId, first.runtimeId, "a reload keeps the record file: no ownership gap");
  assert.equal(reload.generation, first.generation + 1);
  assert.equal(getTerminalInstanceId({ scope, randomId: () => "t" }), getTerminalInstanceId({ scope }));
  const other = nextSessionRuntime({ ...KEY, sessionId: "session-b" }, { scope, randomId: () => "runtime-z" });
  assert.equal(other.runtimeId, "runtime-z");
});

test("a session publishes one private record + capability and the record matches LLD §3.1", async (t) => {
  const baseDir = fixture(t);
  const handle = await publish(baseDir, { run: { openedBy: { kind: "station", requestId: "open-1" } } });
  t.after(() => handle.close());
  const raw = JSON.parse(readFileSync(recordPath("runtime-a", { baseDir }), "utf8"));
  assert.equal(raw.schema, 1);
  assert.deepEqual(raw.session, KEY);
  assert.deepEqual(raw.run.openedBy, { kind: "station", requestId: "open-1" });
  assert.equal(raw.control.pipe, "pipe-runtime-a");
  assert.equal(raw.link.state, "dormant");
  assert.equal(readSessionCapability("runtime-a", { baseDir }), handle.capability);
  if (process.platform !== "win32") {
    assert.equal(statSync(capabilityPath("runtime-a", { baseDir })).mode & 0o777, 0o600);
    assert.equal(statSync(recordPath("runtime-a", { baseDir })).mode & 0o777, 0o600);
  }
});

test("state writes are immediate, failures ≤1/10 s and contact ≤1/60 s, and throttled facts are kept", async (t) => {
  const baseDir = fixture(t);
  let clock = 1_000;
  const timers = [];
  const handle = await publish(baseDir, {}, {
    now: () => clock,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  t.after(() => handle.close());
  const disk = () => JSON.parse(readFileSync(recordPath("runtime-a", { baseDir }), "utf8")).link;

  handle.update({ link: { state: "connecting", generation: 1 } });
  assert.equal(disk().state, "connecting");
  handle.update({ link: { lastError: { code: "subscribe-timeout", at: clock } } }, { kind: "failure" });
  assert.equal(disk().lastError.code, "subscribe-timeout");
  clock += 1_000;
  handle.update({ link: { lastError: { code: "relay-unreachable", at: clock }, attempt: 2 } }, { kind: "failure" });
  assert.equal(disk().lastError.code, "subscribe-timeout", "second failure within 10 s is throttled");
  assert.equal(handle.record.link.lastError.code, "relay-unreachable", "but kept in memory");
  assert.equal(timers.at(-1).ms, FAILURE_WRITE_INTERVAL_MS - 1_000);
  clock += FAILURE_WRITE_INTERVAL_MS;
  timers.at(-1).fn();
  assert.equal(disk().lastError.code, "relay-unreachable", "the deferred write flushes the newest facts");

  handle.update({ link: { lastPhoneContactAt: clock } }, { kind: "contact" });
  const firstContact = disk().lastPhoneContactAt;
  clock += 5_000;
  handle.update({ link: { lastPhoneContactAt: clock } }, { kind: "contact" });
  assert.equal(disk().lastPhoneContactAt, firstContact);
  assert.equal(timers.at(-1).ms, CONTACT_WRITE_INTERVAL_MS - 5_000);
  handle.update({ link: { state: "linked" } });
  assert.equal(disk().lastPhoneContactAt, clock, "a state change flushes everything pending");
});

test("updates cannot change ownership fields", async (t) => {
  const baseDir = fixture(t);
  const handle = await publish(baseDir);
  t.after(() => handle.close());
  handle.update({ run: { pid: 1, processStartedAt: 5 }, link: { state: "waiting" } });
  assert.equal(handle.record.run.pid, 4242);
  assert.equal(handle.record.run.processStartedAt, 100);
  assert.throws(() => handle.update({ run: { runtimeId: "other" } }), /invalid/);
});

test("a reload takes the same record over in place; anything else cannot overwrite it", async (t) => {
  const baseDir = fixture(t);
  const first = await publish(baseDir, { generation: 1 }, { capability: "first-capability-0123456789" });
  first.close({ remove: false });
  await assert.rejects(
    publish(baseDir, { generation: 2, pid: 9999 }, { capability: "intruder-capability-01234567" }),
    (error) => error.code === "EEXIST",
  );
  await assert.rejects(publish(baseDir, { generation: 1 }), (error) => error.code === "EEXIST");
  const reload = await publish(baseDir, { generation: 2 }, { capability: "second-capability-0123456789" });
  t.after(() => reload.close());
  assert.equal(readSessionCapability("runtime-a", { baseDir }), "second-capability-0123456789");
  assert.equal(JSON.parse(readFileSync(recordPath("runtime-a", { baseDir }), "utf8")).run.generation, 2);
  first.close();
  assert.ok(existsSync(recordPath("runtime-a", { baseDir })), "a stale handle never deletes its successor");
});

test("discovery deletes only PROVEN-dead records and keeps unverifiable ones as unknown owners", async (t) => {
  const baseDir = fixture(t);
  await publish(baseDir, { runtimeId: "exited", pid: 10 });
  await publish(baseDir, { runtimeId: "reused", pid: 11, session: { ...KEY, sessionId: "session-b" } });
  await publish(baseDir, { runtimeId: "unknown", pid: 12, session: { ...KEY, sessionId: "session-c" } });
  const live = await publish(baseDir, { runtimeId: "live", pid: 13, session: { ...KEY, sessionId: "session-d" } });
  t.after(() => live.close());
  writeFileSync(join(liveDirectory({ baseDir }), "corrupt.json"), "{broken");
  const old = (Date.now() - 60 * 60_000) / 1000;
  utimesSync(join(liveDirectory({ baseDir }), "corrupt.json"), old, old);

  const scan = await scanSessions({ baseDir, verifyBatch: liveFor({ 10: "dead", 11: "reused", 12: "unknown" }), legacy: false });
  assert.deepEqual(scan.dead.sort(), ["exited", "reused"]);
  assert.equal(scan.live.length, 1);
  assert.equal(scan.unverified[0].runtimeId, "unknown");
  assert.ok(!existsSync(recordPath("exited", { baseDir })));
  assert.ok(!existsSync(capabilityPath("reused", { baseDir })));
  assert.ok(existsSync(recordPath("unknown", { baseDir })), "unverifiable is never deleted");
  assert.ok(!existsSync(join(liveDirectory({ baseDir }), "corrupt.json")));
  assert.deepEqual(ownerOf(scan, { ...KEY, sessionId: "session-c" }), { state: "unknown", reason: "unverifiable" });
  assert.equal(ownerOf(scan, { ...KEY, sessionId: "session-d" }).state, "live");
  assert.deepEqual(ownerOf(scan, { ...KEY, sessionId: "session-a" }), { state: "none" });
});

test("two live runtimes for one saved session are an owner conflict; independent sessions are not", async (t) => {
  const baseDir = fixture(t);
  const one = await publish(baseDir, { runtimeId: "one", pid: 20 });
  const two = await publish(baseDir, { runtimeId: "two", pid: 21 });
  const other = await publish(baseDir, { runtimeId: "three", pid: 22, session: { ...KEY, sessionId: "session-b" } });
  t.after(() => { one.close(); two.close(); other.close(); });
  const scan = await scanSessions({ baseDir, verifyBatch: liveFor({}), legacy: false });
  const groups = Object.fromEntries(scan.sessions.map((group) => [group.key.sessionId, group]));
  assert.equal(groups["session-a"].ownerConflict, true);
  assert.equal(groups["session-b"].ownerConflict, false);
  assert.equal(ownerOf(scan, KEY).state, "conflict");
});

test("another Weft version's live record and a pending launch both block `none`", async (t) => {
  const baseDir = fixture(t);
  mkdirSync(liveDirectory({ baseDir }), { recursive: true });
  writeFileSync(recordPath("future", { baseDir }), JSON.stringify({
    schema: 2, session: KEY, run: { runtimeId: "future", pid: 30, processStartedAt: 5 },
  }));
  const scan = await scanSessions({ baseDir, verifyBatch: liveFor({}), legacy: false });
  assert.equal(scan.foreign.length, 1);
  assert.deepEqual(ownerOf(scan, KEY), { state: "unknown", reason: "other-version" });
  const empty = await scanSessions({ baseDir: fixture(t), verifyBatch: liveFor({}), legacy: false });
  assert.deepEqual(ownerOf(empty, KEY, { launches: [{ ...KEY, alive: true }] }), { state: "unknown", reason: "launch-pending" });
});

test("pre-0.2.75 stores are removed only for dead processes; live old owners stay owner-unknown", async (t) => {
  const baseDir = fixture(t);
  const runtimeDir = (id) => join(baseDir, "runtimes", "v1", id);
  for (const [id, pid, sessionId] of [["old-live", 50, "session-old"], ["old-dead", 51, "session-dead"]]) {
    mkdirSync(runtimeDir(id), { recursive: true });
    writeFileSync(join(runtimeDir(id), "presence.json"), JSON.stringify({
      storeAuthority: KEY.storeAuthority, sessionId, pid, processStartedAt: 7,
    }));
  }
  writeFileSync(join(baseDir, "attached-sessions.json"), JSON.stringify({ "session-attached": { sessionId: "session-attached", pid: 60 } }));
  writeFileSync(join(baseDir, "pending-sessions.json"), JSON.stringify({ chan: { pid: 61, payload: {} } }));
  mkdirSync(join(baseDir, "launch-operations"), { recursive: true });
  writeFileSync(join(baseDir, "launch-operations", "op.json"), JSON.stringify({ pid: 62, sessionId: "session-launch" }));
  for (const name of ["launch-reservations", "launch-identities"]) mkdirSync(join(baseDir, name), { recursive: true });

  const alive = new Set([50]);
  const owners = await cleanupLegacyStores({
    baseDir,
    isAlive: (pid) => alive.has(pid),
    verifyBatch: async (items) => items.map(({ pid }) => ({ live: alive.has(pid) ? true : false })),
  });
  assert.deepEqual(owners.map((owner) => owner.sessionId), ["session-old"]);
  assert.ok(existsSync(runtimeDir("old-live")));
  assert.ok(!existsSync(runtimeDir("old-dead")));
  for (const name of ["attached-sessions.json", "pending-sessions.json", "launch-operations", "launch-reservations", "launch-identities"]) {
    assert.ok(!existsSync(join(baseDir, name)), `${name} is removed once its processes are dead`);
  }
  const scan = await scanSessions({ baseDir, verifyBatch: async (items) => items.map(({ pid }) => ({ live: alive.has(pid) })) });
  assert.deepEqual(ownerOf(scan, { ...KEY, sessionId: "session-old" }), { state: "unknown", reason: "other-version" });

  alive.clear();
  await cleanupLegacyStores({ baseDir, isAlive: () => false, verifyBatch: async (items) => items.map(() => ({ live: false })) });
  assert.ok(!existsSync(join(baseDir, "runtimes")));
});

test("live attached owners from an old version block their session too", async (t) => {
  const baseDir = fixture(t);
  writeFileSync(join(baseDir, "attached-sessions.json"), JSON.stringify({ "session-x": { sessionId: "session-x", pid: 70 } }));
  const owners = await cleanupLegacyStores({ baseDir, isAlive: (pid) => pid === 70, verifyBatch: async () => [] });
  assert.equal(owners[0].sessionId, "session-x");
  assert.ok(existsSync(join(baseDir, "attached-sessions.json")));
});

test("pairing offers live in the record; Station derives expiry and the owner withdraws them", async (t) => {
  const baseDir = fixture(t);
  const handle = await publish(baseDir);
  t.after(() => handle.close());
  const payload = { channelId: "chan-offer", token: "t", expiresAt: Date.now() + 60_000 };
  handle.update({ offer: { channelId: "chan-offer", name: "app", cwd: "/w/app", payload, expiresAt: payload.expiresAt } });
  let scan = await scanSessions({ baseDir, verifyBatch: liveFor({}), legacy: false });
  assert.deepEqual(liveOffers(scan).map((offer) => offer.channelId), ["chan-offer"]);
  assert.deepEqual(liveOffers(scan, { now: payload.expiresAt + 1 }), [], "expired offers are not relayed");
  handle.update({ offer: null });
  scan = await scanSessions({ baseDir, verifyBatch: liveFor({}), legacy: false });
  assert.deepEqual(liveOffers(scan), []);
});

test("clean close removes the record and capability", async (t) => {
  const baseDir = fixture(t);
  const handle = await publish(baseDir);
  handle.close();
  assert.ok(!existsSync(recordPath("runtime-a", { baseDir })));
  assert.ok(!existsSync(capabilityPath("runtime-a", { baseDir })));
});

test("Station's cached verifier re-proves start times periodically and reports a dead pid at once", async () => {
  let clock = 0;
  let batches = 0;
  const alive = new Set([1, 2]);
  const verify = createCachedVerifier({
    now: () => clock,
    maxAgeMs: 1_000,
    isAlive: (pid) => alive.has(pid),
    verifyBatch: async (items) => { batches += 1; return items.map(({ pid }) => ({ live: alive.has(pid) })); },
  });
  const items = [{ pid: 1, processStartedAt: 5 }, { pid: 2, processStartedAt: 6 }];
  assert.deepEqual((await verify(items)).map((proof) => proof.live), [true, true]);
  assert.deepEqual((await verify(items)).map((proof) => proof.live), [true, true]);
  assert.equal(batches, 1, "a recent proof is reused");
  alive.delete(2);
  assert.deepEqual((await verify(items)).map((proof) => proof.live), [true, false], "a dead pid is never cached as live");
  clock += 1_001;
  await verify(items.slice(0, 1));
  assert.equal(batches, 2, "proofs expire and are fully re-verified");
});

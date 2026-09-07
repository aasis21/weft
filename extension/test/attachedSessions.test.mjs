// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ATTACHED_SESSIONS_FILE,
  HEALTHY_WINDOW_MS,
  clearAttachedSession,
  findAttachedSession,
  listAttachedSessions,
  recordAttachedSession,
  terminateAttachedSession,
} from "../src/attachedSessions.mjs";
import { readRegistry, writeRegistryAtomic } from "../src/registryFile.mjs";

let dirs = [];
const NOW = 1_800_000_000_000;
const home = () => {
  const d = mkdtempSync(join(tmpdir(), "weft-attached-"));
  dirs.push(d);
  return d;
};

function retryRegistryMutation(mutate, complete, message) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    mutate();
    if (complete()) return;
  }
  assert.fail(message);
}

function recordPersisted(session, options) {
  retryRegistryMutation(
    () => recordAttachedSession(session, options),
    () => {
      const entry = readRegistry(ATTACHED_SESSIONS_FILE, options)?.[session.sessionId];
      return (
        entry?.channelId === session.channelId &&
        (options.now === undefined || entry.lastHealthyAt === options.now)
      );
    },
    `attachment ${session.sessionId} was not persisted`,
  );
}

function clearPersisted(sessionId, options) {
  retryRegistryMutation(
    () => clearAttachedSession(sessionId, options),
    () => !readRegistry(ATTACHED_SESSIONS_FILE, options)?.[sessionId],
    `attachment ${sessionId} was not cleared`,
  );
}

test.afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

test("an attachment round-trips and is reported healthy while it keeps stamping", () => {
  const baseDir = home();
  assert.equal(findAttachedSession("sid-1", { baseDir }), null, "nothing is attached to begin with");

  recordPersisted(
    { sessionId: "sid-1", channelId: "chan-1", cwd: "/repo" },
    { baseDir, now: NOW },
  );
  const found = findAttachedSession("sid-1", { baseDir, now: NOW + HEALTHY_WINDOW_MS - 1 });
  assert.equal(found.channelId, "chan-1");
  assert.equal(found.cwd, "/repo");
  assert.equal(found.pid, process.pid);
  assert.equal(found.healthy, true);
});

test("an attachment that stops stamping is unhealthy but still identifies a live writer", () => {
  const baseDir = home();
  const stale = 0;
  recordPersisted({ sessionId: "sid-1", channelId: "chan-1" }, { baseDir, now: stale });

  const found = findAttachedSession("sid-1", { baseDir, now: NOW });
  assert.equal(found.pid, process.pid, "the process is alive — a pid guard would say 'attached'");
  assert.equal(found.healthy, false, "it has stopped proving its phone connection");
});

test("takeover requires exact registry ownership and confirmed process exit", async () => {
  const baseDir = home();
  recordPersisted({ sessionId: "sid-1", channelId: "chan-1" }, { baseDir });
  const killed = [];
  let alive = true;
  const result = await terminateAttachedSession("sid-1", {
    baseDir,
    expectedPid: process.pid,
    expectedChannelId: "chan-1",
    timeoutMs: 100,
    pollMs: 1,
    killFn: (pid, signal) => {
      killed.push([pid, signal]);
      alive = false;
    },
    isPidAliveFn: () => alive,
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(killed, [[process.pid, "SIGTERM"]]);

  const refused = await terminateAttachedSession("sid-1", {
    baseDir,
    expectedPid: process.pid,
    expectedChannelId: "wrong-channel",
    killFn: () => assert.fail("must not signal an unproven owner"),
  });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /prove ownership/);
});

test("takeover refuses a stale attachment because its live pid may have been reused", async () => {
  const baseDir = home();
  recordPersisted(
    { sessionId: "sid-stale", channelId: "chan-stale" },
    { baseDir, now: 0 },
  );
  const result = await terminateAttachedSession("sid-stale", {
    baseDir,
    expectedPid: process.pid,
    expectedChannelId: "chan-stale",
    killFn: () => assert.fail("must not signal an unproven stale pid"),
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /prove ownership/);
});

test("explicit takeover may terminate an unhealthy attachment after exact ownership checks", async () => {
  const baseDir = home();
  recordPersisted(
    { sessionId: "sid-wedged", channelId: "chan-wedged" },
    { baseDir, now: 0 },
  );
  let alive = true;
  const result = await terminateAttachedSession("sid-wedged", {
    baseDir,
    expectedPid: process.pid,
    expectedChannelId: "chan-wedged",
    requireHealthy: false,
    timeoutMs: 100,
    pollMs: 1,
    killFn: () => {
      alive = false;
    },
    isPidAliveFn: () => alive,
  });
  assert.deepEqual(result, { ok: true });
});

test("re-recording refreshes the heartbeat stamp without moving boundAt", () => {
  const baseDir = home();
  const t0 = NOW - 60_000;
  recordPersisted({ sessionId: "sid-1", channelId: "chan-1", cwd: "/repo" }, { baseDir, now: t0 });
  recordPersisted({ sessionId: "sid-1", channelId: "chan-1" }, { baseDir, now: t0 + 45_000 });

  const found = findAttachedSession("sid-1", { baseDir });
  assert.equal(found.boundAt, t0, "the attachment is the same one, not a new one");
  assert.equal(found.lastHealthyAt, t0 + 45_000);
  assert.equal(found.cwd, "/repo", "cwd carries over when a refresh omits it");
});

test("clearing is idempotent and leaves other sessions alone", () => {
  const baseDir = home();
  recordPersisted({ sessionId: "sid-1", channelId: "chan-1" }, { baseDir });
  recordPersisted({ sessionId: "sid-2", channelId: "chan-2" }, { baseDir });

  clearPersisted("sid-1", { baseDir });
  clearPersisted("sid-1", { baseDir });

  assert.equal(findAttachedSession("sid-1", { baseDir }), null);
  assert.equal(findAttachedSession("sid-2", { baseDir })?.channelId, "chan-2");
  assert.equal(listAttachedSessions({ baseDir }).length, 1);
});

test("a session that died without cleaning up is pruned on read", () => {
  const baseDir = home();
  recordPersisted({ sessionId: "sid-1", channelId: "chan-1" }, { baseDir });
  recordPersisted({ sessionId: "sid-2", channelId: "chan-2" }, { baseDir });

  // Stand in for a crashed session: rewrite one entry under a pid that cannot be running.
  const map = readRegistry(ATTACHED_SESSIONS_FILE, { baseDir });
  map["sid-1"] = { ...map["sid-1"], pid: 0x7ffffffe };
  retryRegistryMutation(
    () => writeRegistryAtomic(ATTACHED_SESSIONS_FILE, map, { baseDir }),
    () => readRegistry(ATTACHED_SESSIONS_FILE, { baseDir })?.["sid-1"]?.pid === 0x7ffffffe,
    "dead attachment fixture was not persisted",
  );

  assert.equal(findAttachedSession("sid-1", { baseDir }), null, "the dead entry self-heals away");
  assert.equal(listAttachedSessions({ baseDir }).length, 1);
});

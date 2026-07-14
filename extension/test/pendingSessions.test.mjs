// SPDX-License-Identifier: Apache-2.0
// Coverage for the laptop-side pending `/weft` offer registry (the mirror of the spawn flow):
// station discovery, register/list/remove with single-writer ownership, dead-pid self-healing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeRegistryAtomic } from "../src/registryFile.mjs";
import {
  isStationRunning,
  listPendingSessions,
  registerPendingSession,
  removePendingSession,
  PENDING_SESSIONS_FILE,
} from "../src/pendingSessions.mjs";

// A pid that is essentially guaranteed not to map to a live process (max 32-bit pid space).
const DEAD_PID = 2147483646;
const PAYLOAD = { v: 1, channelId: "c-abc", pub: "PUB", transport: { kind: "local" } };

function withTempHome(fn) {
  const dir = mkdtempSync(join(tmpdir(), "weft-pending-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("isStationRunning tracks the listener.lock bare pid", () => {
  withTempHome((dir) => {
    assert.equal(isStationRunning({ baseDir: dir }), false, "no lock file → no station");
    writeRegistryAtomic("listener.lock", process.pid, { baseDir: dir });
    assert.equal(isStationRunning({ baseDir: dir }), true, "our own live pid reads as running");
    writeRegistryAtomic("listener.lock", DEAD_PID, { baseDir: dir });
    assert.equal(isStationRunning({ baseDir: dir }), false, "a dead pid reads as not running");
  });
});

test("register → list → remove round-trips a single owned offer", () => {
  withTempHome((dir) => {
    assert.deepEqual(listPendingSessions({ baseDir: dir }), [], "empty to start");

    const ok = registerPendingSession(
      { channelId: "c-abc", name: "web", cwd: "/repo/web", payload: PAYLOAD },
      { baseDir: dir },
    );
    assert.equal(ok, true);

    const listed = listPendingSessions({ baseDir: dir });
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], { channelId: "c-abc", name: "web", cwd: "/repo/web", payload: PAYLOAD });

    removePendingSession("c-abc", { baseDir: dir });
    assert.deepEqual(listPendingSessions({ baseDir: dir }), [], "removed offer is gone");
  });
});

test("registerPendingSession refuses entries missing channelId or payload", () => {
  withTempHome((dir) => {
    assert.equal(registerPendingSession({ channelId: "", payload: PAYLOAD }, { baseDir: dir }), false);
    assert.equal(registerPendingSession({ channelId: "c-x", payload: null }, { baseDir: dir }), false);
    assert.deepEqual(listPendingSessions({ baseDir: dir }), [], "nothing was written");
  });
});

test("list prunes dead-pid entries and normalizes blank name/cwd to null", () => {
  withTempHome((dir) => {
    // Hand-write a file mixing a dead owner and a malformed entry alongside a live one.
    writeRegistryAtomic(
      PENDING_SESSIONS_FILE,
      {
        "c-dead": { channelId: "c-dead", name: "old", cwd: "/x", payload: PAYLOAD, pid: DEAD_PID },
        "c-bad": { channelId: "c-bad", pid: process.pid }, // no payload → dropped by list filter
        "c-live": { channelId: "c-live", name: "", cwd: "", payload: PAYLOAD, pid: process.pid },
      },
      { baseDir: dir },
    );
    const listed = listPendingSessions({ baseDir: dir });
    assert.equal(listed.length, 1, "only the live, well-formed entry survives");
    assert.deepEqual(listed[0], { channelId: "c-live", name: null, cwd: null, payload: PAYLOAD });
  });
});

test("removePendingSession is idempotent and safe on an absent key", () => {
  withTempHome((dir) => {
    removePendingSession("never-registered", { baseDir: dir }); // must not throw
    registerPendingSession({ channelId: "c-abc", payload: PAYLOAD }, { baseDir: dir });
    removePendingSession("c-abc", { baseDir: dir });
    removePendingSession("c-abc", { baseDir: dir }); // second remove is a no-op
    assert.deepEqual(listPendingSessions({ baseDir: dir }), []);
  });
});

// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProcessStartTime, verifyProcessIdentity, verifyProcessIdentities } from "../src/processIdentity.mjs";

test("Windows and Unix process start times are normalized to epoch milliseconds", async () => {
  const windows = await getProcessStartTime(42, {
    platform: "win32",
    exec: async () => ({ stdout: "1700000000123\r\n" }),
  });
  const unix = await getProcessStartTime(42, {
    platform: "linux",
    exec: async () => ({ stdout: "Tue Nov 14 22:13:20 2023\n" }),
  });
  assert.equal(windows, 1_700_000_000_123);
  assert.equal(unix, Date.parse("Tue Nov 14 22:13:20 2023"));
});

test("process identity detects exit, PID reuse, and unverifiable ownership", async () => {
  assert.deepEqual(
    await verifyProcessIdentity(
      { pid: 42, processStartedAt: 1_000 },
      { isAlive: () => false },
    ),
    { live: false, reason: "process-exited" },
  );
  assert.deepEqual(
    await verifyProcessIdentity(
      { pid: 42, processStartedAt: 1_000 },
      { isAlive: () => true, getStartTime: async () => 5_000, toleranceMs: 10 },
    ),
    { live: false, reason: "pid-reused", actualStartedAt: 5_000 },
  );
  const uncertain = await verifyProcessIdentity(
    { pid: 42, processStartedAt: 1_000 },
    { isAlive: () => true, getStartTime: async () => { throw new Error("denied"); } },
  );
  assert.equal(uncertain.live, null);
  assert.equal(uncertain.reason, "process-unverifiable");
});

test("the current process can prove its OS start time", async () => {
  const processStartedAt = await getProcessStartTime(process.pid);
  const verified = await verifyProcessIdentity({ pid: process.pid, processStartedAt });
  assert.equal(verified.live, true);
});

test("batch verification queries each PID once and preserves reuse and uncertainty checks", async () => {
  let calls = 0;
  const result = await verifyProcessIdentities([
    { pid: 42, processStartedAt: 1000 },
    { pid: 42, processStartedAt: 9000 },
    { pid: 43, processStartedAt: 1000 },
    { pid: 44, processStartedAt: 1000 },
  ], {
    platform: "win32", toleranceMs: 10, isAlive: (pid) => pid !== 44,
    getStartTimes: async (pids) => { calls++; assert.deepEqual(pids, [42, 43]); return [{ pid: 42, startedAt: 1000 }]; },
  });
  assert.equal(calls, 1);
  assert.equal(result[0].live, true);
  assert.equal(result[1].reason, "pid-reused");
  assert.equal(result[2].live, null);
  assert.equal(result[3].reason, "process-exited");
  const unavailable = await verifyProcessIdentities([{ pid: 42, processStartedAt: 1000 }], {
    platform: "win32", isAlive: () => true, getStartTimes: async () => { throw new Error("permission denied"); },
  });
  assert.equal(unavailable[0].live, null);
  assert.equal(unavailable[0].reason, "process-unverifiable");
});

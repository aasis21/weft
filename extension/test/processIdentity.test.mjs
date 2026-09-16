// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { getProcessStartTime, verifyProcessIdentity } from "../src/processIdentity.mjs";

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

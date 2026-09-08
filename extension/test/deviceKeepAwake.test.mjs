// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { KEEP_AWAKE_MIN_MS, KEEP_AWAKE_MAX_MS } from "@aasis21/weft-shared";
import {
  createDeviceKeepAwakeController,
  createWindowsKeepAwakeHelper,
} from "../src/deviceKeepAwake.mjs";

const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
function harness(options = {}) {
  let clock = 1_000;
  const timers = new Map();
  const helpers = [];
  const pushes = [];
  const controller = createDeviceKeepAwakeController({
    platform: "win32",
    now: () => clock,
    setTimeoutFn: (callback, ms) => { const id = {}; timers.set(id, { callback, ms }); return id; },
    clearTimeoutFn: (id) => timers.delete(id),
    helperFactory: async (args) => {
      const helper = {
        args,
        updates: [],
        stops: 0,
        updateExpiry: async (expiry) => { helper.updates.push(expiry); },
        stop: () => { helper.stops++; },
      };
      helpers.push(helper);
      return helper;
    },
    ...options,
  });
  controller.onStatus((status) => pushes.push(status));
  return {
    controller, helpers, timers, pushes,
    advance(ms) { clock += ms; },
    async fire() {
      const callbacks = [...timers.values()];
      timers.clear();
      for (const { callback } of callbacks) callback();
      await tick();
    },
  };
}

test("Keep Awake starts, extends without shortening, replaces using one helper, and correlates stopped leases", async () => {
  const h = harness();
  const first = await h.controller.start({ leaseId: "one", durationMs: 60 * 60_000 });
  assert.deepEqual(first, { leaseId: "one", active: true, expiresAt: 3_601_000, revision: 1, code: "ok" });
  const shorter = await h.controller.start({ leaseId: "one", durationMs: 1 });
  assert.deepEqual(shorter, first);
  h.advance(60_000);
  const extended = await h.controller.start({ leaseId: "one", durationMs: KEEP_AWAKE_MAX_MS * 10 });
  assert.equal(extended.expiresAt, 61_000 + KEEP_AWAKE_MAX_MS);
  assert.equal(extended.revision, 2);
  const replaced = await h.controller.start({ leaseId: "two", durationMs: KEEP_AWAKE_MIN_MS });
  assert.equal(replaced.leaseId, "two");
  assert.equal(replaced.revision, 3);
  assert.equal(h.helpers.length, 1);
  assert.equal(h.timers.size, 1);
  assert.equal((await h.controller.stop("one")).code, "lease-mismatch");
  assert.equal(h.helpers[0].stops, 0);
  const stopped = await h.controller.stop("two");
  assert.deepEqual(stopped, { leaseId: "two", active: false, expiresAt: null, revision: 4, code: "ok" });
  assert.equal(h.helpers[0].stops, 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.pushes, []);
  assert.deepEqual(await h.controller.status(), stopped);
  assert.deepEqual(await h.controller.stop("two"), stopped);
  await h.controller.shutdown();
});

test("Keep Awake validates untrusted lease IDs and raw durations before creating any helper", async () => {
  const h = harness();
  for (const leaseId of [undefined, "", " ", " x", {}, 42, "x".repeat(129)]) {
    assert.equal((await h.controller.start({ leaseId, durationMs: 1 })).code, "invalid-request");
    assert.equal((await h.controller.stop(leaseId)).code, "invalid-request");
  }
  for (const durationMs of [undefined, NaN, Infinity, -1, 0, "900000", null, {}]) {
    assert.equal((await h.controller.start({ leaseId: "one", durationMs })).code, "invalid-request");
  }
  assert.equal(h.helpers.length, 0);
  assert.equal((await h.controller.start({ leaseId: "one", durationMs: 1 })).expiresAt, 1_000 + KEEP_AWAKE_MIN_MS);
  await h.controller.shutdown();
});

test("Keep Awake expiry stops the helper and pushes one authoritative ended-lease revision", async () => {
  const h = harness();
  await h.controller.start({ leaseId: "one", durationMs: KEEP_AWAKE_MIN_MS });
  h.advance(KEEP_AWAKE_MIN_MS);
  await h.fire();
  assert.equal(h.helpers[0].stops, 1);
  assert.deepEqual(h.pushes, [{
    leaseId: "one", active: false, expiresAt: null, revision: 2, code: "ok",
  }]);
  assert.deepEqual(await h.controller.status(), h.pushes[0]);
  await h.controller.shutdown();
});

test("Keep Awake helper failure is sanitized, clears state and timers, and ignores late callbacks", async () => {
  const h = harness();
  await h.controller.start({ leaseId: "one", durationMs: 1 });
  h.helpers[0].args.onFailure("private local error");
  await tick();
  assert.equal(h.helpers[0].stops, 1);
  assert.equal(h.timers.size, 0);
  assert.deepEqual(h.pushes, [{
    leaseId: "one", active: false, expiresAt: null, revision: 2, code: "unavailable",
  }]);
  await h.controller.start({ leaseId: "two", durationMs: 1 });
  h.helpers[0].args.onFailure("timeout");
  await tick();
  assert.equal((await h.controller.status()).leaseId, "two");
  assert.equal(h.pushes.length, 1);
  await h.controller.shutdown();
  assert.equal(h.helpers[1].stops, 1);
});

test("Keep Awake serializes startup/stop races and never returns active after shutdown", async () => {
  const started = deferred();
  let stops = 0;
  const h = harness({ helperFactory: () => started.promise });
  const start = h.controller.start({ leaseId: "one", durationMs: 1 });
  const stop = h.controller.stop("one");
  await tick();
  started.resolve({ stop: () => { stops++; }, updateExpiry: async () => {} });
  assert.equal((await start).active, true);
  assert.equal((await stop).active, false);
  assert.equal(stops, 1);
  await h.controller.shutdown();
  assert.equal((await h.controller.start({ leaseId: "two", durationMs: 1 })).code, "unavailable");
});

test("Keep Awake shutdown aborts pending startup promptly and disposes its late completion", async () => {
  const started = deferred();
  let stops = 0;
  let signal;
  const h = harness({ helperFactory: (args) => { signal = args.signal; return started.promise; } });
  const start = h.controller.start({ leaseId: "one", durationMs: 1 });
  await tick();
  await h.controller.shutdown();
  assert.equal(signal.aborted, true);
  assert.equal((await start).active, false);
  started.resolve({ stop: () => { stops++; } });
  await tick();
  assert.equal(stops, 1);
  assert.deepEqual(h.pushes, []);
  assert.equal(h.timers.size, 0);
});

test("Keep Awake shutdown interrupts a pending update and cleans up only once", async () => {
  const update = deferred();
  let stops = 0;
  const h = harness({ helperFactory: async () => ({
    stop: () => { stops++; },
    updateExpiry: () => update.promise,
  }) });
  await h.controller.start({ leaseId: "one", durationMs: 1 });
  const extend = h.controller.start({ leaseId: "one", durationMs: KEEP_AWAKE_MAX_MS });
  await tick();
  await h.controller.shutdown();
  assert.equal(stops, 1);
  assert.equal((await extend).active, false);
  update.reject(new Error("late private error"));
  await tick();
  assert.deepEqual(h.pushes, []);
});

test("Keep Awake consumes a late error when a lifecycle callback synchronously shuts down during renewal", async () => {
  const h = harness();
  await h.controller.start({ leaseId: "one", durationMs: 1 });
  h.helpers[0].updateExpiry = () => {
    void h.controller.shutdown();
    return Promise.reject(new Error("private late renewal error"));
  };
  const result = await h.controller.start({ leaseId: "one", durationMs: KEEP_AWAKE_MAX_MS });
  assert.equal(result.active, false);
  assert.equal(result.code, "unavailable");
  await h.controller.shutdown();
  await tick();
  assert.equal(h.helpers[0].stops, 1);
});

test("Keep Awake startup failures and early helper lifecycle callbacks are sanitized", async () => {
  for (const mode of ["throw", "callback"]) {
    let stops = 0;
    const h = harness({ helperFactory: async ({ onFailure }) => {
      if (mode === "throw") throw new Error("private error");
      onFailure("private error");
      return { stop: () => { stops++; } };
    } });
    const result = await h.controller.start({ leaseId: "one", durationMs: 1 });
    assert.deepEqual(result, { leaseId: null, active: false, expiresAt: null, revision: 0, code: "unavailable" });
    assert.equal(stops, mode === "throw" ? 0 : 1);
    assert.deepEqual(h.pushes, []);
    await h.controller.shutdown();
  }
});

test("Keep Awake update failure ends the current lease and pushes only a sanitized failure", async () => {
  const h = harness();
  await h.controller.start({ leaseId: "one", durationMs: 1 });
  h.helpers[0].updateExpiry = async () => { throw new Error("private error"); };
  const result = await h.controller.start({ leaseId: "one", durationMs: KEEP_AWAKE_MAX_MS });
  assert.equal(result.code, "unavailable");
  assert.equal(result.active, false);
  assert.equal(result.revision, 2);
  assert.deepEqual(h.pushes, [result]);
  await h.controller.shutdown();
});

test("Keep Awake is unavailable on unsupported platforms and status hooks are isolated", async () => {
  const unsupported = harness({ platform: "linux", helperFactory: () => assert.fail("must not spawn") });
  assert.equal(unsupported.controller.supported, false);
  assert.equal((await unsupported.controller.start({ leaseId: "one", durationMs: 1 })).code, "unsupported");
  assert.equal((await unsupported.controller.stop("one")).code, "unsupported");
  assert.equal((await unsupported.controller.status()).code, "unsupported");
  await unsupported.controller.shutdown();
  const h = harness();
  h.controller.onStatus(() => { throw new Error("host error"); });
  const unsub = h.controller.onStatus(() => assert.fail("unsubscribed hook"));
  unsub();
  await h.controller.start({ leaseId: "one", durationMs: 1 });
  h.advance(KEEP_AWAKE_MIN_MS);
  await h.fire();
  assert.equal(h.pushes.length, 1);
  await h.controller.shutdown();
});

function childProcess() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.input = [];
  child.stdin.write = (line) => { child.input.push(line); };
  child.stdin.end = () => { child.stdinEnded = true; };
  child.kills = 0;
  child.kill = () => { child.kills++; };
  return child;
}

test("Windows helper owns system-only execution state with bounded deadline/EOF and acknowledged renewal", async () => {
  const child = childProcess();
  const failures = [];
  const pending = createWindowsKeepAwakeHelper({
    expiresAt: 1_000_000,
    onFailure: (code) => failures.push(code),
    spawnFn: (file, args, options) => {
      assert.equal(file, "powershell.exe");
      assert.equal(options.windowsHide, true);
      assert.equal(options.stdio[2], "ignore");
      const script = args.at(-1);
      assert.ok(script.includes("0x80000001u"));
      assert.equal(script.includes("0x80000003"), false);
      assert.ok(script.includes("finally"));
      assert.ok(script.includes("input.Result == null"));
      assert.ok(script.includes("Now() < deadline"));
      assert.ok(script.includes("28800000L"));
      assert.ok(script.includes("Task.Run"));
      return child;
    },
  });
  child.stdout.emit("data", Buffer.from("ready\r\n"));
  const helper = await pending;
  assert.deepEqual(child.input, ["1000000\n"]);
  const updated = helper.updateExpiry(2_000_000);
  child.stdout.emit("data", Buffer.from("updated\r\n"));
  await updated;
  assert.deepEqual(child.input, ["1000000\n", "2000000\n"]);
  helper.stop();
  assert.equal(child.kills, 1);
  assert.equal(child.stdinEnded, true);
  child.emit("close", 0);
  assert.deepEqual(failures, []);
});

test("Windows helper sanitizes startup errors, bounded output, timeout and abort", async () => {
  for (const mode of ["error", "close", "output", "timeout", "abort"]) {
    const child = childProcess();
    const aborter = new AbortController();
    const pending = createWindowsKeepAwakeHelper({
      expiresAt: 1_000_000, spawnFn: () => child, timeoutMs: 10, signal: aborter.signal,
    });
    const rejected = assert.rejects(pending, (error) => error.message === (mode === "timeout" ? "timeout" : "unavailable"));
    if (mode === "error") child.emit("error", new Error("private local error"));
    if (mode === "close") child.emit("close", 1);
    if (mode === "output") child.stdout.emit("data", Buffer.alloc(65, 65));
    if (mode === "abort") aborter.abort();
    await rejected;
    assert.equal(child.kills, 1);
    child.emit("error", new Error("late private error"));
  }
});

test("Windows helper reports unexpected exit and renewal timeout without raw diagnostics", async () => {
  for (const mode of ["close", "timeout"]) {
    const child = childProcess();
    const failures = [];
    const pending = createWindowsKeepAwakeHelper({
      expiresAt: 1_000_000, spawnFn: () => child, timeoutMs: 10, onFailure: (code) => failures.push(code),
    });
    child.stdout.emit("data", Buffer.from("ready\n"));
    const helper = await pending;
    const updated = helper.updateExpiry(2_000_000);
    const rejected = assert.rejects(updated, (error) => error.message === (mode === "timeout" ? "timeout" : "unavailable"));
    if (mode === "close") child.emit("close", 1);
    await rejected;
    assert.deepEqual(failures, [mode === "timeout" ? "timeout" : "unavailable"]);
    assert.equal(child.kills, 1);
  }
});

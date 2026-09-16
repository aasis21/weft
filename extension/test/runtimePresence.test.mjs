// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeIdentity,
  deriveStoreAuthority,
} from "../src/runtimeIdentity.mjs";
import {
  publishRuntimePresence,
  runtimeDirectory,
  runtimesDirectory,
  scanRuntimePresence,
} from "../src/runtimePresence.mjs";

function fixture(t) {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-runtime-presence-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  return baseDir;
}

function identity(overrides = {}, scope = {}) {
  return createRuntimeIdentity({
    storeAuthority: "sha256:store",
    sessionId: "session-a",
    ...overrides,
  }, { scope });
}

test("stable store and terminal identities survive reload while runtime and generation advance", () => {
  const scope = {};
  const first = identity({}, scope);
  const second = identity({}, scope);
  assert.equal(first.storeAuthority, second.storeAuthority);
  assert.equal(first.terminalInstanceId, second.terminalInstanceId);
  assert.notEqual(first.runtimeInstanceId, second.runtimeInstanceId);
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);
  assert.equal(
    deriveStoreAuthority("C:\\Users\\Example\\.copilot\\session-store.db", { platform: "win32" }),
    deriveStoreAuthority("c:\\users\\example\\.copilot\\session-store.db", { platform: "win32" }),
  );
});

test("startup atomically publishes one private directory and verified discovery finds it", async (t) => {
  const baseDir = fixture(t);
  const runtime = identity();
  const handle = await publishRuntimePresence({
    identity: runtime,
    endpoint: "\\\\.\\pipe\\test",
    processStartedAt: 123,
  }, { baseDir, now: () => 456, capability: "private-capability" });
  t.after(() => handle.close());

  assert.deepEqual(
    readFileSync(join(handle.directory, "capability"), "utf8").trim(),
    "private-capability",
  );
  assert.equal(readFileSync(join(handle.directory, "presence.json"), "utf8").includes("private-capability"), false);
  assert.equal(
    (await scanRuntimePresence({
      baseDir,
      verify: async (presence) => ({ live: presence.processStartedAt === 123 }),
    })).status,
    "single",
  );
  if (process.platform !== "win32") {
    assert.equal(statSync(handle.directory).mode & 0o777, 0o700);
    assert.equal(statSync(join(handle.directory, "presence.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(handle.directory, "capability")).mode & 0o777, 0o600);
  }
});

test("reload presence retains terminal identity but creates a separate runtime directory", async (t) => {
  const baseDir = fixture(t);
  const scope = {};
  const first = await publishRuntimePresence({
    identity: identity({}, scope),
    endpoint: "endpoint-1",
    processStartedAt: 100,
  }, { baseDir });
  const second = await publishRuntimePresence({
    identity: identity({}, scope),
    endpoint: "endpoint-2",
    processStartedAt: 100,
  }, { baseDir });
  t.after(() => {
    first.close();
    second.close();
  });
  assert.notEqual(first.directory, second.directory);
  assert.equal(first.presence.terminalInstanceId, second.presence.terminalInstanceId);
  assert.equal(second.presence.generation, first.presence.generation + 1);
});

test("stale processes, PID reuse, and corrupt entries are rejected and cleaned", async (t) => {
  const baseDir = fixture(t);
  const exited = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "exited" }),
    endpoint: "endpoint",
    pid: 10,
    processStartedAt: 100,
  }, { baseDir });
  const reused = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "reused" }),
    endpoint: "endpoint",
    pid: 11,
    processStartedAt: 100,
  }, { baseDir });
  mkdirSync(join(runtimesDirectory({ baseDir }), "corrupt"), { mode: 0o700 });
  writeFileSync(join(runtimesDirectory({ baseDir }), "corrupt", "presence.json"), "{broken", { mode: 0o600 });

  const result = await scanRuntimePresence({
    baseDir,
    verify: async ({ pid }) => pid === 10
      ? { live: false, reason: "process-exited" }
      : { live: false, reason: "pid-reused" },
  });

  assert.equal(result.status, "none");
  assert.deepEqual(result.rejected.map((item) => item.reason).sort(), ["corrupt", "pid-reused", "process-exited"]);
  assert.throws(() => statSync(exited.directory), { code: "ENOENT" });
  assert.throws(() => statSync(reused.directory), { code: "ENOENT" });
  assert.throws(() => statSync(join(runtimesDirectory({ baseDir }), "corrupt")), { code: "ENOENT" });
});

test("filtered discovery still prunes stale entries from other logical sessions", async (t) => {
  const baseDir = fixture(t);
  const stale = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "stale-other", sessionId: "session-b" }),
    endpoint: "endpoint-b",
    pid: 10,
    processStartedAt: 100,
  }, { baseDir });
  const live = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "live-target" }),
    endpoint: "endpoint-a",
    pid: 11,
    processStartedAt: 100,
  }, { baseDir });
  t.after(() => live.close());

  const result = await scanRuntimePresence({
    baseDir,
    storeAuthority: "sha256:store",
    sessionId: "session-a",
    verify: async ({ pid }) => pid === 11
      ? { live: true }
      : { live: false, reason: "process-exited" },
  });
  assert.equal(result.status, "single");
  assert.equal(result.runtimes[0].runtimeInstanceId, "live-target");
  assert.throws(() => statSync(stale.directory), { code: "ENOENT" });
});

test("duplicate live writers fail closed while unverifiable ownership remains uncertain", async (t) => {
  const baseDir = fixture(t);
  const first = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "runtime-one" }),
    endpoint: "endpoint-1",
    processStartedAt: 100,
  }, { baseDir });
  const second = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "runtime-two" }),
    endpoint: "endpoint-2",
    processStartedAt: 200,
  }, { baseDir });
  t.after(() => {
    first.close();
    second.close();
  });

  const conflict = await scanRuntimePresence({
    baseDir,
    storeAuthority: "sha256:store",
    sessionId: "session-a",
    verify: async () => ({ live: true }),
  });
  assert.equal(conflict.status, "conflict");
  assert.equal(conflict.runtimes.length, 2);

  const uncertain = await scanRuntimePresence({
    baseDir,
    storeAuthority: "sha256:store",
    sessionId: "session-a",
    verify: async () => ({ live: null, reason: "process-unverifiable" }),
  });
  assert.equal(uncertain.status, "uncertain");
});

test("discovery retains only the newest generation from the same process owner", async (t) => {
  const baseDir = fixture(t);
  const scope = {};
  const first = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "generation-one" }, scope),
    endpoint: "endpoint-1",
    pid: 10,
    processStartedAt: 100,
  }, { baseDir, now: () => 200 });
  const second = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "generation-two" }, scope),
    endpoint: "endpoint-2",
    pid: 10,
    processStartedAt: 100,
  }, { baseDir, now: () => 300 });
  t.after(() => second.close());

  const result = await scanRuntimePresence({
    baseDir,
    verify: async () => ({ live: true }),
  });
  assert.equal(result.status, "single");
  assert.equal(result.runtimes[0].runtimeInstanceId, "generation-two");
  assert.equal(result.rejected.find(({ reason }) => reason === "superseded-generation")?.presence.runtimeInstanceId, "generation-one");
  assert.throws(() => statSync(first.directory), { code: "ENOENT" });
});

test("a verified live process with failed endpoint proof remains uncertain", async (t) => {
  const baseDir = fixture(t);
  const handle = await publishRuntimePresence({
    identity: identity(),
    endpoint: "endpoint",
    processStartedAt: 100,
  }, { baseDir });
  t.after(() => handle.close());

  const result = await scanRuntimePresence({
    baseDir,
    storeAuthority: "sha256:store",
    sessionId: "session-a",
    verify: async () => ({ live: true }),
    probe: async () => false,
  });

  assert.equal(result.status, "uncertain");
  assert.equal(result.rejected[0].reason, "endpoint-proof-failed");
});

test("independent live sessions do not create a duplicate-writer conflict", async (t) => {
  const baseDir = fixture(t);
  const first = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "runtime-a" }),
    endpoint: "endpoint-a",
    processStartedAt: 100,
  }, { baseDir });
  const second = await publishRuntimePresence({
    identity: identity({ runtimeInstanceId: "runtime-b", sessionId: "session-b" }),
    endpoint: "endpoint-b",
    processStartedAt: 100,
  }, { baseDir });
  t.after(() => {
    first.close();
    second.close();
  });
  const result = await scanRuntimePresence({ baseDir, verify: async () => ({ live: true }) });
  assert.equal(result.status, "multiple");
  assert.deepEqual(result.conflicts, []);
});

test("publishing the same runtime id twice never overwrites its capability", async (t) => {
  const baseDir = fixture(t);
  const runtime = identity({ runtimeInstanceId: "fixed-runtime" });
  const first = await publishRuntimePresence({
    identity: runtime,
    endpoint: "endpoint",
    processStartedAt: 100,
  }, { baseDir, capability: "first-capability" });
  t.after(() => first.close());
  await assert.rejects(
    publishRuntimePresence({
      identity: runtime,
      endpoint: "endpoint",
      processStartedAt: 100,
    }, { baseDir, capability: "second-capability" }),
    (error) => error?.code === "EEXIST" || error?.code === "ENOTEMPTY",
  );
  assert.equal(
    readFileSync(join(runtimeDirectory(runtime.runtimeInstanceId, { baseDir }), "capability"), "utf8").trim(),
    "first-capability",
  );
});

test("presence updates preserve immutable ownership fields", async (t) => {
  const baseDir = fixture(t);
  const handle = await publishRuntimePresence({
    identity: identity(),
    endpoint: "endpoint",
    processStartedAt: 100,
  }, { baseDir, now: () => 200 });
  t.after(() => handle.close());
  const updated = handle.update({ state: "active", generation: 99, pid: 99 });
  assert.equal(updated.state, "active");
  assert.equal(updated.generation, 1);
  assert.equal(updated.pid, process.pid);
  chmodSync(handle.directory, 0o700);
});

test("stale handles cannot update or delete a replacement runtime directory", async (t) => {
  const baseDir = fixture(t);
  const runtime = identity({ runtimeInstanceId: "reused-runtime-id" });
  const stale = await publishRuntimePresence({
    identity: runtime,
    endpoint: "endpoint-old",
    processStartedAt: 100,
  }, { baseDir, capability: "old-capability" });
  rmSync(stale.directory, { recursive: true, force: true });
  const replacement = await publishRuntimePresence({
    identity: runtime,
    endpoint: "endpoint-new",
    processStartedAt: 100,
  }, { baseDir, capability: "new-capability" });
  t.after(() => replacement.close());

  assert.throws(() => stale.update({ state: "active" }), { code: "ESTALE" });
  stale.close();
  assert.equal(readFileSync(join(replacement.directory, "capability"), "utf8").trim(), "new-capability");
});

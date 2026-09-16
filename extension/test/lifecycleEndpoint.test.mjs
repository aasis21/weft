// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLifecycleEndpoint,
  lifecycleAuth,
  runtimeEndpointAddress,
  sendLifecycleCommand,
} from "../src/lifecycleEndpoint.mjs";
import { createRuntimeIdentity } from "../src/runtimeIdentity.mjs";

async function fixture(t, handlerOverrides = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-lifecycle-endpoint-"));
  const identity = createRuntimeIdentity({
    storeAuthority: "sha256:store",
    sessionId: "session-a",
  }, { scope: {} });
  const capability = "private-capability";
  const calls = [];
  const handlers = {};
  for (const command of ["activate", "status", "replace-controller", "quiesce"]) {
    handlers[command] = handlerOverrides[command] ?? (async (payload) => {
      calls.push({ command, payload });
      return { command, payload };
    });
  }
  const endpoint = runtimeEndpointAddress(identity.runtimeInstanceId, { baseDir });
  const host = await createLifecycleEndpoint({
    identity,
    capability,
    endpoint,
    presence: () => ({ ...identity, state: "dormant" }),
    handlers,
  });
  t.after(async () => {
    await host.close();
    rmSync(baseDir, { recursive: true, force: true });
  });
  return { baseDir, identity, capability, auth: lifecycleAuth(identity, capability), endpoint, host, calls };
}

function rawCommand(endpoint, data) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let response = "";
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.end(data));
    socket.on("data", (chunk) => { response += chunk; });
    socket.on("error", reject);
    socket.on("end", () => resolve(JSON.parse(response.trim())));
  });
}

test("probe, activate, status, replace-controller, and quiesce are authenticated and dispatched", async (t) => {
  const fx = await fixture(t);
  const probe = await sendLifecycleCommand({
    endpoint: fx.endpoint,
    auth: fx.auth,
    command: "probe",
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.result.presence.runtimeInstanceId, fx.identity.runtimeInstanceId);
  for (const command of ["activate", "status", "replace-controller", "quiesce"]) {
    const response = await sendLifecycleCommand({
      endpoint: fx.endpoint,
      auth: fx.auth,
      command,
      payload: { operationId: `operation-${command}` },
    });
    assert.equal(response.ok, true);
    assert.equal(response.result.command, command);
  }
  assert.deepEqual(fx.calls.map((item) => item.command), ["activate", "status", "replace-controller", "quiesce"]);
});

test("malformed and oversized frames are rejected without stopping the listener", async (t) => {
  const fx = await fixture(t);
  const malformed = await rawCommand(fx.endpoint, "{not-json}\n");
  assert.equal(malformed.error.code, "MALFORMED_FRAME");
  const oversized = await rawCommand(fx.endpoint, `${"x".repeat(70 * 1_024)}\n`);
  assert.equal(oversized.error.code, "FRAME_TOO_LARGE");
  const healthy = await sendLifecycleCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "probe" });
  assert.equal(healthy.ok, true);
});

test("the client refuses to send a frame above the protocol bound", async (t) => {
  const fx = await fixture(t);
  await assert.rejects(
    sendLifecycleCommand({
      endpoint: fx.endpoint,
      auth: fx.auth,
      command: "activate",
      payload: { value: "x".repeat(70 * 1_024) },
    }),
    /size limit/,
  );
});

test("stale capability and changed session, runtime, or generation identities fail closed", async (t) => {
  const fx = await fixture(t);
  for (const auth of [
    { ...fx.auth, capability: "stale" },
    { ...fx.auth, sessionId: "session-b" },
    { ...fx.auth, runtimeInstanceId: "other-runtime" },
    { ...fx.auth, generation: fx.auth.generation + 1 },
  ]) {
    const response = await sendLifecycleCommand({
      endpoint: fx.endpoint,
      auth,
      command: "probe",
    });
    assert.equal(response.error.code, "AUTH_FAILED");
  }
});

test("temporary connections close after each command and the listener accepts reconnects", async (t) => {
  const fx = await fixture(t);
  for (let index = 0; index < 3; index++) {
    const response = await sendLifecycleCommand({
      endpoint: fx.endpoint,
      auth: fx.auth,
      command: "status",
      id: `status-${index}`,
    });
    assert.equal(response.ok, true);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fx.host.connectionCount(), 0);
  }
  assert.equal(fx.host.closed, false);
});

test("concurrent commands are isolated on independent temporary connections", async (t) => {
  const fx = await fixture(t, {
    activate: async ({ value }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { value };
    },
  });
  const responses = await Promise.all(
    Array.from({ length: 12 }, (_, value) => sendLifecycleCommand({
      endpoint: fx.endpoint,
      auth: fx.auth,
      command: "activate",
      payload: { value },
      id: `concurrent-${value}`,
    })),
  );
  assert.deepEqual(responses.map((response) => response.result.value).sort((a, b) => a - b), [...Array(12).keys()]);
});

test("shutdown closes the listener and rejects later connections", async (t) => {
  const fx = await fixture(t);
  await fx.host.close();
  assert.equal(fx.host.closed, true);
  await assert.rejects(
    sendLifecycleCommand({
      endpoint: fx.endpoint,
      auth: fx.auth,
      command: "probe",
    }, { timeoutMs: 200 }),
  );
});

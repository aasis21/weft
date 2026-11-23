// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  controlAuth,
  controlEndpointAddress,
  createControlIdentity,
  createControlServer,
  createSessionControlClient,
  sendControlCommand,
  sessionPipeAddress,
  startSessionControlServer,
} from "../src/sessionControl.mjs";
import { publishSessionRecord } from "../src/sessionRegistry.mjs";

async function genericFixture(t, handlerOverrides = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-control-"));
  const identity = createControlIdentity({ storeAuthority: "weft-background:station", sessionId: "station" });
  const capability = "private-capability";
  const calls = [];
  const handlers = {};
  for (const command of ["activate", "status", "quiesce"]) {
    handlers[command] = handlerOverrides[command] ?? (async (payload) => {
      calls.push({ command, payload });
      return { command, payload };
    });
  }
  if (handlerOverrides.traffic) handlers.traffic = handlerOverrides.traffic;
  const endpoint = controlEndpointAddress(identity.runtimeInstanceId, { baseDir });
  const host = await createControlServer({
    identity, capability, endpoint, presence: () => ({ ...identity, state: "ready" }), handlers,
  });
  t.after(async () => {
    await host.close();
    rmSync(baseDir, { recursive: true, force: true });
  });
  return { baseDir, identity, capability, auth: controlAuth(identity, capability), endpoint, host, calls };
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

test("background workers keep their historical pipe name so an updated CLI can still quiesce them", () => {
  const address = controlEndpointAddress("runtime-1", { platform: "win32" });
  assert.match(address, /^\\\\\.\\pipe\\weft-runtime-[a-f0-9]{32}$/);
  assert.match(sessionPipeAddress("runtime-1", { platform: "win32" }), /^\\\\\.\\pipe\\weft-session-[a-f0-9]{32}$/);
});

test("probe and registered commands are authenticated and dispatched; unknown ones are unsupported", async (t) => {
  const fx = await genericFixture(t);
  const probe = await sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "probe" });
  assert.equal(probe.result.presence.runtimeInstanceId, fx.identity.runtimeInstanceId);
  for (const command of ["activate", "status", "quiesce"]) {
    const response = await sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command, payload: { id: command } });
    assert.equal(response.result.command, command);
  }
  assert.deepEqual(fx.calls.map((item) => item.command), ["activate", "status", "quiesce"]);
  const unsupported = await sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "traffic" });
  assert.equal(unsupported.error.code, "UNSUPPORTED_COMMAND");
  const prototype = await sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "constructor" });
  assert.equal(prototype.error.code, "UNSUPPORTED_COMMAND", "only own handlers are dispatched");
});

test("malformed and oversized frames are rejected without stopping the server", async (t) => {
  const fx = await genericFixture(t);
  assert.equal((await rawCommand(fx.endpoint, "{not-json}\n")).error.code, "MALFORMED_FRAME");
  assert.equal((await rawCommand(fx.endpoint, `${"x".repeat(70 * 1_024)}\n`)).error.code, "FRAME_TOO_LARGE");
  assert.equal((await sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "probe" })).ok, true);
  await assert.rejects(
    sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "activate", payload: { value: "x".repeat(70 * 1_024) } }),
    /size limit/,
  );
});

test("a stale capability or changed identity fails closed", async (t) => {
  const fx = await genericFixture(t);
  for (const auth of [
    { ...fx.auth, capability: "stale" },
    { ...fx.auth, sessionId: "other" },
    { ...fx.auth, runtimeInstanceId: "other-runtime" },
    { ...fx.auth, generation: fx.auth.generation + 1 },
  ]) {
    const response = await sendControlCommand({ endpoint: fx.endpoint, auth, command: "probe" });
    assert.equal(response.error.code, "AUTH_FAILED");
  }
});

test("concurrent commands use independent connections; close rejects later ones", async (t) => {
  const fx = await genericFixture(t, {
    activate: async ({ value }) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { value };
    },
  });
  const responses = await Promise.all(Array.from({ length: 8 }, (_, value) =>
    sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "activate", payload: { value } })));
  assert.deepEqual(responses.map((response) => response.result.value).sort((a, b) => a - b), [...Array(8).keys()]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fx.host.connectionCount(), 0);
  await fx.host.close();
  await assert.rejects(sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "probe" }, { timeoutMs: 200 }));
});

test("a busy endpoint times out as `timeout`, never as a cancellation", async (t) => {
  const fx = await genericFixture(t, { status: () => new Promise(() => {}) });
  await assert.rejects(
    sendControlCommand({ endpoint: fx.endpoint, auth: fx.auth, command: "status" }, { timeoutMs: 150 }),
    (error) => error.timeout === true && error.code === "timeout" && /timed out/.test(error.message),
  );
});

async function sessionFixture(t, handlers) {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-session-control-"));
  const session = { storeAuthority: "sha256:store", sessionId: "session-a" };
  const pipe = sessionPipeAddress("runtime-a", { baseDir });
  const record = await publishSessionRecord({
    session, run: { runtimeId: "runtime-a", generation: 3, processStartedAt: 5 }, pipe,
  }, { baseDir });
  const server = await startSessionControlServer({
    identity: () => ({ ...session, runtimeInstanceId: "runtime-a", generation: 3 }),
    capability: () => record.capability,
    pipe,
    handlers,
  });
  t.after(async () => {
    await server.close();
    record.close();
    rmSync(baseDir, { recursive: true, force: true });
  });
  return { baseDir, client: createSessionControlClient(record.record, { baseDir }), record };
}

test("Station's client reads the capability from disk and keyed commands run once per opId/requestId", async (t) => {
  let resets = 0;
  let activations = 0;
  const fx = await sessionFixture(t, {
    probe: () => ({ runtimeId: "runtime-a", link: { generation: 7, state: "connecting" } }),
    activate: async () => ({ state: "connecting", activation: ++activations }),
    resetLink: async ({ expectGeneration }) => (expectGeneration === 7 ? { result: "reset", reset: ++resets } : { result: "stale" }),
  });
  assert.equal((await fx.client.command("probe")).link.generation, 7);
  const first = await fx.client.command("resetLink", { opId: "op-1", expectGeneration: 7 });
  const retry = await fx.client.command("resetLink", { opId: "op-1", expectGeneration: 7 });
  assert.deepEqual(retry, first, "a retried opId replays the first answer");
  assert.equal(resets, 1);
  assert.deepEqual(await fx.client.command("resetLink", { opId: "op-2", expectGeneration: 6 }), { result: "stale" });
  await fx.client.command("activate", { requestId: "open-1" });
  await fx.client.command("activate", { requestId: "open-1" });
  assert.equal(activations, 1);
  await assert.rejects(fx.client.command("reloadExtension", { opId: "r" }), (error) => error.code === "UNSUPPORTED_COMMAND");
});

test("the client maps a deadline to `timeout` (unknown), not to a failure that happened", async (t) => {
  const fx = await sessionFixture(t, { probe: () => new Promise(() => {}) });
  await assert.rejects(fx.client.command("probe", null, { timeoutMs: 120 }), (error) => error.timeout === true && error.code === "timeout");
});

// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_TYPE,
  SUBTYPE,
  SecureChannel,
  _resetLocalBus,
  deriveSessionKey,
  generateKeyPair,
  importKeyPair,
  sayHello,
  spawnSession,
} from "@aasis21/helm-shared";
import { createListener } from "../src/listener.mjs";

let dirs = [];
let identityFiles = [];

beforeEach(() => {
  _resetLocalBus();
});

afterEach(() => {
  _resetLocalBus();
  for (const file of identityFiles.splice(0)) {
    try { unlinkSync(file); } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const waitFor = async (predicate, message = "condition", timeoutMs = 1200) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 15));
  }
  assert.fail(`Timed out waiting for ${message}`);
};

async function pairedHarness({ projects, spawnFn, log, heartbeatMs } = {}) {
  const { createLocalTransport } = await import("@aasis21/helm-shared");
  const listenerKeys = await generateKeyPair();
  const channelId = `chan-${Math.random().toString(16).slice(2)}`;
  const listenerTransport = createLocalTransport({ channelId });
  const projectsApi = { listProjects: () => projects ?? [] };
  const listener = createListener({
    transport: listenerTransport,
    keyPair: listenerKeys,
    channelId,
    deviceId: "test-device",
    heartbeatMs,
    projectsApi,
    spawnFn,
    log,
  });
  await listener.start();

  const phoneTransport = createLocalTransport({ channelId });
  const phoneKeys = await generateKeyPair();
  const phoneKey = await deriveSessionKey(phoneKeys.privateKey, listenerKeys.publicKeyB64);
  const phoneChannel = new SecureChannel({
    transport: phoneTransport,
    key: phoneKey,
    identity: { channelId, senderId: "phone", senderName: "Phone" },
  });
  const messages = [];
  phoneChannel.onEvent(EVENT_TYPE.CONTROL, (m) => messages.push(m));
  await sayHello({
    transport: phoneTransport,
    keyPair: phoneKeys,
    peerPublicKeyB64: listenerKeys.publicKeyB64,
    channelId,
    deviceId: "phone-1",
    senderName: "Phone",
    waitForAck: true,
    timeoutMs: 1000,
    retryMs: 20,
  });
  await waitFor(() => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST), "project list");
  return { listener, listenerKeys, channelId, phoneChannel, messages };
}

test("emits PROJECT_LIST when the phone pairs", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "helm-listener-project-"));
  dirs.push(projectDir);
  const { listener, messages } = await pairedHarness({
    projects: [{ name: "app", path: projectDir, default: true }],
  });
  const list = messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST);
  assert.deepEqual(list.msg.projects, [{ name: "app", path: projectDir, isDefault: true }]);
  assert.ok(list.msg.deviceName);
  assert.equal(list.msg.deviceId, "test-device");
  await listener.stop();
});

test("emits DEVICE_HEARTBEAT on the configured interval, independent of PROJECT_LIST", async () => {
  const { listener, messages } = await pairedHarness({ projects: [], heartbeatMs: 20 });
  await waitFor(
    () => messages.filter((m) => m.eventSubtype === SUBTYPE.CONTROL.DEVICE_HEARTBEAT).length >= 2,
    "at least two device heartbeats",
  );
  const beat = messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.DEVICE_HEARTBEAT);
  assert.equal(beat.msg.deviceId, "test-device");
  await listener.stop();
});

test("SPAWN_SESSION for a known project spawns safely and emits pairing then ok result", async () => {
  const oldWt = process.env.WT_SESSION;
  const oldTerm = process.env.TERM_PROGRAM;
  const oldGnome = process.env.GNOME_TERMINAL_SCREEN;
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;

  const projectDir = mkdtempSync(join(tmpdir(), "helm-listener-project-"));
  dirs.push(projectDir);
  const spawnCalls = [];
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [{ name: "app", path: projectDir, default: true }],
    spawnFn(command, args, options) {
      spawnCalls.push({ command, args, options });
      identityFiles.push(options.env.HELM_IDENTITY_FILE);
      return { unref() {} };
    },
  });

  await phoneChannel.send(spawnSession("req-1", "app", "allow-all", "phone-started"));
  await waitFor(() => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT), "spawn result");

  process.env.WT_SESSION = oldWt;
  process.env.TERM_PROGRAM = oldTerm;
  process.env.GNOME_TERMINAL_SCREEN = oldGnome;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "copilot");
  assert.deepEqual(spawnCalls[0].args, ["-n", "phone-started", "--allow-all-tools"]);
  assert.equal(spawnCalls[0].options.cwd, projectDir);
  assert.equal(spawnCalls[0].options.shell, false);
  const identity = JSON.parse(readFileSync(spawnCalls[0].options.env.HELM_IDENTITY_FILE, "utf8"));
  assert.equal(identity.channelId, spawnCalls[0].options.env.HELM_CHANNEL_ID);
  const imported = await importKeyPair({ privateKeyJwk: identity.privateKeyJwk });
  assert.equal(imported.publicKeyB64, identity.publicKeyB64);

  const pairing = messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_PAIRING);
  assert.equal(pairing.msg.requestId, "req-1");
  assert.equal(pairing.msg.name, "phone-started");
  assert.equal(pairing.msg.projectName, "app");
  assert.equal(pairing.msg.payload.channelId, identity.channelId);
  assert.equal(pairing.msg.payload.pub, identity.publicKeyB64);
  const result = messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT);
  assert.equal(result.msg.requestId, "req-1");
  assert.equal(result.msg.ok, true);
  await listener.stop();
});

test("unknown project emits SPAWN_RESULT ok:false", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "helm-listener-project-"));
  dirs.push(projectDir);
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [{ name: "app", path: projectDir, default: true }],
    spawnFn() { throw new Error("should not spawn"); },
  });
  await phoneChannel.send(spawnSession("req-missing", "missing", "default", "x"));
  const result = await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT && m.msg.requestId === "req-missing"),
    "failed spawn result",
  );
  assert.equal(result.msg.ok, false);
  assert.match(result.msg.error, /Unknown project/);
  await listener.stop();
});

test("a second different phone public key is ignored after first binding", async () => {
  const { createLocalTransport } = await import("@aasis21/helm-shared");
  const warnings = [];
  const { listener, listenerKeys, channelId, messages } = await pairedHarness({
    projects: [],
    log: { warn: (m) => warnings.push(m) },
  });
  const secondTransport = createLocalTransport({ channelId });
  const secondKeys = await generateKeyPair();
  await sayHello({
    transport: secondTransport,
    keyPair: secondKeys,
    peerPublicKeyB64: listenerKeys.publicKeyB64,
    channelId,
    deviceId: "phone-2",
    senderName: "Other Phone",
    waitForAck: true,
    timeoutMs: 1000,
    retryMs: 20,
  });
  await waitFor(() => warnings.length > 0, "ignored second phone warning");
  assert.match(warnings[0], /ignoring pairing from a different phone/);
  const lists = messages.filter((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST);
  assert.equal(lists.length, 1);
  await listener.stop();
});

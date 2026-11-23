// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import {
  ATTENTION_CAPABILITY,
  DEVICE_CAPABILITY,
  EVENT_TYPE,
  SUBTYPE,
  SecureChannel,
  _resetLocalBus,
  deriveSessionKey,
  generateKeyPair,
  importKeyPair,
  sayHello,
  sessionListRequest,
  projectListRequest,
  sessionClaimed,
  deviceMonitorStart,
  deviceMonitorStop,
  terminalRequest,
  clipboardRead,
  clipboardWrite,
  keepAwakeStart,
  keepAwakeStop,
  keepAwakeStatusRequest,
  openSession,
  lifecycleCancel,
  lifecycleStatusRequest,
  sessionHealthRequest,
  KEEP_AWAKE_MIN_MS,
  CLIPBOARD_MAX_BYTES,
} from "@aasis21/weft-shared";
import { createStation, createSupervisor, defaultSessionStorePath } from "../src/station.mjs";
import { createDeviceClipboard } from "../src/deviceClipboard.mjs";
import { createDeviceKeepAwakeController } from "../src/deviceKeepAwake.mjs";
import { readRegistry } from "../src/registryFile.mjs";
import { deriveStoreAuthority, publishSessionRecord, scanSessions } from "../src/sessionRegistry.mjs";

let dirs = [];
let identityFiles = [];
let connectionsHomes = [];

beforeEach(() => {
  _resetLocalBus();
});

afterEach(() => {
  _resetLocalBus();
  for (const file of identityFiles.splice(0)) {
    try { unlinkSync(file); } catch {}
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const dir of connectionsHomes.splice(0)) rmSync(dir, { recursive: true, force: true });
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

// Live records in tests belong to this process; skip the OS start-time probe (slow on Windows).
const testScan = (options) => scanSessions({ ...options, legacy: false, verifyBatch: async (items) => items.map(() => ({ live: true })) });
// Supervisor sweeps only when a test asks (start() still runs one initial sweep).
const QUIET_SUPERVISOR = { intervalMs: 3_600_000 };

test("Station forwards the cancel revision of a v3 request and replies with lifecycle_status", async () => {
  const calls = [];
  const opener = {
    storeAuthority: "cli",
    reconcile: async () => [],
    inspect: async () => null,
    confirmTakeover: async () => null,
    open: async () => null,
    stop() {},
    cancel: async (requestId, revision) => {
      calls.push({ requestId, revision });
      return { requestId, revision: revision + 1, stage: "dispatching", outcome: "cancelled", reason: null, result: { mayBeRunning: true } };
    },
  };
  const { listener, phoneChannel, messages } = await pairedHarness({ projects: [], opener });
  try {
    await phoneChannel.send(lifecycleCancel("cancel-op", 7));
    await waitFor(() => calls.length === 1, "cancel forwarding");
    assert.deepEqual(calls[0], { requestId: "cancel-op", revision: 7 });
    const status = await waitFor(
      () => messages.find((message) =>
        message.eventSubtype === SUBTYPE.CONTROL.LIFECYCLE_STATUS && message.msg.requestId === "cancel-op"),
      "cancel acknowledgement",
    );
    assert.equal(status.msg.revision, 8);
    assert.equal(status.msg.outcome, "cancelled");
    assert.equal(status.msg.result.mayBeRunning, true);
  } finally {
    await listener.stop();
  }
});

async function pairedHarness({ projects, spawnFn, log, heartbeatMs, telemetryApi, clipboardApi = { supported: false }, keepAwakeApi = { supported: false }, monitoringLimits, allowTerminal, terminalHostFactory, onControl, onSessionOffers, onSessionClaimed, sessionsApi, opener, launcher, controlClient, supervisorOptions, transportDescriptor, onDeviceConnected, onDeviceDisconnected, connectionsHome: suppliedConnectionsHome } = {}) {
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const listenerKeys = await generateKeyPair();
  const channelId = `chan-${Math.random().toString(16).slice(2)}`;
  const listenerTransport = createLocalTransport({ channelId });
  const projectsApi = { listProjects: () => projects ?? [] };
  // Isolate ~/.weft per test (connections.json, sessions-live/, requests/) so these tests never
  // touch a real user's Weft home.
  const connectionsHome = suppliedConnectionsHome ?? mkdtempSync(join(tmpdir(), "weft-connections-"));
  if (!suppliedConnectionsHome) connectionsHomes.push(connectionsHome);
  const listener = createStation({
    transport: listenerTransport,
    keyPair: listenerKeys,
    channelId,
    deviceId: "test-device",
    heartbeatMs,
    allowTerminal,
    terminalHostFactory,
    ...(telemetryApi ? { telemetryApi } : {}),
    clipboardApi,
    keepAwakeApi,
    ...(monitoringLimits ? { monitoringLimits } : {}),
    projectsApi,
    ...(sessionsApi ? { sessionsApi } : {}),
    ...(opener ? { opener } : {}),
    ...(launcher ? { launcher } : {}),
    ...(controlClient ? { controlClient } : {}),
    scanRegistry: testScan,
    supervisorOptions: { ...QUIET_SUPERVISOR, ...supervisorOptions },
    storePath: join(connectionsHome, "session-store.db"),
    spawnFn,
    log,
    connectionsHome,
    onSessionOffers,
    onSessionClaimed,
    onControl,
    // Always hand the listener a descriptor. Without one, start() calls resolveTransport(), which
    // reads the REAL ~/.weft config and — on a devtunnel-configured machine — demands a live relay,
    // so the whole suite passed or failed depending on whether the developer happened to have
    // `weft start` running. Tests that care about the descriptor override this explicitly.
    transportDescriptor: transportDescriptor ?? { kind: "local", channelId },
    onDeviceConnected,
    onDeviceDisconnected,
  });
  await listener.start();

  const phoneTransport = createLocalTransport({ channelId });
  const phoneKeys = await generateKeyPair();
  const { key: phoneKey } = await sayHello({
    transport: phoneTransport,
    keyPair: phoneKeys,
    peerPublicKeyB64: listenerKeys.publicKeyB64,
    channelId,
    deviceId: "phone-1",
    senderName: "Phone",
    waitForAck: true,
    timeoutMs: 1000,
    retryMs: 20,
    pairingToken: listener.pairingPayload.token,
  });
  const phoneChannel = new SecureChannel({
    transport: phoneTransport,
    key: phoneKey,
    identity: { channelId, senderId: "phone", senderName: "Phone" },
  });
  const messages = [];
  phoneChannel.onEvent(EVENT_TYPE.CONTROL, (m) => messages.push(m));
  await phoneChannel.send(projectListRequest());
  await waitFor(() => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST), "project list");
  return { listener, listenerKeys, channelId, phoneChannel, phoneKeys, messages, connectionsHome };
}

async function utilityReply(harness, message, subtype) {
  const previous = harness.messages.length;
  await harness.phoneChannel.send(message);
  return waitFor(
    () => harness.messages.slice(previous).find((item) => item.eventSubtype === subtype),
    "correlated device utility reply",
  );
}

test("device utility capabilities independently reflect injected platform support", async (t) => {
  for (const clipboardPlatform of ["linux", "win32"]) {
    for (const powerPlatform of ["linux", "win32"]) {
      const h = await pairedHarness({
        clipboardApi: createDeviceClipboard({ platform: clipboardPlatform }),
        keepAwakeApi: createDeviceKeepAwakeController({ platform: powerPlatform }),
      });
      t.after(() => h.listener.stop());
      const list = h.messages.find((message) => message.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST);
      assert.deepEqual(list.msg.capabilities, [
        ATTENTION_CAPABILITY,
        DEVICE_CAPABILITY.MONITOR_V1,
        ...(clipboardPlatform === "win32" ? [DEVICE_CAPABILITY.CLIPBOARD_V1] : []),
        ...(powerPlatform === "win32" ? [DEVICE_CAPABILITY.KEEP_AWAKE_V1] : []),
        DEVICE_CAPABILITY.SESSION_ACTIVATION_V1,
      ]);
      await h.listener.stop();
    }
  }
});

test("clipboard controls are explicit, correlated, bounded, and absent from host hooks and persistence", async (t) => {
  const controls = [];
  const logs = [];
  const secret = "  私の-secret-$env:TOKEN\r\n";
  let reads = 0;
  let written;
  const h = await pairedHarness({
    clipboardApi: {
      supported: true,
      readText: async () => { reads++; return { code: "ok", text: secret }; },
      writeText: async (text) => { written = text; return { code: "ok", text: secret }; },
    },
    onControl: (value) => controls.push(value),
    log: { info: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
  });
  t.after(() => h.listener.stop());
  assert.equal(reads, 0);
  const read = await utilityReply(h, clipboardRead("read-1"), SUBTYPE.CONTROL.CLIPBOARD_RESULT);
  assert.deepEqual(read.msg, { requestId: "read-1", operation: "read", code: "ok", text: secret });
  const write = await utilityReply(h, clipboardWrite("write-1", secret), SUBTYPE.CONTROL.CLIPBOARD_RESULT);
  assert.equal(written, secret);
  assert.deepEqual(write.msg, { requestId: "write-1", operation: "write", code: "ok" });
  assert.equal(reads, 1);

  const oversized = { ...clipboardRead("large"), eventSubtype: SUBTYPE.CONTROL.CLIPBOARD_WRITE,
    msg: { requestId: "large", text: "x".repeat(CLIPBOARD_MAX_BYTES + 1) } };
  const rejected = await utilityReply(h, oversized, SUBTYPE.CONTROL.CLIPBOARD_RESULT);
  assert.equal(rejected.msg.code, "too-large");
  assert.equal(written, secret);
  const invalid = await utilityReply(h, clipboardRead(""), SUBTYPE.CONTROL.CLIPBOARD_RESULT);
  assert.equal(invalid.msg.code, "invalid-request");
  assert.equal(reads, 1);
  await h.phoneChannel.send({ ...clipboardRead("ignored"), eventSubtype: secret, msg: { text: secret } });
  await waitFor(() => controls.some((item) => item.subtype === null), "redacted unknown subtype");
  assert.equal(JSON.stringify({ controls, logs }).includes("secret"), false);
  assert.ok(controls.every((item) => Object.keys(item).join() === "subtype"));
  assert.equal(readFileSync(join(h.connectionsHome, "connections.json"), "utf8").includes("secret"), false);
});

test("clipboard adapter errors and oversized reads are sanitized at the listener boundary", async (t) => {
  const api = { supported: true, readText: async () => { throw new Error("private clipboard"); } };
  const h = await pairedHarness({ clipboardApi: api });
  t.after(() => h.listener.stop());
  let result = await utilityReply(h, clipboardRead("error"), SUBTYPE.CONTROL.CLIPBOARD_RESULT);
  assert.deepEqual(result.msg, { requestId: "error", operation: "read", code: "unavailable" });
  api.readText = async () => ({ code: "private error", text: "private clipboard" });
  result = await utilityReply(h, clipboardRead("raw"), SUBTYPE.CONTROL.CLIPBOARD_RESULT);
  assert.equal(result.msg.code, "unavailable");
  assert.equal("text" in result.msg, false);
  api.readText = async () => ({ code: "ok", text: "x".repeat(CLIPBOARD_MAX_BYTES + 1) });
  result = await utilityReply(h, clipboardRead("large"), SUBTYPE.CONTROL.CLIPBOARD_RESULT);
  assert.equal(result.msg.code, "too-large");
  assert.equal("text" in result.msg, false);
});

test("unsupported utilities return stable results without invoking platform operations", async (t) => {
  const h = await pairedHarness({
    clipboardApi: { supported: false, readText: () => assert.fail("unsupported read") },
    keepAwakeApi: { supported: false, start: () => assert.fail("unsupported start") },
  });
  t.after(() => h.listener.stop());
  const clipboard = await utilityReply(h, clipboardRead("read"), SUBTYPE.CONTROL.CLIPBOARD_RESULT);
  assert.equal(clipboard.msg.code, "unsupported");
  const power = await utilityReply(h, keepAwakeStart("start", "lease", 1), SUBTYPE.CONTROL.KEEP_AWAKE_STATUS);
  assert.equal(power.msg.code, "unsupported");
  assert.equal(power.msg.active, false);
});

test("listener Keep Awake validates raw controls, returns current revisions, and pushes only expiry/failure", async (t) => {
  let clock = 1_000;
  let timer;
  let callbacks;
  let starts = 0;
  let stops = 0;
  const keepAwakeApi = createDeviceKeepAwakeController({
    platform: "win32", now: () => clock,
    setTimeoutFn: (callback) => { timer = callback; return 1; }, clearTimeoutFn: () => { timer = null; },
    helperFactory: async (args) => {
      callbacks = args;
      starts++;
      return { updateExpiry: async () => {}, stop: () => { stops++; } };
    },
  });
  const h = await pairedHarness({ keepAwakeApi });
  t.after(() => h.listener.stop());
  let result = await utilityReply(h, {
    ...keepAwakeStart("invalid", "lease", 1),
    msg: { requestId: "invalid", leaseId: "lease", durationMs: "900000" },
  }, SUBTYPE.CONTROL.KEEP_AWAKE_STATUS);
  assert.equal(result.msg.code, "invalid-request");
  assert.equal(starts, 0);
  result = await utilityReply(h, keepAwakeStart("start", "lease", 1), SUBTYPE.CONTROL.KEEP_AWAKE_STATUS);
  assert.deepEqual(result.msg, {
    requestId: "start", leaseId: "lease", active: true, expiresAt: 1_000 + KEEP_AWAKE_MIN_MS, revision: 1, code: "ok",
  });
  const mismatch = await utilityReply(h, keepAwakeStop("stale", "old-lease"), SUBTYPE.CONTROL.KEEP_AWAKE_STATUS);
  assert.equal(mismatch.msg.code, "lease-mismatch");
  assert.equal(mismatch.msg.active, true);
  assert.equal(mismatch.msg.revision, 1);
  assert.equal(stops, 0);
  const status = await utilityReply(h, keepAwakeStatusRequest("reopen"), SUBTYPE.CONTROL.KEEP_AWAKE_STATUS);
  assert.deepEqual(status.msg, { ...result.msg, requestId: "reopen" });
  assert.equal(h.messages.some((item) => item.eventSubtype === SUBTYPE.CONTROL.KEEP_AWAKE_STATUS && item.msg.requestId === null), false);
  clock += KEEP_AWAKE_MIN_MS;
  timer();
  const expired = await waitFor(() => h.messages.find((item) =>
    item.eventSubtype === SUBTYPE.CONTROL.KEEP_AWAKE_STATUS && item.msg.requestId === null), "unsolicited expiry");
  assert.equal(expired.msg.leaseId, "lease");
  assert.equal(expired.msg.active, false);
  assert.equal(expired.msg.revision, 2);
  assert.equal(stops, 1);
  await utilityReply(h, keepAwakeStart("again", "next", 1), SUBTYPE.CONTROL.KEEP_AWAKE_STATUS);
  callbacks.onFailure("private helper failure");
  const failed = await waitFor(() => h.messages.find((item) =>
    item.eventSubtype === SUBTYPE.CONTROL.KEEP_AWAKE_STATUS && item.msg.requestId === null && item.msg.code === "unavailable"),
  "unsolicited helper failure");
  assert.equal(failed.msg.leaseId, "next");
  assert.equal(failed.msg.active, false);
  assert.equal(failed.msg.revision, 4);
  assert.equal(JSON.stringify(failed).includes("private"), false);
});

test("listener shutdown and forget dispose both utilities and suppress late clipboard/status completions", async (t) => {
  for (const forget of [false, true]) {
    let resolveRead;
    let readStarted = false;
    let clipboardShutdowns = 0;
    let powerShutdowns = 0;
    let unsubscribed = 0;
    let notify;
    const h = await pairedHarness({
      clipboardApi: {
        supported: true,
        readText: () => { readStarted = true; return new Promise((resolve) => { resolveRead = resolve; }); },
        shutdown: () => { clipboardShutdowns++; },
      },
      keepAwakeApi: {
        supported: true,
        onStatus: (callback) => { notify = callback; return () => { unsubscribed++; }; },
        shutdown: () => { powerShutdowns++; throw new Error("private cleanup error"); },
      },
    });
    t.after(() => h.listener.stop());
    await h.phoneChannel.send(clipboardRead("late"));
    await waitFor(() => readStarted, "clipboard started");
    if (forget) {
      await h.phoneChannel.send({ ...clipboardRead("forget"), eventSubtype: SUBTYPE.CONTROL.FORGET_DEVICE, msg: {} });
      await waitFor(() => clipboardShutdowns === 1, "forget cleanup");
    } else await h.listener.stop();
    assert.equal(clipboardShutdowns, 1);
    assert.equal(powerShutdowns, 1);
    assert.equal(unsubscribed, 1);
    resolveRead({ code: "ok", text: "late private clipboard" });
    notify({ active: false, revision: 2, code: "unavailable" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.messages.some((item) => [
      SUBTYPE.CONTROL.CLIPBOARD_RESULT, SUBTYPE.CONTROL.KEEP_AWAKE_STATUS,
    ].includes(item.eventSubtype)), false);
  }
});

test("phone reconnect keeps its station lease but cannot receive an earlier channel's clipboard completion", async (t) => {
  let resolveRead;
  let started = false;
  let spawns = 0;
  const keepAwakeApi = createDeviceKeepAwakeController({
    platform: "win32",
    helperFactory: async () => { spawns++; return { stop() {}, updateExpiry: async () => {} }; },
  });
  const h = await pairedHarness({
    keepAwakeApi,
    clipboardApi: {
      supported: true,
      readText: () => { started = true; return new Promise((resolve) => { resolveRead = resolve; }); },
    },
  });
  t.after(() => h.listener.stop());
  const first = await utilityReply(h, keepAwakeStart("start", "lease", 1), SUBTYPE.CONTROL.KEEP_AWAKE_STATUS);
  await h.phoneChannel.send(clipboardRead("old-read"));
  await waitFor(() => started, "pending clipboard read");
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const transport = createLocalTransport({ channelId: h.channelId });
  const { key } = await sayHello({
    transport, keyPair: h.phoneKeys, peerPublicKeyB64: h.listenerKeys.publicKeyB64, channelId: h.channelId,
    deviceId: "phone-1", senderName: "Phone", waitForAck: true, timeoutMs: 1_000, retryMs: 20,
  });
  const phoneChannel = new SecureChannel({
    transport, key, identity: { channelId: h.channelId, senderId: "phone", senderName: "Phone" },
  });
  const messages = [];
  phoneChannel.onEvent(EVENT_TYPE.CONTROL, (message) => messages.push(message));
  const status = await utilityReply({ phoneChannel, messages }, keepAwakeStatusRequest("reconnect"), SUBTYPE.CONTROL.KEEP_AWAKE_STATUS);
  assert.deepEqual(status.msg, { ...first.msg, requestId: "reconnect" });
  assert.equal(spawns, 1);
  resolveRead({ code: "ok", text: "old private clipboard" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal([...h.messages, ...messages].some((message) => message.eventSubtype === SUBTYPE.CONTROL.CLIPBOARD_RESULT), false);
});

test("emits PROJECT_LIST when the phone pairs", async () => {
  const projectDir = mkdtempSync(join(tmpdir(), "weft-listener-project-"));
  dirs.push(projectDir);
  const { listener, messages } = await pairedHarness({
    projects: [{ name: "app", path: projectDir, default: true }],
  });

  const list = messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST);
  assert.deepEqual(list.msg.projects, [{ name: "app", path: projectDir, isDefault: true }]);
  assert.ok(list.msg.deviceName);
  assert.equal(list.msg.deviceId, "test-device");
  assert.deepEqual(list.msg.capabilities, [
    ATTENTION_CAPABILITY,
    DEVICE_CAPABILITY.MONITOR_V1,
    DEVICE_CAPABILITY.SESSION_ACTIVATION_V1,
  ]);
  await listener.stop();
});

test("encrypted terminal controls bypass generic logging and require the explicit grant", async () => {
  const controls = [];
  const { listener, phoneChannel, messages } = await pairedHarness({ onControl: (event) => controls.push(event) });
  try {
    const count = controls.length;
    await phoneChannel.send(terminalRequest({ requestId: "terminal-denied", action: "open" }));
    await waitFor(() => messages.some((message) => message.msg?.requestId === "terminal-denied"));
    const reply = messages.find((message) => message.msg?.requestId === "terminal-denied");
    assert.equal(reply.eventSubtype, SUBTYPE.CONTROL.TERMINAL_STATE);
    assert.match(reply.msg.error, /terminal.enabled/);
    assert.equal(controls.length, count);
  } finally { await listener.stop(); }
});

test("terminal capability follows initialized runtime and Station stop disposes the host", async () => {
  let initialized = false, stopped = 0;
  const requests = [];
  const { listener, phoneChannel, messages } = await pairedHarness({
    allowTerminal: true,
    terminalHostFactory: ({ allowTerminal }) => ({
      initialize: async () => { initialized = true; },
      get supported() { return initialized && allowTerminal; },
      handle: async (request) => requests.push(request),
      disconnectPhone() {},
      stop: async () => { stopped++; },
    }),
  });
  try {
    const list = messages.find((message) => message.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST);
    assert.ok(list.msg.capabilities.includes(DEVICE_CAPABILITY.TERMINAL_V1));
    await phoneChannel.send(terminalRequest({ requestId: "terminal-open", action: "open" }));
    await waitFor(() => requests.length === 1);
    assert.equal(requests[0].requestId, "terminal-open");
  } finally { await listener.stop(); }
  assert.equal(stopped, 1);
});

test("refreshes an unclaimed listener grant and notifies the host", async () => {
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const listenerKeys = await generateKeyPair();
  const channelId = `chan-${Math.random().toString(16).slice(2)}`;
  const connectionsHome = mkdtempSync(join(tmpdir(), "weft-connections-"));
  connectionsHomes.push(connectionsHome);
  const refreshed = [];
  const listener = createStation({
    transport: createLocalTransport({ channelId }),
    transportDescriptor: { kind: "local", channelId },
    keyPair: listenerKeys,
    channelId,
    deviceId: "test-device",
    connectionsHome,
    scanRegistry: testScan,
    supervisorOptions: QUIET_SUPERVISOR,
    pairingTtlMs: 25,
    onPairingPayloadChanged: (payload) => refreshed.push(payload),
  });
  await listener.start();
  const original = listener.pairingPayload;

  await waitFor(() => refreshed.length > 0, "pairing grant refresh");
  assert.notEqual(refreshed[0].token, original.token);
  assert.equal(refreshed[0].channelId, original.channelId);
  assert.ok(refreshed[0].expiresAt > original.expiresAt);

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

test("device monitor sends ordered snapshots, renews, and ignores a stale stop", async (t) => {
  let captures = 0;
  const controls = [];
  const telemetryApi = {
    collectDeviceSnapshot: async () => ({
      capturedAt: ++captures,
      system: { cpuPercent: captures },
      apps: [],
      observedAt: { system: captures, disk: null, battery: null, apps: null },
      issues: [],
    }),
  };
  const limits = {
    minIntervalMs: 15,
    maxIntervalMs: 50,
    defaultIntervalMs: 20,
    minLeaseMs: 40,
    maxLeaseMs: 200,
    defaultLeaseMs: 100,
  };
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [],
    heartbeatMs: 1_000,
    telemetryApi,
    monitoringLimits: limits,
    onControl: ({ subtype }) => controls.push(subtype),
  });
  t.after(() => listener.stop());

  await phoneChannel.send(deviceMonitorStart("monitor-1", 1, 100));
  await waitFor(
    () => messages.filter((message) => message.eventSubtype === SUBTYPE.CONTROL.DEVICE_SNAPSHOT).length >= 2,
    "periodic device snapshots",
  );
  await phoneChannel.send(deviceMonitorStart("monitor-1", 15, 100));
  await phoneChannel.send(deviceMonitorStop("old-monitor"));
  const before = messages.filter((message) => message.eventSubtype === SUBTYPE.CONTROL.DEVICE_SNAPSHOT).length;
  await waitFor(
    () => messages.filter((message) => message.eventSubtype === SUBTYPE.CONTROL.DEVICE_SNAPSHOT).length > before,
    "snapshot after stale stop",
  );

  const snapshots = messages.filter((message) => message.eventSubtype === SUBTYPE.CONTROL.DEVICE_SNAPSHOT);
  assert.ok(snapshots.every((message) => message.msg.monitorId === "monitor-1"));
  assert.deepEqual(snapshots.map((message) => message.msg.sequence), snapshots.map((_, index) => index + 1));
  assert.ok(snapshots.every((message) => message.msg.effectiveIntervalMs === 15));

  await phoneChannel.send(deviceMonitorStop("monitor-1"));
  await waitFor(
    () => controls.filter((subtype) => subtype === SUBTYPE.CONTROL.DEVICE_MONITOR_STOP).length >= 2,
    "matching monitor stop",
  );
  const stoppedAt = captures;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(captures, stoppedAt);
});

test("device monitor lease expires without a stop and does not affect heartbeat", async (t) => {
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [],
    heartbeatMs: 20,
    telemetryApi: {
      collectDeviceSnapshot: async () => ({
        capturedAt: Date.now(),
        system: {},
        apps: [],
        observedAt: {},
        issues: [],
      }),
    },
    monitoringLimits: {
      minIntervalMs: 10,
      maxIntervalMs: 50,
      defaultIntervalMs: 10,
      minLeaseMs: 35,
      maxLeaseMs: 100,
      defaultLeaseMs: 35,
    },
  });
  t.after(() => listener.stop());

  await phoneChannel.send(deviceMonitorStart("monitor-expiring", 10, 35));
  await waitFor(
    () => messages.filter((message) => message.eventSubtype === SUBTYPE.CONTROL.DEVICE_SNAPSHOT).length >= 2,
    "leased device snapshots",
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  const snapshotsAfterExpiry = messages.filter(
    (message) => message.eventSubtype === SUBTYPE.CONTROL.DEVICE_SNAPSHOT,
  ).length;
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(
    messages.filter((message) => message.eventSubtype === SUBTYPE.CONTROL.DEVICE_SNAPSHOT).length,
    snapshotsAfterExpiry,
  );
  assert.ok(messages.some((message) => message.eventSubtype === SUBTYPE.CONTROL.DEVICE_HEARTBEAT));
});

test("SESSION_LIST_REQUEST replies with the store's resumable sessions (on-demand, not on bind)", async () => {
  const cwdA = mkdtempSync(join(tmpdir(), "weft-resume-cwd-"));
  dirs.push(cwdA);
  const sessionsApi = {
    listSessions: ({ limit, sort } = {}) => {
      sessionsApi.lastLimit = limit;
      sessionsApi.lastSort = sort;
      return [{ sessionId: "sid-1", title: "Fix bug", cwd: cwdA, repository: "web", branch: "main", updatedAt: 5 }];
    },
    readSessionCwd: () => cwdA,
  };
  const { listener, phoneChannel, messages } = await pairedHarness({ projects: [], sessionsApi });

  // Not pushed on bind: the phone must ask. Nothing should have arrived before the request.
  assert.equal(messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_LIST), undefined);

  await phoneChannel.send(sessionListRequest(50, null, "created", "req-list-1"));
  const list = await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_LIST),
    "session list",
  );
  assert.equal(list.msg.requestId, "req-list-1");
  assert.equal(list.msg.cwd, null);
  assert.equal(list.msg.sort, "created");
  assert.equal(sessionsApi.lastLimit, 50, "the requested limit is passed through to the store");
  assert.equal(sessionsApi.lastSort, "created", "the requested sort is passed through to the store");
  assert.equal(list.msg.sessions.length, 1);
  assert.deepEqual(list.msg.sessions[0], {
    sessionId: "sid-1", title: "Fix bug", cwd: cwdA, repository: "web", branch: "main", updatedAt: 5,
  });
  await listener.stop();
});

test("SESSION_LIST_REQUEST reports a store failure instead of an empty successful list", async (t) => {
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [],
    sessionsApi: {
      listSessions() {
        throw new Error("session store is unavailable");
      },
      readSessionCwd: () => null,
    },
  });
  t.after(() => listener.stop());

  await phoneChannel.send(sessionListRequest(50, "C:\\repo\\weft", "activity", "req-list-error"));
  const list = await waitFor(
    () => messages.find((message) => message.eventSubtype === SUBTYPE.CONTROL.SESSION_LIST),
    "failed session-list response",
  );
  assert.deepEqual(list.msg, {
    requestId: "req-list-error",
    cwd: "C:\\repo\\weft",
    sort: "activity",
    errorCode: "session-store-unavailable",
    sessions: [],
  });
});


test("the same paired phone can reconnect with its existing key while the QR grant stays single-use", async () => {
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const warnings = [];
  const { listener, listenerKeys, channelId, phoneKeys } = await pairedHarness({
    projects: [],
    log: { warn: (m) => warnings.push(m) },
  });

  const rescanTransport = createLocalTransport({ channelId });
  const rescanMessages = [];

  try {
    const { key } = await sayHello({
      transport: rescanTransport,
      keyPair: phoneKeys,
      peerPublicKeyB64: listenerKeys.publicKeyB64,
      channelId,
      deviceId: "phone-1",
      senderName: "Phone",
      waitForAck: true,
      timeoutMs: 1000,
      retryMs: 20,
      pairingToken: listener.pairingPayload.token,
    });
    const rescanChannel = new SecureChannel({
      transport: rescanTransport,
      key,
      identity: { channelId, senderId: "phone-1", senderName: "Phone" },
    });
    rescanChannel.onEvent(EVENT_TYPE.CONTROL, (m) => rescanMessages.push(m));
    await rescanChannel.send(projectListRequest());

    await waitFor(
      () => rescanMessages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST),
      "project list on the reconnected channel",
    );
    const status = listener.managementStatus();
    assert.equal(status.connected, true);
    assert.equal(status.phoneName, "Phone");
    assert.ok(status.lastPeerContactAt > 0);
    assert.equal(status.paired, true);
    assert.equal(status.pairingPayload, undefined);
    assert.deepEqual(warnings, []);
  } finally {
    // Always stop: a regression here leaves the listener holding its transport, and the test
    // runner then hangs on the open handles instead of reporting the failure.
    await listener.stop();
  }
});

test("a second different phone public key is ignored after first binding", async () => {
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const warnings = [];
  const { listener, listenerKeys, channelId, phoneChannel, messages } = await pairedHarness({
    projects: [],
    log: { warn: (m) => warnings.push(m) },
  });
  const secondTransport = createLocalTransport({ channelId });
  const secondKeys = await generateKeyPair();
  await assert.rejects(
    sayHello({
      transport: secondTransport,
      keyPair: secondKeys,
      peerPublicKeyB64: listenerKeys.publicKeyB64,
      channelId,
      deviceId: "phone-2",
      senderName: "Other Phone",
      waitForAck: true,
      timeoutMs: 100,
      retryMs: 20,
      pairingToken: listener.pairingPayload.token,
    }),
    /no ack/,
  );
  assert.deepEqual(warnings, []);
  const listCount = messages.filter((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST).length;
  await phoneChannel.send(projectListRequest());
  await waitFor(
    () => messages.filter((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST).length > listCount,
    "project list on the still-bound first phone",
  );
  await listener.stop();
});

test("records a connections.json entry on bind and removes it on stop", async () => {
  const { listener, channelId, connectionsHome } = await pairedHarness({ projects: [] });
  const map = readRegistry("connections.json", { baseDir: connectionsHome });
  assert.ok(map, "registry file should exist after a successful bind");
  const entry = map[channelId];
  assert.ok(entry, "entry for this listener's channelId should be present");
  assert.equal(entry.pid, process.pid);
  assert.equal(entry.deviceId, "test-device");
  assert.equal(entry.peerDeviceId, "phone-1");
  assert.equal(entry.peerSenderName, "Phone");
  assert.ok(typeof entry.peerPublicKeyB64 === "string" && entry.peerPublicKeyB64.length > 0);
  assert.ok(entry.boundAt);

  await listener.stop();
  const mapAfterStop = readRegistry("connections.json", { baseDir: connectionsHome });
  assert.equal(mapAfterStop?.[channelId], undefined, "entry should be removed on clean stop");
});

test("connections.json entries from processes that no longer exist are pruned on the next write", async () => {
  const { listener, connectionsHome } = await pairedHarness({ projects: [] });
  // Seed a stale entry as if a crashed session (pid that doesn't exist) never cleaned up after
  // itself — pruneDeadConnections() should drop it the next time ANY listener writes.
  const before = readRegistry("connections.json", { baseDir: connectionsHome }) ?? {};
  before["stale-channel"] = { pid: 999_999_999, deviceId: "ghost" };
  const { writeRegistryAtomic } = await import("../src/registryFile.mjs");
  writeRegistryAtomic("connections.json", before, { baseDir: connectionsHome });

  // Trigger another write by stopping (which removes this listener's own entry and rewrites the
  // file), which should prune the stale ghost entry along the way.
  await listener.stop();
  const after = readRegistry("connections.json", { baseDir: connectionsHome });
  assert.equal(after?.["stale-channel"], undefined, "stale pid entry should have been pruned");
});

test("relays SESSION_OFFERS for pending `/weft` sessions and drops them on SESSION_CLAIMED", async () => {
  const offered = [];
  const claimed = [];
  const { listener, phoneChannel, messages, connectionsHome } = await pairedHarness({
    projects: [],
    onSessionOffers: (offers) => offered.push(offers),
    onSessionClaimed: (id) => claimed.push(id),
  });

  // A live `/weft` session in this same (test) process publishes its pairing offer in its own live
  // record (sessionRegistry); Station only reads it.
  const payload = { v: 1, channelId: "offer-1", pub: "PUB", transport: { kind: "local" } };
  const record = await publishSessionRecord({
    session: { storeAuthority: "sha256:store", sessionId: "session-offer" },
    run: { runtimeId: "runtime-offer", generation: 1, processStartedAt: 1 },
    pipe: "pipe-offer",
    offer: { channelId: "offer-1", name: "web", cwd: "/repo/web", payload, expiresAt: Date.now() + 60_000 },
  }, { baseDir: connectionsHome });

  // Deterministically pull the offers via the PROJECT_LIST_REQUEST piggyback (rather than racing
  // the fs watcher): the listener answers with SESSION_OFFERS carrying our pending session.
  await phoneChannel.send(projectListRequest());
  const offersMsg = await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_OFFERS && m.msg.offers.length > 0),
    "session offers",
  );
  assert.equal(offersMsg.msg.offers.length, 1);
  assert.deepEqual(offersMsg.msg.offers[0], { channelId: "offer-1", name: "web", cwd: "/repo/web", payload });
  assert.ok(offered.some((list) => list.some((o) => o.channelId === "offer-1")), "onSessionOffers hook fired");

  // The phone adopts the offer → SESSION_CLAIMED suppresses it and Station re-broadcasts an (now
  // empty) offer set. Station never rewrites the session's record; the session withdraws it.
  const offersSeen = messages.filter((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_OFFERS).length;
  await phoneChannel.send(sessionClaimed("offer-1"));
  await waitFor(() => claimed.includes("offer-1"), "claim handled");
  assert.equal(record.record.offer.channelId, "offer-1", "Station does not write the session record");
  const clearMsg = await waitFor(
    () =>
      messages
        .filter((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_OFFERS)
        .slice(offersSeen)
        .find((m) => m.msg.offers.length === 0),
    "empty offers after claim",
  );
  assert.equal(clearMsg.msg.offers.length, 0);
  await listener.stop();
  record.close();
});

// --- mid-run transport rebind (devtunnel relay came back on a NEW url) -----------------------
// `weft start`'s relay watchdog calls listener.rebindTransport() so the station can re-pair
// inline instead of forcing the user to kill it and re-run. What matters here: the pairing
// identity survives (so the reprinted QR keeps the channel/keypair with a fresh grant and endpoint), the
// stale phone is reported as gone rather than silently heartbeated at, and a phone that scans
// the new QR binds normally.

test("rebindTransport keeps the pairing identity but republishes a new endpoint", async () => {
  const { listener, listenerKeys, channelId } = await pairedHarness({
    projects: [],
    transportDescriptor: { kind: "local", url: "wss://old.devtunnels.ms" },
  });
  const before = listener.pairingPayload;

  const result = await listener.rebindTransport({ kind: "local", url: "wss://new.devtunnels.ms" });

  assert.equal(result.changed, true);
  assert.deepEqual(result.descriptor, { kind: "local", url: "wss://new.devtunnels.ms" });
  assert.equal(listener.transportDescriptor.url, "wss://new.devtunnels.ms");
  assert.equal(listener.pairingPayload.transport.url, "wss://new.devtunnels.ms");
  assert.equal(listener.pairingPayload.channelId, channelId, "channel id survives the rebind");
  assert.equal(listener.pairingPayload.channelId, before.channelId);
  assert.equal(listener.pairingPayload.pub, listenerKeys.publicKeyB64, "listener keypair survives the rebind");
  await listener.stop();
});

test("rebindTransport is a no-op when the transport resolves unchanged", async () => {
  const descriptor = { kind: "local", url: "wss://same.devtunnels.ms" };
  const { listener } = await pairedHarness({ projects: [], transportDescriptor: descriptor });
  const before = listener.pairingPayload;

  const result = await listener.rebindTransport({ ...descriptor });

  assert.equal(result.changed, false);
  assert.equal(listener.pairingPayload, before, "payload object is left untouched");
  await listener.stop();
});

test("rebindTransport drops the dead endpoint, then accepts only the already-bound phone", async () => {
  const disconnects = [];
  const connects = [];
  const { listener, listenerKeys, channelId, phoneKeys } = await pairedHarness({
    projects: [],
    transportDescriptor: { kind: "local", url: "wss://old.devtunnels.ms" },
    onDeviceConnected: () => connects.push("connected"),
    onDeviceDisconnected: () => disconnects.push("disconnected"),
  });
  assert.equal(connects.length, 1);

  await listener.rebindTransport({ kind: "local", url: "wss://new.devtunnels.ms" });
  // The old phone still holds the dead URL — report it gone instead of heartbeating into a void.
  assert.equal(disconnects.length, 1, "bound phone is reported disconnected");

  // The already-bound phone can reconnect on the new endpoint without making the one-time QR
  // grant reusable by a different key.
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const rescanTransport = createLocalTransport({ channelId });
  const { key: rescanKey } = await sayHello({
    transport: rescanTransport,
    keyPair: phoneKeys,
    peerPublicKeyB64: listenerKeys.publicKeyB64,
    channelId,
    deviceId: "phone-1",
    senderName: "Phone",
    waitForAck: true,
    timeoutMs: 1000,
    retryMs: 20,
  });
  const rescanChannel = new SecureChannel({
    transport: rescanTransport,
    key: rescanKey,
    identity: { channelId, senderId: "phone-1", senderName: "Phone" },
  });
  const seen = [];
  rescanChannel.onEvent(EVENT_TYPE.CONTROL, (m) => seen.push(m));
  await rescanChannel.send(projectListRequest());
  await waitFor(() => seen.find((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST), "project list after re-scan");
  assert.equal(connects.length, 2, "the bound phone reconnects on the new endpoint");
  await listener.stop();
});


// ---- protocol v3: open requests, health, supervisor -------------------------------------------------

async function liveRecord(baseDir, { runtimeId, sessionId, link = {}, storeAuthority = "sha256:store" } = {}) {
  return publishSessionRecord({
    session: { storeAuthority, sessionId },
    run: { runtimeId, generation: 1, processStartedAt: 1, version: "0.2.75" },
    pipe: `pipe-${runtimeId}`,
    link: { state: "dormant", ...link },
  }, { baseDir });
}

test("open_session for a project launches one Copilot with the request's identity and streams lifecycle_status", async () => {
  const oldWt = process.env.WT_SESSION;
  const oldTerm = process.env.TERM_PROGRAM;
  const oldGnome = process.env.GNOME_TERMINAL_SCREEN;
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const projectDir = mkdtempSync(join(tmpdir(), "weft-station-project-"));
  dirs.push(projectDir);
  const spawnCalls = [];
  const { listener, phoneChannel, messages, connectionsHome } = await pairedHarness({
    projects: [{ name: "app", path: projectDir, default: true }],
    spawnFn(command, args, options) {
      spawnCalls.push({ command, args, options });
      return { unref() {} };
    },
  });
  try {
    await phoneChannel.send(openSession({ requestId: "req-1", target: { project: "app" }, options: { permissionMode: "allow-all", title: "phone-started" } }));
    const waiting = await waitFor(() => messages.find((m) =>
      m.eventSubtype === SUBTYPE.CONTROL.LIFECYCLE_STATUS && m.msg.requestId === "req-1" && m.msg.stage === "awaiting-runtime"), "awaiting-runtime", 5_000);
    process.env.WT_SESSION = oldWt;
    process.env.TERM_PROGRAM = oldTerm;
    process.env.GNOME_TERMINAL_SCREEN = oldGnome;
    assert.equal(spawnCalls.length, 1);
    if (process.platform === "win32") {
      assert.match(spawnCalls[0].command, /cmd\.exe$/i);
      const broker = spawnCalls[0].args.at(-1);
      identityFiles.push(broker);
      const launcher = readFileSync(broker, "utf8").match(/\/k "([^"]+\.cmd)"/)[1].replaceAll("%%", "%");
      identityFiles.push(launcher);
      assert.ok(readFileSync(launcher, "utf8").includes("copilot -n phone-started --allow-all"));
    } else {
      assert.equal(spawnCalls[0].command, "copilot");
      assert.deepEqual(spawnCalls[0].args, ["-n", "phone-started", "--allow-all"]);
    }
    assert.equal(spawnCalls[0].options.cwd, projectDir);
    assert.equal(spawnCalls[0].options.shell, false);
    const identityFile = spawnCalls[0].options.env.WEFT_IDENTITY_FILE;
    assert.ok(identityFile.startsWith(join(connectionsHome, "requests")), "the identity lives with its request");
    const identity = JSON.parse(readFileSync(identityFile, "utf8"));
    assert.equal(identity.requestId, "req-1");
    const imported = await importKeyPair({ privateKeyJwk: identity.privateKeyJwk });
    assert.equal(imported.publicKeyB64, identity.publicKeyB64);
    assert.equal(waiting.msg.result.action, "start");
    assert.equal(waiting.msg.result.payload.channelId, identity.channelId);
    assert.equal(waiting.msg.result.payload.pub, identity.publicKeyB64);
    assert.equal(waiting.msg.result.payload.token, identity.pairingToken);

    const before = messages.length;
    await phoneChannel.send(openSession({ requestId: "req-1", target: { project: "app" }, options: { permissionMode: "allow-all", title: "phone-started" } }));
    await phoneChannel.send(lifecycleStatusRequest("req-1"));
    await waitFor(() => messages.slice(before).find((m) => m.eventSubtype === SUBTYPE.CONTROL.LIFECYCLE_STATUS && m.msg.requestId === "req-1"), "replayed status");
    assert.equal(spawnCalls.length, 1, "a duplicate delivery never launches again");
  } finally {
    await listener.stop();
  }
});

test("pre-v3 launch requests are refused explicitly with update_required", async () => {
  const spawnCalls = [];
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [{ name: "app", path: tmpdir(), default: true }],
    spawnFn: (...args) => { spawnCalls.push(args); return { unref() {} }; },
  });
  try {
    // What a pre-v3 phone sends; v3 has no builders for these.
    const preV3 = (eventSubtype, msg) => ({ eventType: EVENT_TYPE.CONTROL, eventSubtype, msg, ts: Date.now() });
    await phoneChannel.send(preV3(SUBTYPE.CONTROL.SPAWN_SESSION, { requestId: "legacy-1", projectName: "app", mode: "default", name: null }));
    await phoneChannel.send(preV3(SUBTYPE.CONTROL.RESUME_SESSION, { requestId: "legacy-2", sessionId: "session-a", mode: "default", force: false }));
    await waitFor(() => messages.filter((m) => m.eventSubtype === SUBTYPE.CONTROL.UPDATE_REQUIRED).length === 2, "update_required");
    const notice = messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.UPDATE_REQUIRED);
    assert.equal(notice.msg.side, "phone");
    assert.equal(notice.msg.minVersion, 3);
    assert.equal(spawnCalls.length, 0);
    assert.equal(messages.some((m) => ["spawn_result", "spawn_pairing", "launch_status"].includes(m.eventSubtype)), false);
  } finally {
    await listener.stop();
  }
});

test("lifecycle_status_request for an unknown request answers not-found", async () => {
  const { listener, phoneChannel, messages } = await pairedHarness({ projects: [] });
  try {
    await phoneChannel.send(lifecycleStatusRequest("nobody"));
    const status = await waitFor(() => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.LIFECYCLE_STATUS), "status");
    assert.equal(status.msg.outcome, "failed");
    assert.equal(status.msg.reason, "not-found");
  } finally {
    await listener.stop();
  }
});

test("session list marks live sessions running and adds live ones missing from the saved page", async (t) => {
  const connectionsHome = mkdtempSync(join(tmpdir(), "weft-live-catalog-"));
  const sessionCwd = mkdtempSync(join(tmpdir(), "weft-live-catalog-cwd-"));
  connectionsHomes.push(connectionsHome);
  dirs.push(sessionCwd);
  const record = await liveRecord(connectionsHome, {
    runtimeId: "runtime-live", sessionId: "session-live-catalog",
    storeAuthority: deriveStoreAuthority(join(connectionsHome, "session-store.db")),
  });
  t.after(() => record.close());
  const h = await pairedHarness({
    connectionsHome,
    sessionsApi: {
      listSessions: () => [],
      readSession: (sessionId) => sessionId === "session-live-catalog"
        ? { sessionId, title: "Live catalog session", cwd: sessionCwd, repository: "weft", branch: "main", updatedAt: 10 }
        : null,
    },
  });
  t.after(() => h.listener.stop());
  await h.phoneChannel.send(sessionListRequest(50));
  const list = await waitFor(() => h.messages.find((message) => message.eventSubtype === SUBTYPE.CONTROL.SESSION_LIST), "merged session list", 5_000);
  const live = list.msg.sessions.find((session) => session.sessionId === "session-live-catalog");
  assert.equal(live.running, true);
});

test("session_health_request probes the session immediately and answers with the shared projection", async (t) => {
  const connectionsHome = mkdtempSync(join(tmpdir(), "weft-health-"));
  connectionsHomes.push(connectionsHome);
  const storeAuthority = deriveStoreAuthority(join(connectionsHome, "session-store.db"));
  const record = await liveRecord(connectionsHome, { runtimeId: "runtime-h", sessionId: "session-h", storeAuthority, link: { state: "linked", generation: 2, phoneWatching: false } });
  t.after(() => record.close());
  const probes = [];
  const h = await pairedHarness({
    connectionsHome,
    controlClient: (target) => ({ command: async (name) => { probes.push(name); return { link: target.link }; } }),
  });
  t.after(() => h.listener.stop());
  const before = probes.length;
  await h.phoneChannel.send(sessionHealthRequest("session-h"));
  const health = await waitFor(() => h.messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_HEALTH), "session_health");
  assert.ok(probes.length > before, "an immediate probe ran");
  assert.deepEqual({ label: health.msg.label, reason: health.msg.reason, observer: health.msg.observer, runtimeId: health.msg.runtimeId },
    { label: "linked", reason: "phone-away", observer: "station", runtimeId: "runtime-h" });
  await h.phoneChannel.send(sessionHealthRequest("session-gone"));
  const gone = await waitFor(() => h.messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_HEALTH && m.msg.sessionId === "session-gone"), "gone");
  assert.equal(gone.msg.label, "gone");
});

function supervisorWorld({ records, behaviors = {}, now }) {
  const commands = [];
  const outages = [];
  const supervisor = createSupervisor({
    now,
    scan: async () => ({
      live: records,
      foreign: [], unverified: [], legacyOwners: [],
      sessions: records.map((record) => ({ key: record.session, runtimes: [record], ownerConflict: false })),
    }),
    control: (record) => ({
      async command(name, payload) {
        commands.push([record.run.runtimeId, name, payload]);
        const behavior = behaviors[record.run.runtimeId] ?? {};
        if (behavior.unresponsive) throw Object.assign(new Error("timed out"), { timeout: true });
        if (name === "probe") return { link: record.link };
        if (name === "resetLink") return behavior.resetLink?.(payload, record) ?? { result: "reset" };
        return {};
      },
    }),
    onSharedOutage: async () => { outages.push(now()); },
    randomId: (() => { let n = 0; return () => `op-${++n}`; })(),
  });
  return { supervisor, commands, outages };
}

function fakeRecord(runtimeId, link) {
  return {
    schema: 1,
    session: { storeAuthority: "sha256:store", sessionId: `session-${runtimeId}` },
    run: { runtimeId, generation: 1, pid: 1, processStartedAt: 1, version: "0.2.75", openedBy: null, cwd: null },
    control: { pipe: "p" },
    link: { generation: 1, state: "linked", attempt: 0, deadlineAt: null, lastError: null, controllerRevision: 0, lastPhoneContactAt: null, phoneWatching: true, endpointRevision: 0, ...link },
    offer: null,
    updatedAt: 1,
  };
}

test("a link-stuck session is repaired in place at most twice per episode, then needs attention", async () => {
  let clock = 1_000_000;
  const stuck = fakeRecord("rt-stuck", { state: "connecting", deadlineAt: clock - 1, generation: 4 });
  const { supervisor, commands } = supervisorWorld({ records: [stuck], now: () => clock });
  for (let sweep = 0; sweep < 4; sweep += 1) {
    await supervisor.sweep();
    clock += 15_000;
  }
  const resets = commands.filter(([, name]) => name === "resetLink");
  assert.equal(resets.length, 2);
  assert.deepEqual(resets[0][2], { opId: "op-1", expectGeneration: 4, by: "station" });
  const health = supervisor.health("session-rt-stuck");
  assert.deepEqual([health.label, health.reason], ["stalled", "needs-attention"]);
  assert.equal(supervisor.list()[0].lastRepair.result, "reset");

  stuck.link = { ...stuck.link, generation: 6, state: "linked", deadlineAt: null };
  await supervisor.sweep();
  assert.deepEqual([supervisor.health("session-rt-stuck").label, supervisor.health("session-rt-stuck").reason], ["linked", null], "the episode ends once a newer generation links");
});

test("unresponsive and config-error sessions are reported, never repaired or restarted", async () => {
  let clock = 2_000_000;
  const silent = fakeRecord("rt-silent", { state: "linked" });
  const misconfigured = fakeRecord("rt-config", { state: "connecting", deadlineAt: clock - 1, lastError: { code: "auth-failed", at: clock } });
  const { supervisor, commands } = supervisorWorld({ records: [silent, misconfigured], behaviors: { "rt-silent": { unresponsive: true } }, now: () => clock });
  await supervisor.sweep();
  clock += 15_000;
  await supervisor.sweep();
  assert.equal(supervisor.health("session-rt-silent").reason, "unresponsive");
  assert.equal(supervisor.health("session-rt-config").reason, "config-error");
  assert.deepEqual(commands.filter(([, name]) => name !== "probe"), []);
});

test("A4: a backgrounded phone and an hour of laptop sleep cause no repair and no resume", async () => {
  let clock = 3_000_000;
  const away = fakeRecord("rt-away", { state: "linked", phoneWatching: false, lastPhoneContactAt: clock - 30 * 60_000 });
  const { supervisor, commands } = supervisorWorld({ records: [away], now: () => clock });
  await supervisor.sweep();
  assert.deepEqual([supervisor.health("session-rt-away").label, supervisor.health("session-rt-away").reason], ["linked", "phone-away"]);
  clock += 60 * 60_000;
  // While asleep the session's link may look stuck; the first sweep after the jump only observes.
  away.link = { ...away.link, state: "connecting", deadlineAt: clock - 1_000 };
  await supervisor.sweep();
  assert.deepEqual(commands.filter(([, name]) => name !== "probe"), [], "grace sweep: observe only");
  away.link = { ...away.link, state: "linked", deadlineAt: null, phoneWatching: true, generation: 2 };
  clock += 15_000;
  await supervisor.sweep();
  assert.deepEqual(commands.filter(([, name]) => name !== "probe"), []);
  assert.deepEqual([supervisor.health("session-rt-away").label, supervisor.health("session-rt-away").reason], ["linked", null]);
});

test("A6: an outage of every session runs one shared check, no per-session repair, and Station announces its new endpoint", async (t) => {
  const connectionsHome = mkdtempSync(join(tmpdir(), "weft-outage-"));
  connectionsHomes.push(connectionsHome);
  const stuckAt = Date.now() - 1_000;
  const records = [];
  for (const id of ["a", "b", "c"]) {
    records.push(await liveRecord(connectionsHome, { runtimeId: `rt-${id}`, sessionId: `session-${id}`, link: { state: "connecting", deadlineAt: stuckAt, generation: 3 } }));
  }
  t.after(() => records.forEach((record) => record.close()));
  const commands = [];
  let bound;
  const stationReady = new Promise((resolve) => { bound = resolve; });
  const checks = [];
  const h = await pairedHarness({
    connectionsHome,
    transportDescriptor: { kind: "local", url: "wss://old.devtunnels.ms" },
    controlClient: (target) => ({ command: async (name) => { commands.push(name); return name === "probe" ? { link: target.link } : {}; } }),
    supervisorOptions: {
      onSharedOutage: async () => {
        checks.push(Date.now());
        // The bound phone must still hear where Station moved.
        return (await stationReady).rebindTransport({ kind: "local", url: "wss://new.devtunnels.ms" });
      },
    },
  });
  bound(h.listener);
  t.after(() => h.listener.stop());
  await h.listener.supervisor.sweep();
  await h.listener.supervisor.sweep();
  assert.equal(checks.length, 1, "one shared check for the whole outage");
  assert.equal(commands.filter((name) => name === "resetLink").length, 0, "no per-session repair storm");
  assert.equal(h.listener.supervisor.health("session-a").reason, "shared-outage");
  const update = await waitFor(() => h.messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.ENDPOINT_UPDATE), "endpoint_update");
  assert.equal(update.msg.endpointRevision, 1);
  assert.deepEqual(update.msg.descriptor, { kind: "local", url: "wss://new.devtunnels.ms" });
});

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
  sessionListRequest,
  resumeSession,
  projectListRequest,
  sessionClaimed,
} from "@aasis21/weft-shared";
import { createListener } from "../src/listener.mjs";
import { readRegistry } from "../src/registryFile.mjs";
import { registerPendingSession } from "../src/pendingSessions.mjs";
import { HEALTHY_WINDOW_MS } from "../src/attachedSessions.mjs";

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

async function pairedHarness({ projects, spawnFn, log, heartbeatMs, onSessionOffers, onSessionClaimed, sessionsApi, attachedApi, transportDescriptor, onDeviceConnected, onDeviceDisconnected } = {}) {
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const listenerKeys = await generateKeyPair();
  const channelId = `chan-${Math.random().toString(16).slice(2)}`;
  const listenerTransport = createLocalTransport({ channelId });
  const projectsApi = { listProjects: () => projects ?? [] };
  // Isolate the connections.json registry per test so these tests never touch a real user's
  // ~/.weft — see registryFile.mjs / the CONNECTIONS_REGISTRY_FILE comment in listener.mjs.
  const connectionsHome = mkdtempSync(join(tmpdir(), "weft-connections-"));
  connectionsHomes.push(connectionsHome);
  const listener = createListener({
    transport: listenerTransport,
    keyPair: listenerKeys,
    channelId,
    deviceId: "test-device",
    heartbeatMs,
    projectsApi,
    ...(sessionsApi ? { sessionsApi } : {}),
    ...(attachedApi ? { attachedApi } : {}),
    spawnFn,
    log,
    connectionsHome,
    onSessionOffers,
    onSessionClaimed,
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
  return { listener, listenerKeys, channelId, phoneChannel, phoneKeys, messages, connectionsHome };
}

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

  const projectDir = mkdtempSync(join(tmpdir(), "weft-listener-project-"));
  dirs.push(projectDir);
  const spawnCalls = [];
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [{ name: "app", path: projectDir, default: true }],
    spawnFn(command, args, options) {
      spawnCalls.push({ command, args, options });
      identityFiles.push(options.env.WEFT_IDENTITY_FILE);
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
  assert.deepEqual(spawnCalls[0].args, ["-n", "phone-started", "--allow-all"]);
  assert.equal(spawnCalls[0].options.cwd, projectDir);
  assert.equal(spawnCalls[0].options.shell, false);
  const identity = JSON.parse(readFileSync(spawnCalls[0].options.env.WEFT_IDENTITY_FILE, "utf8"));
  assert.equal(identity.channelId, spawnCalls[0].options.env.WEFT_CHANNEL_ID);
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
  const projectDir = mkdtempSync(join(tmpdir(), "weft-listener-project-"));
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

test("SESSION_LIST_REQUEST replies with the store's resumable sessions (on-demand, not on bind)", async () => {
  const cwdA = mkdtempSync(join(tmpdir(), "weft-resume-cwd-"));
  dirs.push(cwdA);
  const sessionsApi = {
    listSessions: ({ limit } = {}) => {
      sessionsApi.lastLimit = limit;
      return [{ sessionId: "sid-1", title: "Fix bug", cwd: cwdA, repository: "web", branch: "main", updatedAt: 5 }];
    },
    readSessionCwd: () => cwdA,
  };
  const { listener, phoneChannel, messages } = await pairedHarness({ projects: [], sessionsApi });

  // Not pushed on bind: the phone must ask. Nothing should have arrived before the request.
  assert.equal(messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_LIST), undefined);

  await phoneChannel.send(sessionListRequest(50));
  const list = await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_LIST),
    "session list",
  );
  assert.equal(sessionsApi.lastLimit, 50, "the requested limit is passed through to the store");
  assert.equal(list.msg.sessions.length, 1);
  assert.deepEqual(list.msg.sessions[0], {
    sessionId: "sid-1", title: "Fix bug", cwd: cwdA, repository: "web", branch: "main", updatedAt: 5,
  });
  await listener.stop();
});

test("RESUME_SESSION spawns `copilot --resume=<id>` in the session's cwd and pairs", async () => {
  const oldWt = process.env.WT_SESSION;
  const oldTerm = process.env.TERM_PROGRAM;
  const oldGnome = process.env.GNOME_TERMINAL_SCREEN;
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;

  const sessionCwd = mkdtempSync(join(tmpdir(), "weft-resume-cwd-"));
  dirs.push(sessionCwd);
  const spawnCalls = [];
  const sessionsApi = {
    listSessions: () => [],
    readSessionCwd: (id) => (id === "sid-42" ? sessionCwd : null),
  };
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [],
    sessionsApi,
    spawnFn(command, args, options) {
      spawnCalls.push({ command, args, options });
      identityFiles.push(options.env.WEFT_IDENTITY_FILE);
      return { unref() {} };
    },
  });

  await phoneChannel.send(resumeSession("req-r1", "sid-42", "allow-all"));
  const result = await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT && m.msg.requestId === "req-r1"),
    "resume result",
  );

  process.env.WT_SESSION = oldWt;
  process.env.TERM_PROGRAM = oldTerm;
  process.env.GNOME_TERMINAL_SCREEN = oldGnome;

  assert.equal(spawnCalls.length, 1);
  assert.equal(spawnCalls[0].command, "copilot");
  assert.deepEqual(spawnCalls[0].args, ["--resume=sid-42", "--allow-all"]);
  assert.equal(spawnCalls[0].options.cwd, sessionCwd);
  const pairing = messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_PAIRING && m.msg.requestId === "req-r1");
  assert.ok(pairing, "a SPAWN_PAIRING is sent for the resumed session");
  assert.equal(pairing.msg.payload.channelId, spawnCalls[0].options.env.WEFT_CHANNEL_ID);
  assert.equal(result.msg.ok, true);
  await listener.stop();
});

test("RESUME_SESSION for an unknown / vanished session emits SPAWN_RESULT ok:false", async () => {
  const sessionsApi = { listSessions: () => [], readSessionCwd: () => null };
  const { listener, phoneChannel, messages } = await pairedHarness({
    projects: [],
    sessionsApi,
    spawnFn() { throw new Error("should not spawn"); },
  });
  await phoneChannel.send(resumeSession("req-gone", "sid-gone", "default"));
  const result = await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT && m.msg.requestId === "req-gone"),
    "failed resume result",
  );
  assert.equal(result.msg.ok, false);
  assert.match(result.msg.error, /no longer in the CLI session store/);
  await listener.stop();
});

// --- the "already attached" guard -------------------------------------------------------------
// A resume that forks a second `copilot --resume` onto a session already running and paired leaves
// two CLI processes writing one session-store entry. The phone catches what it can see, but it is
// blind to a session paired to a DIFFERENT phone, so the station has to answer for itself.

/** A resume harness whose store always resolves `sid-live`, with a scripted attachment registry. */
async function resumeGuardHarness(attached, { kills } = {}) {
  // Same terminal-detection scrubbing as the plain resume test: with a terminal in the environment
  // the station launches through it rather than spawning directly, which changes the argv shape.
  delete process.env.WT_SESSION;
  delete process.env.TERM_PROGRAM;
  delete process.env.GNOME_TERMINAL_SCREEN;
  const sessionCwd = mkdtempSync(join(tmpdir(), "weft-resume-cwd-"));
  dirs.push(sessionCwd);
  const spawnCalls = [];
  const h = await pairedHarness({
    projects: [],
    sessionsApi: { listSessions: () => [], readSessionCwd: (id) => (id === "sid-live" ? sessionCwd : null) },
    attachedApi: { findAttachedSession: () => attached },
    spawnFn(command, args, options) {
      spawnCalls.push({ command, args, options });
      identityFiles.push(options.env.WEFT_IDENTITY_FILE);
      return { unref() {} };
    },
  });
  return { ...h, spawnCalls, sessionCwd, kills };
}

test("RESUME_SESSION refuses to fork a second CLI onto a session that is already attached and healthy", async () => {
  const { listener, phoneChannel, messages, spawnCalls } = await resumeGuardHarness({
    sessionId: "sid-live", channelId: "chan-other", pid: process.pid, lastHealthyAt: Date.now(), healthy: true,
  });

  await phoneChannel.send(resumeSession("req-dup", "sid-live", "default"));
  const result = await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT && m.msg.requestId === "req-dup"),
    "refused resume result",
  );

  assert.equal(spawnCalls.length, 0, "no second process is started");
  assert.equal(result.msg.ok, false);
  assert.match(result.msg.error, /already running/);
  await listener.stop();
});

test("RESUME_SESSION still spawns when the attachment has stopped heartbeating — resume is the only way back from a wedged weft", async () => {
  // The important one. A pid-only guard would refuse here and leave the user with no route at all:
  // the process is alive, so it would be told "already running", but nothing inside it is listening.
  const { listener, phoneChannel, messages, spawnCalls } = await resumeGuardHarness({
    sessionId: "sid-live", channelId: "chan-wedged", pid: process.pid,
    lastHealthyAt: Date.now() - HEALTHY_WINDOW_MS - 1_000, healthy: false,
  });

  await phoneChannel.send(resumeSession("req-wedged", "sid-live", "default"));
  const result = await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT && m.msg.requestId === "req-wedged"),
    "recovery resume result",
  );

  assert.equal(spawnCalls.length, 1, "the wedged session is resumable");
  assert.ok(
    JSON.stringify(spawnCalls[0].args).includes("--resume=sid-live"),
    "and it is resumed, not started fresh",
  );
  assert.equal(result.msg.ok, true);
  await listener.stop();
});

test("RESUME_SESSION spawns normally when nothing is attached to the session", async () => {
  const { listener, phoneChannel, messages, spawnCalls } = await resumeGuardHarness(null);

  await phoneChannel.send(resumeSession("req-free", "sid-live", "default"));
  await waitFor(
    () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT && m.msg.requestId === "req-free"),
    "resume result",
  );

  assert.equal(spawnCalls.length, 1);
  await listener.stop();
});

test("RESUME_SESSION with force closes the attached session first, rather than leaving two running", async () => {
  const attached = {
    sessionId: "sid-live", channelId: "chan-other", pid: 999_999, lastHealthyAt: Date.now(), healthy: true,
  };
  const { listener, phoneChannel, messages, spawnCalls } = await resumeGuardHarness(attached);

  const realKill = process.kill;
  const killed = [];
  process.kill = (pid, signal) => { killed.push(pid); return true; };
  try {
    await phoneChannel.send(resumeSession("req-force", "sid-live", "default", true));
    const result = await waitFor(
      () => messages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT && m.msg.requestId === "req-force"),
      "forced resume result",
    );
    assert.deepEqual(killed, [999_999], "the old process is closed, not left running alongside");
    assert.equal(spawnCalls.length, 1);
    assert.equal(result.msg.ok, true);
  } finally {
    process.kill = realKill;
  }
  await listener.stop();
});

test("the same phone re-scanning the QR is re-paired, not rejected as a different phone", async () => {
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const warnings = [];
  const { listener, listenerKeys, channelId } = await pairedHarness({
    projects: [],
    log: { warn: (m) => warnings.push(m) },
  });

  // A re-scan mints a FRESH keypair on the phone but keeps its stable localStorage device id, so
  // this is what "same handset, scanned the QR again" actually looks like on the wire.
  const rescanTransport = createLocalTransport({ channelId });
  const rescanKeys = await generateKeyPair();
  const rescanKey = await deriveSessionKey(rescanKeys.privateKey, listenerKeys.publicKeyB64);
  const rescanChannel = new SecureChannel({
    transport: rescanTransport,
    key: rescanKey,
    identity: { channelId, senderId: "phone-1", senderName: "Phone" },
  });
  const rescanMessages = [];
  rescanChannel.onEvent(EVENT_TYPE.CONTROL, (m) => rescanMessages.push(m));

  try {
    await sayHello({
      transport: rescanTransport,
      keyPair: rescanKeys,
      peerPublicKeyB64: listenerKeys.publicKeyB64,
      channelId,
      deviceId: "phone-1",
      senderName: "Phone",
      waitForAck: true,
      timeoutMs: 1000,
      retryMs: 20,
    });

    await waitFor(
      () => rescanMessages.find((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST),
      "project list on the re-scanned channel",
    );
    assert.deepEqual(warnings, [], "re-pairing the same phone must not warn about a different phone");
  } finally {
    // Always stop: a regression here leaves the listener holding its transport, and the test
    // runner then hangs on the open handles instead of reporting the failure.
    await listener.stop();
  }
});

test("a second different phone public key is ignored after first binding", async () => {
  const { createLocalTransport } = await import("@aasis21/weft-shared");
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

  // A live `/weft` session in this same (test) process registers itself as pending. Since it's
  // owned by process.pid, it reads as alive and eligible to be offered.
  const payload = { v: 1, channelId: "offer-1", pub: "PUB", transport: { kind: "local" } };
  registerPendingSession(
    { channelId: "offer-1", name: "web", cwd: "/repo/web", payload },
    { baseDir: connectionsHome },
  );

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

  // The phone adopts the offer → SESSION_CLAIMED removes it from the pending registry and the
  // listener re-broadcasts an (now empty) offer set.
  const offersSeen = messages.filter((m) => m.eventSubtype === SUBTYPE.CONTROL.SESSION_OFFERS).length;
  await phoneChannel.send(sessionClaimed("offer-1"));
  await waitFor(() => claimed.includes("offer-1"), "claim handled");
  assert.equal(
    readRegistry("pending-sessions.json", { baseDir: connectionsHome })?.["offer-1"],
    undefined,
    "claimed offer is removed from the pending registry",
  );
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
});

// --- mid-run transport rebind (devtunnel relay came back on a NEW url) -----------------------
// `weft start`'s relay watchdog calls listener.rebindTransport() so the station can re-pair
// inline instead of forcing the user to kill it and re-run. What matters here: the pairing
// identity survives (so the reprinted QR is the same channel/keys, only a new endpoint), the
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

test("rebindTransport drops the phone bound to the dead endpoint, then accepts a fresh pairing", async () => {
  const disconnects = [];
  const connects = [];
  const { listener, listenerKeys, channelId } = await pairedHarness({
    projects: [],
    transportDescriptor: { kind: "local", url: "wss://old.devtunnels.ms" },
    onDeviceConnected: () => connects.push("connected"),
    onDeviceDisconnected: () => disconnects.push("disconnected"),
  });
  assert.equal(connects.length, 1);

  await listener.rebindTransport({ kind: "local", url: "wss://new.devtunnels.ms" });
  // The old phone still holds the dead URL — report it gone instead of heartbeating into a void.
  assert.equal(disconnects.length, 1, "bound phone is reported disconnected");

  // A phone re-scanning the reprinted QR pairs again on the same channel/keys.
  const { createLocalTransport } = await import("@aasis21/weft-shared");
  const rescanTransport = createLocalTransport({ channelId });
  const rescanKeys = await generateKeyPair();
  const rescanChannel = new SecureChannel({
    transport: rescanTransport,
    key: await deriveSessionKey(rescanKeys.privateKey, listenerKeys.publicKeyB64),
    identity: { channelId, senderId: "phone2", senderName: "Phone 2" },
  });
  const seen = [];
  rescanChannel.onEvent(EVENT_TYPE.CONTROL, (m) => seen.push(m));
  await sayHello({
    transport: rescanTransport,
    keyPair: rescanKeys,
    peerPublicKeyB64: listenerKeys.publicKeyB64,
    channelId,
    deviceId: "phone-2",
    senderName: "Phone 2",
    waitForAck: true,
    timeoutMs: 1000,
    retryMs: 20,
  });
  await waitFor(() => seen.find((m) => m.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST), "project list after re-scan");
  assert.equal(connects.length, 2, "re-scanned phone binds as a new connection");
  await listener.stop();
});

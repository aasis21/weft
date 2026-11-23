// SPDX-License-Identifier: Apache-2.0
// sessionHost (dormant presence, transition queue, reload handover) + sessionLink (the phone link
// state machine), including acceptance tests A1 and A7 (LLD §9.1) through the real entry point.
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, join, resolve } from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import {
  EVENT_TYPE,
  SUBTYPE,
  SecureChannel,
  _resetLocalBus,
  createLocalTransport,
  generateKeyPair,
  linkReady,
  prompt,
  sayHello,
  sessionHealth,
  stateRequest,
} from "@aasis21/weft-shared";
import { startSessionHost } from "../src/sessionHost.mjs";
import { activationControllerDecision, backoffMs, createSessionLink, linkErrorCode } from "../src/sessionLink.mjs";
import { attachRelay as realAttachRelay } from "../src/relay.mjs";
import { createSessionStreamStore } from "../src/sessionStreamStore.mjs";
import { recordPath } from "../src/sessionRegistry.mjs";
import { createSessionControlClient } from "../src/sessionControl.mjs";

let home;
const previousHome = process.env.WEFT_HOME;
beforeEach(() => {
  _resetLocalBus();
  home = mkdtempSync(join(tmpdir(), "weft-session-host-"));
  process.env.WEFT_HOME = home;
});
afterEach(() => {
  _resetLocalBus();
  if (previousHome === undefined) delete process.env.WEFT_HOME;
  else process.env.WEFT_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

const waitFor = async (predicate, message = "condition", timeoutMs = 4_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`Timed out waiting for ${message}`);
};

function fakeSession(sessionId = "session-a") {
  const session = new EventEmitter();
  const sent = [];
  const logs = [];
  Object.assign(session, {
    sessionId,
    cwd: home,
    sent,
    logs,
    log(message, options) { logs.push({ message, options }); },
    send: async (options) => { sent.push(options); },
    rpc: {},
  });
  const on = session.on.bind(session);
  session.on = (name, handler) => {
    if (typeof name === "function") return () => {};
    on(name, handler);
    return () => session.off(name, handler);
  };
  return session;
}

function hostOptions({ session, scope, loadSessionLink, env = {}, ...rest }) {
  return {
    joinSession: async (config) => {
      session.config = config;
      return session;
    },
    scope,
    env,
    processTarget: rest.processTarget ?? new EventEmitter(),
    storePath: join(home, "session-store.db"),
    baseDir: home,
    recordOptions: { getStartTime: async () => 1_000 },
    loadSessionLink,
    ...rest,
  };
}

// ---- fake link: host behaviors ----------------------------------------------------------------

function fakeLinkLoader(calls) {
  return async (options) => {
    calls.loads.push(options);
    let generation = options.reloadIdentity?.linkGeneration ?? 0;
    let controllerRevision = options.reloadIdentity?.controllerRevision ?? 0;
    return {
      get generation() { return generation; },
      get controllerRevision() { return controllerRevision; },
      log: (event, fields) => calls.events.push([event, fields]),
      async activate(activation) {
        calls.ops.push(["activate", activation]);
        if (generation === 0) generation = 1;
        options.record.update({ link: { state: "connecting", generation } });
        return { state: "connecting", linkGeneration: generation, pairingPayload: { token: "t" }, controllerRevision };
      },
      async resetLink({ by }) {
        calls.ops.push(["resetLink", by]);
        generation += 1;
        options.record.update({ link: { state: "connecting", generation } });
        return { linkGeneration: generation };
      },
      async replaceController() {
        controllerRevision += 1;
        calls.ops.push(["replaceController", controllerRevision]);
        return { state: "connecting", controllerRevision };
      },
      async preparePairing(prepare) { calls.ops.push(["preparePairing", prepare]); return { state: "waiting" }; },
      status: () => ({ state: "connecting", linkGeneration: generation, controllerDeviceId: null }),
      traffic: () => ({ title: "t", entries: [] }),
      onPermissionRequest: () => ({ kind: "approved" }),
      discardHandoffIdentity() { calls.ops.push(["discardHandoffIdentity"]); return true; },
      async stop(stop) {
        calls.ops.push(["stop", stop]);
        if (calls.failStop) throw new Error("teardown failed");
        return stop.keepIdentity ? { channelId: "reload-channel", linkGeneration: generation, controllerRevision } : null;
      },
      grantWorkspaceAccess: async () => ({}),
    };
  };
}

function newCalls() {
  return { loads: [], ops: [], events: [] };
}

test("a dormant session publishes its record and pipe without loading the link, timers or output", async (t) => {
  const calls = newCalls();
  const session = fakeSession();
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  let timers = 0;
  globalThis.setTimeout = (...args) => { timers++; return originalSetTimeout(...args); };
  globalThis.setInterval = (...args) => { timers++; return originalSetInterval(...args); };
  let host;
  try {
    host = await startSessionHost(hostOptions({ session, scope: {}, loadSessionLink: fakeLinkLoader(calls) }));
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
  }
  t.after(() => host.close());
  assert.equal(calls.loads.length, 0);
  assert.equal(timers, 0);
  assert.equal(session.logs.length, 0);
  assert.equal(host.record.record.link.state, "dormant");
  assert.equal(session.config.commands[0].name, "weft");
  assert.deepEqual(await session.config.onPermissionRequest({}, {}), { kind: "user-not-available" });
  const probe = await createSessionControlClient(host.record.record, { baseDir: home }).command("probe");
  assert.equal(probe.runtimeId, host.runtimeId);
  assert.equal(probe.link.state, "dormant");
});

test("/weft activates in-process through the queue and shows the QR path without Station", async (t) => {
  const calls = newCalls();
  const session = fakeSession();
  const host = await startSessionHost(hostOptions({ session, scope: {}, loadSessionLink: fakeLinkLoader(calls) }));
  t.after(() => host.close());
  await session.config.commands[0].handler({ args: "supabase" });
  assert.equal(calls.loads.length, 1);
  assert.deepEqual(calls.ops[0], ["activate", { showQr: true, context: { args: "supabase" } }]);
  assert.ok(calls.events.some(([event, fields]) => event === "queue.transition" && fields.kind === "activate"));
});

test("Station commands go through the queue; resetLink and replaceController are fenced", async (t) => {
  const calls = newCalls();
  const session = fakeSession();
  const host = await startSessionHost(hostOptions({ session, scope: {}, loadSessionLink: fakeLinkLoader(calls) }));
  t.after(() => host.close());
  const client = createSessionControlClient(host.record.record, { baseDir: home });
  assert.deepEqual(await client.command("resetLink", { opId: "op-0", expectGeneration: 0 }), { result: "stale", generation: 0 },
    "a dormant session has no link to reset");
  const activated = await client.command("activate", { requestId: "open-1", requesterId: "phone-1" });
  assert.equal(activated.linkGeneration, 1);
  assert.deepEqual(await client.command("resetLink", { opId: "op-1", expectGeneration: 9 }), { result: "stale", generation: 1 });
  assert.deepEqual(await client.command("resetLink", { opId: "op-2", expectGeneration: 1 }), { result: "reset", generation: 2 });
  assert.deepEqual(await client.command("resetLink", { opId: "op-2", expectGeneration: 1 }), { result: "reset", generation: 2 },
    "a retried opId is answered from its first run, never reset twice");
  assert.equal(calls.ops.filter(([name]) => name === "resetLink").length, 1);
  await assert.rejects(client.command("replaceController", { opId: "take-1", expectControllerRevision: 5 }), (error) => error.code === "stale");
  assert.equal((await client.command("replaceController", { opId: "take-2", expectControllerRevision: 0 })).controllerRevision, 1);
  await assert.rejects(client.command("reloadExtension", { opId: "r-1" }), (error) => error.code === "unsupported");
});

test("reloadExtension asks the SDK to reload Weft when the host supports it", async (t) => {
  const calls = newCalls();
  const session = fakeSession();
  let reloads = 0;
  session.rpc.extensions = { reload: async () => { reloads += 1; } };
  const host = await startSessionHost(hostOptions({
    session, scope: {}, loadSessionLink: fakeLinkLoader(calls), setTimer: (fn) => { fn(); return 0; },
  }));
  t.after(() => host.close());
  const client = createSessionControlClient(host.record.record, { baseDir: home });
  assert.deepEqual(await client.command("reloadExtension", { opId: "r-1" }), { state: "reloading" });
  await waitFor(() => reloads === 1, "SDK reload");
});

test("a reload that waits for idle holds until the running turn ends and skips sessions that cannot report activity", async (t) => {
  const calls = newCalls();
  const session = fakeSession();
  let reloads = 0;
  let busy = true;
  session.rpc.extensions = { reload: async () => { reloads += 1; } };
  session.rpc.metadata = { activity: async () => ({ hasActiveWork: busy, abortable: busy }) };
  const timers = [];
  const host = await startSessionHost(hostOptions({
    session, scope: {}, loadSessionLink: fakeLinkLoader(calls), setTimer: (fn) => { timers.push(fn); return 0; },
  }));
  t.after(() => host.close());
  const client = createSessionControlClient(host.record.record, { baseDir: home });
  const runTimers = async () => { for (const fn of timers.splice(0)) await fn(); };

  assert.deepEqual(await client.command("reloadExtension", { opId: "w-1", whenIdle: true }), { state: "waiting-for-turn" });
  assert.deepEqual(await client.command("reloadExtension", { opId: "w-2", whenIdle: true }), { state: "waiting-for-turn" },
    "a second request joins the pending reload");
  await runTimers();
  await runTimers();
  assert.equal(reloads, 0, "the reload never cuts a running turn off");
  busy = false;
  await runTimers();
  await runTimers();
  assert.equal(reloads, 1, "the session reloads once the turn ends");

  const unknown = fakeSession("session-b");
  unknown.rpc.extensions = { reload: async () => { reloads += 1; } };
  const other = await startSessionHost(hostOptions({
    session: unknown, scope: {}, loadSessionLink: fakeLinkLoader(newCalls()), setTimer: (fn) => { fn(); return 0; },
  }));
  t.after(() => other.close());
  const otherClient = createSessionControlClient(other.record.record, { baseDir: home });
  assert.deepEqual(await otherClient.command("reloadExtension", { opId: "u-1", whenIdle: true }), { state: "activity-unknown" });
  assert.equal(reloads, 1);
});

test("a same-session reload keeps the runtime id and record, bumps its generation, and hands over the link identity", async (t) => {
  const scope = {};
  const calls = newCalls();
  const first = await startSessionHost(hostOptions({ session: fakeSession(), scope, loadSessionLink: fakeLinkLoader(calls) }));
  await first.activate({});
  const second = await startSessionHost(hostOptions({ session: fakeSession(), scope, loadSessionLink: fakeLinkLoader(calls) }));
  t.after(() => second.close());
  assert.equal(second.runtimeId, first.runtimeId);
  assert.equal(second.generation, first.generation + 1);
  assert.deepEqual(calls.ops.find(([name]) => name === "stop"), ["stop", { reason: "extension_reload", keepIdentity: true }]);
  assert.equal(calls.loads[1].reloadIdentity.channelId, "reload-channel");
  assert.equal(calls.loads[1].reloadIdentity.linkGeneration, 1, "link generations keep growing across reloads");
  assert.ok(existsSync(recordPath(first.runtimeId, { baseDir: home })), "the record never disappears during a reload");
  assert.equal(JSON.parse(readFileSync(recordPath(first.runtimeId, { baseDir: home }), "utf8")).run.generation, 2);
  await assert.rejects(first.activate({}), /ended/, "the retired host rejects new work");
});

test("/clear discards the handoff identity and the replacement session starts dormant", async () => {
  const scope = {};
  const calls = newCalls();
  const env = { WEFT_IDENTITY_FILE: join(home, "identity.json"), WEFT_CHANNEL_ID: "channel-a" };
  const session = fakeSession();
  await startSessionHost(hostOptions({ session, scope, env, identityFileExists: () => true, loadSessionLink: fakeLinkLoader(calls) }));
  assert.equal(env.WEFT_IDENTITY_FILE, undefined, "the handoff env is consumed");
  assert.ok(calls.ops.some(([name]) => name === "activate"), "a Station handoff activates on start");
  session.emit("session.shutdown", { data: { shutdownType: "clear" } });
  await waitFor(() => calls.ops.some(([name]) => name === "discardHandoffIdentity"), "discard");
  const replacementCalls = newCalls();
  const replacement = await startSessionHost(hostOptions({
    session: fakeSession("session-b"), scope, env, loadSessionLink: fakeLinkLoader(replacementCalls),
  }));
  assert.equal(replacementCalls.loads.length, 0);
  assert.equal(replacement.record.record.link.state, "dormant");
  await replacement.close();
});

test("a stale handoff environment after /clear stays dormant", async () => {
  const calls = newCalls();
  const host = await startSessionHost(hostOptions({
    session: fakeSession(), scope: {}, identityFileExists: () => false,
    env: { WEFT_IDENTITY_FILE: join(home, "removed.json"), WEFT_CHANNEL_ID: "stale" },
    loadSessionLink: fakeLinkLoader(calls),
  }));
  assert.equal(calls.loads.length, 0);
  assert.deepEqual(host.record.record.run.openedBy, { kind: "user", requestId: null });
  await host.close();
});

test("process exit removes the record synchronously; close removes it even when link teardown fails", async () => {
  const processTarget = new EventEmitter();
  const calls = newCalls();
  const host = await startSessionHost(hostOptions({ session: fakeSession(), scope: {}, processTarget, loadSessionLink: fakeLinkLoader(calls) }));
  processTarget.emit("exit");
  assert.ok(!existsSync(recordPath(host.runtimeId, { baseDir: home })));
  await host.close();

  const failing = newCalls();
  failing.failStop = true;
  const second = await startSessionHost(hostOptions({ session: fakeSession(), scope: {}, loadSessionLink: fakeLinkLoader(failing) }));
  await second.activate({});
  await assert.rejects(second.close(), /teardown failed/);
  assert.ok(!existsSync(recordPath(second.runtimeId, { baseDir: home })));
});

test("the dormant bundle excludes pairing crypto, QR, transport, relay and diagnostics modules", async () => {
  const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await build({
    entryPoints: [join(extensionRoot, "src", "extension.mjs")],
    bundle: true, write: false, metafile: true, platform: "node", target: "node20", format: "esm",
    external: ["@github/copilot-sdk/extension", "./sessionLink.mjs", "./pairingCanvas.mjs"],
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs).join("\n");
  for (const forbidden of ["qrcode", "@supabase/supabase-js", "transportFactory.mjs", "relay.mjs", "sessionLog.mjs", "reconnectingSocket.mjs", "shared/crypto.mjs"]) {
    assert.doesNotMatch(inputs, new RegExp(forbidden.replaceAll(".", "\\.")));
  }
  assert.match(result.outputFiles[0].text, /sessionLink\.mjs/);
});

// ---- pure link helpers ------------------------------------------------------------------------

test("controller decisions distinguish the current phone from a takeover requester", () => {
  assert.deepEqual(activationControllerDecision({}), { kind: "activate" });
  assert.deepEqual(activationControllerDecision({ controllerDeviceId: "a", requesterId: "a" }), { kind: "current-controller" });
  assert.deepEqual(activationControllerDecision({ controllerDeviceId: "a", requesterId: "b", controllerName: "A" }), { kind: "conflict", controllerName: "A" });
  assert.equal(activationControllerDecision({ controllerPublicKey: "pub", requesterId: "b" }).kind, "conflict");
});

test("backoff doubles from 1.5 s to 15 s and errors map to stable codes", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 9].map(backoffMs), [1_500, 3_000, 6_000, 12_000, 15_000, 15_000]);
  assert.equal(linkErrorCode(new Error("connect ECONNREFUSED 127.0.0.1")), "relay-unreachable");
  assert.equal(linkErrorCode(new Error("CHANNEL_ERROR on subscribe")), "subscribe-failed");
  assert.equal(linkErrorCode(Object.assign(new Error("x"), { code: "auth-failed" })), "auth-failed");
  assert.equal(linkErrorCode(new Error("401 Unauthorized")), "auth-failed");
});

// ---- real link through the host: acceptance --------------------------------------------------------

function transportFactory({ hangFirst = 0, failNext = () => false } = {}) {
  const created = [];
  const factory = (descriptor, { channelId }) => {
    const index = created.length;
    const acks = [];
    if (index < hangFirst) {
      // Never subscribes: connect() waits until the transport is closed, events never arrive.
      let reject;
      const pending = new Promise((_, r) => { reject = r; });
      const transport = {
        index, acks, hung: true, closed: false,
        subscribe: () => () => {},
        connect: () => pending,
        publish: async (event) => { acks.push(event); throw new Error("not subscribed"); },
        onStatus: () => () => {},
        close: async () => { transport.closed = true; reject(new Error("closed")); },
      };
      pending.catch(() => {});
      created.push(transport);
      return transport;
    }
    const local = createLocalTransport({ channelId });
    const fail = failNext(index);
    const transport = {
      ...local,
      index, acks, closed: false,
      connect: async () => {
        if (fail) throw new Error("connect ECONNREFUSED relay");
        return local.connect();
      },
      publish: async (event, envelope) => {
        if (event === EVENT_TYPE.PAIR) acks.push(envelope?.eventSubtype ?? "encrypted");
        return local.publish(event, envelope);
      },
      close: async () => { transport.closed = true; return local.close(); },
    };
    created.push(transport);
    return transport;
  };
  factory.created = created;
  return factory;
}

function linkDeps({ transports, events, scale = 1 }) {
  return {
    resolveTransport: async () => ({ kind: "local", channelId: "unused" }),
    createTransport: transports,
    attachRelay: async (options) => realAttachRelay({
      ...options,
      heartbeatMs: 10_000_000,
      streamStore: await createSessionStreamStore({ persist: false }),
    }),
    enableSessionLog: () => {},
    appendSessionLog: (event, fields) => events.push([event, fields]),
    stopDevTunnel: async () => {},
    isStationRunning: () => false,
    renderQr: async () => "[qr]",
    setTimeout: (fn, ms) => {
      const handle = setTimeout(fn, Math.max(0, Math.round(ms * scale)));
      handle.unref?.();
      return handle;
    },
  };
}

async function phoneConnect({ payload, keys, deviceId = "phone-1", replyLinkReady = true }) {
  const transport = createLocalTransport({ channelId: payload.channelId });
  const keyPair = keys ?? await generateKeyPair();
  const { key } = await sayHello({
    transport, keyPair, peerPublicKeyB64: payload.pub, channelId: payload.channelId,
    deviceId, senderName: "Phone", waitForAck: true, timeoutMs: 4_000, retryMs: 20, pairingToken: payload.token,
  });
  const channel = new SecureChannel({ transport, key, identity: { channelId: payload.channelId, senderId: "phone", senderName: "Phone" } });
  const control = [];
  channel.onEvent(EVENT_TYPE.CONTROL, (message) => {
    control.push(message);
    if (replyLinkReady && message.eventSubtype === SUBTYPE.CONTROL.LINK_READY) {
      // Local delivery is async, so a link_ready queued before cleanup can land after the phone
      // closed its transport; that reply has nowhere to go.
      channel.send(linkReady({ linkGeneration: message.msg.linkGeneration })).catch(() => {});
    }
  });
  // Like the app: its first message after the ACK; the session answers with link_ready at once.
  if (replyLinkReady) await channel.send(stateRequest());
  return { transport, keyPair, channel, control };
}

test("A1: six reloads in two seconds while the first five never subscribe end linked, and no retired instance ACKs or handles a prompt", async (t) => {
  const scope = {};
  const events = [];
  const transports = transportFactory({ hangFirst: 5 });
  const loadSessionLink = (options) => createSessionLink({ ...options, deps: linkDeps({ transports, events }) });
  const session = fakeSession();
  const startedAt = Date.now();
  let host = await startSessionHost(hostOptions({ session, scope, loadSessionLink }));
  await host.activate({});
  for (let reload = 0; reload < 5; reload += 1) {
    host = await startSessionHost(hostOptions({ session, scope, loadSessionLink }));
  }
  t.after(() => host.close());
  assert.ok(Date.now() - startedAt < 10_000);
  assert.equal(transports.created.length, 6, "exactly one transport per instance generation");
  assert.ok(transports.created.slice(0, 5).every((transport) => transport.closed), "every retired attempt was cancelled and closed");
  await waitFor(() => host.record.record.link.state === "waiting", "final instance subscribed");

  const status = host.link.status();
  const phone = await phoneConnect({ payload: status.pairingPayload });
  t.after(() => phone.transport.close());
  await waitFor(() => host.record.record.link.state === "linked", "link_ready exchange");
  const ready = phone.control.find((message) => message.eventSubtype === SUBTYPE.CONTROL.LINK_READY);
  assert.equal(ready.msg.linkGeneration, host.record.record.link.generation);
  assert.ok(host.record.record.link.generation >= 6, "every reload entered a new link generation");
  assert.deepEqual(transports.created.slice(0, 5).map((transport) => transport.acks.length), [0, 0, 0, 0, 0], "retired instances never ACK");
  assert.ok(transports.created[5].acks.length > 0);
  assert.equal(sessionHealth(host.record.record, { observer: "station", processAlive: true }, Date.now()).label, "linked");

  await phone.channel.send(prompt("hello from the phone"));
  await waitFor(() => session.sent.length === 1, "prompt delivered once");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(session.sent.length, 1, "no retired instance handled the prompt");
  assert.ok(events.some(([event]) => event === "link.ready"));
});

test("A7: with no Station, a relay blip is repaired by the session itself and every failure is logged", async (t) => {
  const events = [];
  let blipped = false;
  const transports = transportFactory({ failNext: (index) => blipped && index <= 3 });
  const session = fakeSession();
  const host = await startSessionHost(hostOptions({
    session, scope: {},
    loadSessionLink: (options) => createSessionLink({ ...options, deps: linkDeps({ transports, events, scale: 0.01 }) }),
  }));
  t.after(() => host.close());
  await host.activate({});
  await waitFor(() => host.record.record.link.state === "waiting", "subscribed");
  const phone = await phoneConnect({ payload: host.link.status().pairingPayload });
  t.after(() => phone.transport.close());
  await waitFor(() => host.record.record.link.state === "linked", "linked");
  const linkedGeneration = host.record.record.link.generation;

  blipped = true;
  await transports.created.at(-1).close();
  await waitFor(() => transports.created.length >= 5, "retries after the blip", 6_000);
  await waitFor(() => host.record.record.link.state === "waiting", "the session reconnected itself", 6_000);
  assert.ok(host.record.record.link.generation > linkedGeneration);
  const failures = events.filter(([event]) => event === "link.attempt_failed");
  assert.ok(failures.length >= 1, "failures are logged");
  assert.equal(failures[0][1].code, "relay-unreachable");
  assert.ok(events.some(([event, fields]) => event === "link.reset" && fields.by === "self"));
  assert.equal(host.record.record.link.lastError, null, "a recovered link clears its last error");

  // The already-trusted phone re-handshakes without a new code and the link is ready again.
  const again = await phoneConnect({ payload: { ...host.link.status().pairingPayload, token: "x".repeat(43) }, keys: phone.keyPair });
  t.after(() => again.transport.close());
  await waitFor(() => host.record.record.link.state === "linked", "re-linked");
});

test("a phone that talks but never answers link_ready is told to update and the link is refused", async (t) => {
  const events = [];
  const transports = transportFactory();
  const host = await startSessionHost(hostOptions({
    session: fakeSession(), scope: {},
    loadSessionLink: (options) => createSessionLink({ ...options, deps: linkDeps({ transports, events, scale: 0.02 }) }),
  }));
  t.after(() => host.close());
  await host.activate({});
  await waitFor(() => host.record.record.link.state === "waiting", "subscribed");
  const phone = await phoneConnect({ payload: host.link.status().pairingPayload, replyLinkReady: false });
  t.after(() => phone.transport.close());
  await phone.channel.send({ eventType: EVENT_TYPE.CONTROL, eventSubtype: SUBTYPE.CONTROL.STATE_REQUEST, msg: {}, ts: Date.now() });
  const notice = await waitFor(() => phone.control.find((message) => message.eventSubtype === SUBTYPE.CONTROL.UPDATE_REQUIRED), "update_required");
  assert.equal(notice.msg.side, "phone");
  assert.notEqual(host.record.record.link.state, "linked");
  assert.equal(host.record.record.link.lastError.code, "update-required");
});

test("a takeover bumps the controller revision, drops the old trust and needs a fresh grant", async (t) => {
  const events = [];
  const transports = transportFactory();
  const host = await startSessionHost(hostOptions({
    session: fakeSession(), scope: {},
    loadSessionLink: (options) => createSessionLink({ ...options, deps: linkDeps({ transports, events }) }),
  }));
  t.after(() => host.close());
  await host.activate({});
  await waitFor(() => host.record.record.link.state === "waiting", "subscribed");
  const first = await phoneConnect({ payload: host.link.status().pairingPayload, deviceId: "phone-a" });
  t.after(() => first.transport.close());
  await waitFor(() => host.record.record.link.state === "linked", "linked");
  const client = createSessionControlClient(host.record.record, { baseDir: home });
  const conflict = await client.command("activate", { requestId: "open-b", requesterId: "phone-b" });
  assert.equal(conflict.controllerConflict, true);
  const replaced = await client.command("replaceController", { opId: "take", expectControllerRevision: 0 });
  assert.equal(replaced.controllerRevision, 1);
  assert.equal(host.record.record.link.controllerRevision, 1);
  await waitFor(() => host.record.record.link.state === "waiting", "relinking for the new phone");
  const second = await phoneConnect({ payload: replaced.pairingPayload, deviceId: "phone-b" });
  t.after(() => second.transport.close());
  await waitFor(() => host.record.record.link.state === "linked", "new controller linked");
  assert.equal(host.link.status().controllerDeviceId, "phone-b");
});

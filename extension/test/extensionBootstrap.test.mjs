// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { startExtensionBootstrap } from "../src/extensionBootstrap.mjs";

function createHarness({
  sessionId = "session-a",
  env = {},
  scope = {},
  identityFileExists = () => true,
} = {}) {
  const processTarget = new EventEmitter();
  const calls = {
    configs: [],
    handlers: null,
    presence: [],
    activeLoads: [],
    activeCalls: [],
    hostCloses: 0,
    presenceWithdrawals: 0,
    logs: [],
    shutdownHandler: null,
  };
  const session = {
    sessionId,
    log(message, options) {
      calls.logs.push({ message, options });
    },
    on(name, handler) {
      if (name === "session.shutdown") calls.shutdownHandler = handler;
    },
  };
  const activeRuntime = {
    async activate(options) {
      calls.activeCalls.push(["activate", options]);
      return { state: "pairing-ready", pairingPayload: { token: "token" } };
    },
    async showPairing(context) {
      calls.activeCalls.push(["showPairing", context]);
    },
    async preparePairing(options) {
      calls.activeCalls.push(["preparePairing", options]);
      return { state: "pairing-ready", pairingPayload: { token: "token" } };
    },
    status() {
      return { state: "active" };
    },
    async replaceController(payload) {
      calls.activeCalls.push(["replaceController", payload]);
      return { state: "pairing-ready" };
    },
    async quiesce(reason) {
      calls.activeCalls.push(["quiesce", reason]);
    },
    async shutdown(reason, options) {
      calls.activeCalls.push(["shutdown", reason, options]);
    },
    getReloadIdentity() {
      calls.activeCalls.push(["getReloadIdentity"]);
      return { channelId: "reload-channel", laptopKeys: { publicKeyB64: "public" } };
    },
    onPermissionRequest() {
      return { kind: "approved" };
    },
    discardHandoffIdentity() {
      calls.activeCalls.push(["discardHandoffIdentity"]);
      return true;
    },
  };
  return {
    calls,
    session,
    env,
    scope,
    identityFileExists,
    processTarget,
    joinSession: async (config) => {
      calls.configs.push(config);
      return session;
    },
    startLifecycleHost: async ({ handlers, state = "dormant" }) => {
      calls.handlers = handlers;
      calls.presence.push(state);
      return {
        updatePresence({ state: next }) {
          calls.presence.push(next);
        },
        withdrawPresence() {
          calls.presenceWithdrawals++;
        },
        async close() {
          calls.hostCloses++;
        },
      };
    },
    loadActiveRuntime: async (options) => {
      calls.activeLoads.push(options);
      return activeRuntime;
    },
  };
}

test("dormant bootstrap registers locally without active imports, output, or timers", async (t) => {
  const harness = createHarness();
  const originalWrite = process.stderr.write;
  const originalSetTimeout = globalThis.setTimeout;
  const originalSetInterval = globalThis.setInterval;
  let stderrWrites = 0;
  let timers = 0;
  process.stderr.write = () => {
    stderrWrites++;
    return true;
  };
  globalThis.setTimeout = (...args) => {
    timers++;
    return originalSetTimeout(...args);
  };
  globalThis.setInterval = (...args) => {
    timers++;
    return originalSetInterval(...args);
  };
  t.after(() => {
    process.stderr.write = originalWrite;
    globalThis.setTimeout = originalSetTimeout;
    globalThis.setInterval = originalSetInterval;
  });

  const bootstrap = await startExtensionBootstrap(harness);
  assert.equal(harness.calls.activeLoads.length, 0);
  assert.deepEqual(harness.calls.presence, ["dormant"]);
  assert.equal(harness.calls.logs.length, 0);
  assert.equal(stderrWrites, 0);
  assert.equal(timers, 0);
  assert.equal(harness.calls.configs[0].commands[0].name, "weft");
  assert.deepEqual(
    await harness.calls.configs[0].onPermissionRequest({}, {}),
    { kind: "user-not-available" },
  );
  await bootstrap.close();
});

test("direct /weft activates in-process and shows a QR path without Station", async () => {
  const harness = createHarness();
  const bootstrap = await startExtensionBootstrap(harness);
  await harness.calls.configs[0].commands[0].handler({ args: "supabase" });
  assert.equal(harness.calls.activeLoads.length, 1);
  assert.deepEqual(harness.calls.activeCalls[0], [
    "activate",
    { reason: "command", context: { args: "supabase" }, showQr: true },
  ]);
  assert.deepEqual(harness.calls.presence, ["dormant", "activating", "active"]);
  await bootstrap.close();
});

test("app pairing is lazy, uses a canvas, and closes only its panel", async () => {
  const harness = createHarness();
  harness.session.capabilities = { ui: { canvases: true } };
  const opens = [];
  harness.session.rpc = { canvas: { open: async (input) => opens.push(input) } };
  let loads = 0;
  let closes = 0;
  const bootstrap = await startExtensionBootstrap({
    ...harness,
    createCanvas: (definition) => definition,
    loadPairingCanvas: async () => {
      loads++;
      return {
        url: "http://127.0.0.1:1234/panel/",
        getTitle: async () => "Weft | Phone companion",
        close: async () => { closes++; }, setError() {},
      };
    },
  });
  assert.equal(loads, 0);
  await harness.calls.configs[0].tools[0].handler({});
  assert.equal(loads, 0, "the renderer remains lazy until the runtime opens the panel");
  assert.equal(opens[0].canvasId, "weft-pairing");
  const canvas = harness.calls.configs[0].canvases[0];
  const opened = await canvas.open({ instanceId: "panel", input: {} });
  assert.equal(opened.title, "Weft | Phone companion");
  await canvas.open({ instanceId: "panel", input: {} });
  assert.equal(loads, 1);
  assert.equal(harness.calls.activeLoads.length, 1);
  assert.equal(harness.calls.activeCalls.filter(([name]) => name === "showPairing").length, 0);
  assert.deepEqual(await canvas.actions[0].handler(), { state: "active" });
  await canvas.onClose({ instanceId: "panel" });
  assert.equal(closes, 1);
  assert.equal(harness.calls.activeCalls.filter(([name]) => name === "shutdown").length, 0);
  await bootstrap.close();
});

test("older SDKs and CLI hosts keep a terminal pairing path", async () => {
  const harness = createHarness();
  const bootstrap = await startExtensionBootstrap(harness);
  assert.equal(harness.calls.configs[0].canvases, undefined);
  const result = await harness.calls.configs[0].tools[0].handler({ transport: "supabase" });
  assert.match(result, /CLI/);
  assert.deepEqual(harness.calls.activeCalls[0], [
    "activate", { reason: "command", context: { args: "supabase" }, showQr: true },
  ]);
  await bootstrap.close();
});

test("/weft uses the app canvas and focuses a panel that was opened manually", async () => {
  const harness = createHarness();
  harness.session.capabilities = { ui: { canvases: true } };
  const opens = [];
  harness.session.rpc = { canvas: { open: async (input) => opens.push(input) } };
  const bootstrap = await startExtensionBootstrap({
    ...harness,
    createCanvas: (definition) => definition,
    loadPairingCanvas: async () => ({
      url: "http://127.0.0.1:1234/panel/",
      getTitle: async () => "Weft | Phone companion",
      close: async () => {}, setError() {},
    }),
  });
  const canvas = harness.calls.configs[0].canvases[0];
  await canvas.open({ instanceId: "manual-weft-panel", input: {} });
  await harness.calls.configs[0].commands[0].handler({ args: "" });
  assert.deepEqual(opens[0], {
    canvasId: "weft-pairing", instanceId: "manual-weft-panel", input: {},
  });
  await harness.calls.configs[0].commands[0].handler({ args: " supabase " });
  assert.equal(opens[1].instanceId, "manual-weft-panel");
  assert.deepEqual(opens[1].input, { transport: "supabase" });
  assert.ok(harness.calls.activeCalls.some(([name, options]) =>
    name === "preparePairing" && options.transport === "supabase"));
  assert.equal(harness.calls.activeCalls.filter(([name, options]) =>
    name === "activate" && options.showQr === true).length, 0);
  await bootstrap.close();
});

test("Station activation reads the current runtime instead of replaying an old pairing result", async () => {
  const harness = createHarness();
  const bootstrap = await startExtensionBootstrap(harness);
  const first = await harness.calls.handlers.activate({ requesterId: "phone-a" });
  bootstrap.activeRuntime.activate = async () => ({
    state: "controller-conflict", controllerConflict: true,
  });
  const second = await harness.calls.handlers.activate({ requesterId: "phone-b" });
  assert.equal(first.state, "pairing-ready");
  assert.equal(second.controllerConflict, true);
  assert.equal(harness.calls.activeLoads.length, 1);
  await bootstrap.close();
});

test("Station activation and explicit launch handoff use the same lazy runtime", async () => {
  const station = createHarness();
  const stationBootstrap = await startExtensionBootstrap(station);
  const result = await station.calls.handlers.activate({ operationId: "operation-a" });
  assert.equal(result.state, "pairing-ready");
  assert.deepEqual(station.calls.activeCalls[0], [
    "activate",
    { reason: "station", context: { operationId: "operation-a" }, showQr: false },
  ]);
  await stationBootstrap.close();

  const handoff = createHarness({
    env: {
      WEFT_IDENTITY_FILE: "identity.json",
      WEFT_CHANNEL_ID: "channel-a",
    },
  });
  const handoffBootstrap = await startExtensionBootstrap(handoff);
  assert.equal(handoff.env.WEFT_IDENTITY_FILE, undefined);
  assert.equal(handoff.env.WEFT_CHANNEL_ID, undefined);
  assert.deepEqual(handoff.calls.activeCalls[0], [
    "activate",
    { reason: "handoff", context: null, showQr: false },
  ]);
  await handoffBootstrap.close();
});

test("same-session reload transfers active identity and fences the prior lifecycle host", async () => {
  const scope = {};
  const first = createHarness({ scope });
  const firstBootstrap = await startExtensionBootstrap(first);
  await first.calls.configs[0].commands[0].handler({ args: "" });

  const second = createHarness({ scope });
  const secondBootstrap = await startExtensionBootstrap(second);
  assert.equal(first.calls.hostCloses, 1);
  assert.deepEqual(first.calls.activeCalls.slice(-2), [
    ["getReloadIdentity"],
    ["shutdown", "extension_reload", { preserveIdentity: true }],
  ]);
  assert.equal(second.calls.activeLoads[0].reloadIdentity.channelId, "reload-channel");
  assert.deepEqual(second.calls.activeCalls[0], [
    "activate",
    { reason: "reload", context: null, showQr: false },
  ]);
  await secondBootstrap.close();
  await firstBootstrap.close();
});

test("/clear discards active identity and the replacement session starts dormant", async () => {
  const scope = {};
  const env = {
    WEFT_IDENTITY_FILE: "identity.json",
    WEFT_CHANNEL_ID: "channel-a",
  };
  const first = createHarness({ scope, env });
  await startExtensionBootstrap(first);
  first.calls.shutdownHandler({ data: { shutdownType: "clear" } });
  await new Promise((resolveImmediate) => setImmediate(resolveImmediate));
  assert.ok(first.calls.activeCalls.some(([name]) => name === "discardHandoffIdentity"));

  const second = createHarness({ sessionId: "session-b", scope, env });
  const secondBootstrap = await startExtensionBootstrap(second);
  assert.equal(second.calls.activeLoads.length, 0);
  assert.deepEqual(second.calls.presence, ["dormant"]);
  await secondBootstrap.close();
});

test("/clear stays dormant when Copilot reuses stale handoff environment in a new process", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "weft-cleared-handoff-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const harness = createHarness({
    identityFileExists: () => false,
    env: {
      WEFT_IDENTITY_FILE: join(dir, "removed-identity.json"),
      WEFT_CHANNEL_ID: "stale-channel",
    },
  });

  const bootstrap = await startExtensionBootstrap(harness);
  assert.equal(harness.calls.activeLoads.length, 0);
  assert.deepEqual(harness.calls.presence, ["dormant"]);
  await bootstrap.close();
});

test("process exit synchronously withdraws presence", async () => {
  const harness = createHarness();
  await startExtensionBootstrap(harness);
  harness.processTarget.emit("exit");
  assert.equal(harness.calls.presenceWithdrawals, 1);
});

test("shutdown withdraws presence and closes the host even when active teardown fails", async () => {
  const harness = createHarness();
  const bootstrap = await startExtensionBootstrap(harness);
  await harness.calls.configs[0].commands[0].handler({ args: "" });
  harness.calls.activeLoads[0];
  const runtime = bootstrap.activeRuntime;
  runtime.shutdown = async () => {
    throw new Error("teardown failed");
  };

  await assert.rejects(bootstrap.close(), /teardown failed/);
  assert.equal(harness.calls.presenceWithdrawals, 1);
  assert.equal(harness.calls.hostCloses, 1);
});

test("the dormant bundle excludes pairing crypto, QR, transport, relay, and diagnostics modules", async () => {
  const extensionRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await build({
    entryPoints: [join(extensionRoot, "src", "extension.mjs")],
    bundle: true,
    write: false,
    metafile: true,
    platform: "node",
    target: "node20",
    format: "esm",
    external: ["@github/copilot-sdk/extension", "./activeRuntime.mjs", "./pairingCanvas.mjs"],
    logLevel: "silent",
  });
  const inputs = Object.keys(result.metafile.inputs).join("\n");
  for (const forbidden of [
    "qrcode",
    "@supabase/supabase-js",
    "transportFactory.mjs",
    "relay.mjs",
    "sessionLog.mjs",
    "reconnectingSocket.mjs",
  ]) {
    assert.doesNotMatch(inputs, new RegExp(forbidden.replaceAll(".", "\\.")));
  }
  const output = result.outputFiles[0].text;
  assert.match(output, /activeRuntime\.mjs/);
});

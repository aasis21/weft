// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { generateKeyPair } from "@aasis21/weft-shared";
import {
  activationControllerDecision,
  isAuthenticatedTakeoverConfirmation,
} from "../src/activeRuntime.mjs";

test("activation distinguishes the current phone from a takeover requester", () => {
  assert.deepEqual(
    activationControllerDecision({
      controllerDeviceId: "phone-a",
      controllerPublicKey: "pub-a",
      requesterId: "phone-a",
    }),
    { kind: "current-controller" },
  );
  assert.deepEqual(
    activationControllerDecision({
      controllerDeviceId: "phone-a",
      controllerPublicKey: "pub-a",
      requesterId: "phone-b",
      controllerName: "Ashish's phone",
    }),
    { kind: "conflict", controllerName: "Ashish's phone" },
  );
  assert.deepEqual(
    activationControllerDecision({
      controllerPublicKey: "legacy-pub",
      requesterId: "phone-a",
    }),
    { kind: "conflict", controllerName: null },
  );
  assert.deepEqual(
    activationControllerDecision({ requesterId: "phone-a" }),
    { kind: "activate" },
  );
});

test("controller rotation requires the operation-bound confirmed takeover fields", () => {
  assert.equal(isAuthenticatedTakeoverConfirmation({
    operationId: "takeover-a",
    requesterId: "phone-b",
    challengeId: "challenge-a",
    expectedRevision: 4,
  }), true);
  assert.equal(isAuthenticatedTakeoverConfirmation({
    operationId: "takeover-a",
    requesterId: "phone-b",
    expectedRevision: 4,
  }), false);
  assert.equal(isAuthenticatedTakeoverConfirmation({
    operationId: "takeover-a",
    requesterId: "phone-b",
    challengeId: "challenge-a",
    expectedRevision: -1,
  }), false);
});

test("opening app pairing preserves a trusted phone; confirmed refresh revokes its controller", async (t) => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const dir = mkdtempSync(join(tmpdir(), "weft-pairing-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mocks = {
    "./transportFactory.mjs": `
      import { createLocalTransport } from "@aasis21/weft-shared";
      export const SUPPORTED_TRANSPORT_NAMES = ["supabase"];
      export const resolveTransport = async () => ({ kind: "local" });
      export const resolveTransportByName = () => ({ kind: "supabase" });
      export const createTransportFromDescriptor = (_descriptor, options) => createLocalTransport(options);
    `,
    "./devtunnel.mjs": `
      export const resolveDevTunnelTransport = async () => ({ kind: "devtunnel" });
      export const stopDevTunnel = async () => {};
    `,
    "./sessionLog.mjs": `
      export const enableSessionLog = () => {};
      export const appendSessionLog = () => {};
    `,
    "./pendingSessions.mjs": `
      export const isStationRunning = () => false;
      export const registerPendingSession = () => {};
      export const removePendingSession = () => {};
    `,
  };
  const outfile = join(dir, "active.mjs");
  await build({
    entryPoints: [join(root, "src", "activeRuntime.mjs")],
    outfile, bundle: true, platform: "node", format: "esm", logLevel: "silent",
    banner: { js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);" },
    plugins: [{
      name: "isolated-pairing-runtime",
      setup(plugin) {
        plugin.onResolve({ filter: /\.mjs$/ }, ({ path }) =>
          mocks[path] ? { path, namespace: "mock" } : null);
        plugin.onLoad({ filter: /.*/, namespace: "mock" }, ({ path }) => ({
          contents: mocks[path], resolveDir: root, loader: "js",
        }));
      },
    }],
  });
  const { createActiveRuntime } = await import(pathToFileURL(outfile));
  const laptopKeys = await generateKeyPair();
  const phoneKeys = await generateKeyPair();
  const runtime = await createActiveRuntime({
    session: { sessionId: "synthetic-app", log() {} },
    reloadIdentity: {
      laptopKeys, channelId: "synthetic-pairing-channel",
      trustedPeerPublicKeyB64: phoneKeys.publicKeyB64,
      controllerDeviceId: "original-phone", controllerName: "Original phone",
    },
  });
  t.after(() => runtime.shutdown("test"));
  const original = runtime.status().pairingPayload.token;
  await runtime.preparePairing({});
  assert.equal(runtime.status().paired, true);
  assert.equal(runtime.status().pairingPayload.token, original);
  await assert.rejects(runtime.preparePairing({ transport: "devtunnel" }), /confirm/);
  assert.equal(runtime.status().pairingPayload.token, original);
  await runtime.preparePairing({ refresh: true });
  assert.equal(runtime.status().paired, false);
  assert.notEqual(runtime.status().pairingPayload.token, original);
  const activated = await runtime.activate({ context: { requesterId: "new-phone" } });
  assert.notEqual(activated.state, "controller-conflict");
});

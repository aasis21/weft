// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { createPairingCanvasServer, readCanvasSessionDetails } from "../src/pairingCanvas.mjs";

async function harness(t, overrides = {}) {
  let current = {
    state: "pairing-ready",
    pairingPayload: { channelId: "test-channel", token: "test-grant", expiresAt: Date.now() + 60_000,
      transport: { kind: "local" } },
  };
  const calls = [];
  const server = await createPairingCanvasServer({
    status: () => current,
    preparePairing: async (options) => { calls.push(options); },
    ...overrides,
  });
  t.after(() => server.close());
  const origin = new URL(server.url).origin;
  return {
    ...server, calls, origin,
    setStatus(value) { current = value; },
    state: async () => (await fetch(new URL("state", server.url))).json(),
    pair: (body, headers = {}) => fetch(new URL("pair", server.url), {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  };
}

test("canvas serves a graphical QR and exact copy code only to its private route", async (t) => {
  const h = await harness(t);
  const page = await fetch(h.url);
  const html = await page.text();
  assert.match(html, /Copy pairing code/);
  assert.match(html, /<dt>Session ID<\/dt><dd id="session-id"/);
  assert.match(html, /<dt>Started<\/dt><dd id="started"/);
  assert.doesNotMatch(html, /<details\b|<summary\b/);
  assert.doesNotMatch(html, /test-grant/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const state = await h.state();
  assert.match(state.qr, /^data:image\/png;base64,/);
  assert.equal(JSON.parse(state.code).token, "test-grant");
  assert.equal((await fetch(h.origin)).status, 404);
});

test("the panel title identifies the session and falls back when it has no name", async (t) => {
  const named = await harness(t, {
    session: {
      rpc: { name: { get: async () => ({ name: "Canvas improvements" }) } },
    },
  });
  assert.equal(await named.getTitle(), "Weft | Canvas improvements");
  const unnamed = await harness(t);
  assert.equal(await unnamed.getTitle(), "Weft | Continue on your phone");
});

test("connected and expired states never expose an unusable grant", async (t) => {
  const h = await harness(t);
  h.setStatus({ state: "active", pairingPayload: { token: "claimed" } });
  assert.equal((await h.state()).code, null);
  assert.equal((await h.state()).qr, null);
  h.setStatus({ state: "pairing-ready", paired: true, pairingPayload: { token: "claimed", expiresAt: 1 } });
  const reconnecting = await h.state();
  assert.equal(reconnecting.paired, true);
  assert.equal(reconnecting.code, null);
  assert.equal((await h.pair({ confirm: false })).status, 400);
  h.setStatus({ state: "pairing-ready", pairingPayload: { expiresAt: 1, token: "expired" } });
  const state = await h.state();
  assert.equal(state.expired, true);
  assert.equal(state.code, null);
});

test("only same-origin confirmed actions may replace a connected phone", async (t) => {
  const h = await harness(t);
  h.setStatus({ state: "active" });
  assert.equal((await h.pair({ confirm: false })).status, 400);
  assert.equal((await h.pair({ confirm: true }, { Origin: "https://example.com" })).status, 403);
  assert.equal((await h.pair({ confirm: true }, { "Content-Type": "text/plain" })).status, 403);
  assert.equal(h.calls.length, 0);
  assert.equal((await h.pair({ confirm: true, transport: "devtunnel" })).status, 200);
  assert.deepEqual(h.calls, [{ transport: "devtunnel", refresh: true }]);
});

test("transport validation and setup failures are explicit and recoverable", async (t) => {
  const h = await harness(t, {
    preparePairing: async () => { throw new Error("Start weft devtunnel start first."); },
  });
  h.setError("No transport configured.");
  assert.equal((await h.state()).error, "No transport configured.");
  assert.equal((await h.pair({ transport: "unknown" })).status, 400);
  const failed = await h.pair({ transport: "devtunnel" });
  assert.equal(failed.status, 400);
  assert.match((await failed.json()).error, /devtunnel start/);
});

test("session details use live metadata with a saved branch and never copy arbitrary runtime data", async () => {
    const details = await readCanvasSessionDetails({
      sessionId: "session-test",
      rpc: {
        name: { get: async () => ({ name: "App compatibility" }) },
        metadata: {
          snapshot: async () => ({
            summary: "Fallback title", workingDirectory: "C:\\repos\\axon",
            currentMode: "interactive", selectedModel: "fallback-model",
            startTime: "2026-10-10T20:00:00Z",
            providerConfig: { apiKey: "do-not-expose" },
          }),
          activity: async () => ({ hasActiveWork: true, abortable: true }),
        },
        model: { getCurrent: async () => ({ modelId: "gpt-test", reasoningEffort: "high" }) },
      },
    }, async () => ({ title: "Saved title", branch: "main", cwd: "C:\\old" }));
    assert.equal(details.title, "App compatibility");
    assert.equal(details.cwd, "C:\\repos\\axon");
    assert.equal(details.branch, "main");
    assert.equal(details.model, "gpt-test");
    assert.equal(details.busy, true);
    assert.equal(details.mode, "interactive");
    assert.doesNotMatch(JSON.stringify(details), /do-not-expose|providerConfig/);
});

test("missing live details fall back explicitly without pretending the session is idle", async () => {
    const details = await readCanvasSessionDetails({
      sessionId: "session-test",
      rpc: { metadata: { snapshot: async () => { throw new Error("private transport details"); } } },
    }, async () => ({ title: "Saved title", branch: "saved", cwd: "C:\\saved" }));
    assert.equal(details.title, "Saved title");
    assert.equal(details.busy, null);
    assert.equal(details.cwd, "C:\\saved");
    assert.match(details.warning, /unavailable/);
    assert.doesNotMatch(details.warning, /private transport/);
});

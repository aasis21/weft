// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { createPairingCanvasServer } from "../src/pairingCanvas.mjs";

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
  assert.doesNotMatch(html, /test-grant/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  const state = await h.state();
  assert.match(state.qr, /^data:image\/png;base64,/);
  assert.equal(JSON.parse(state.code).token, "test-grant");
  assert.equal((await fetch(h.origin)).status, 404);
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

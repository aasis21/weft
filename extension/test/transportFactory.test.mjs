// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTransportDescriptor, resolveTransportByName, resolveTransport, SUPPORTED_TRANSPORT_NAMES } from "../src/transportFactory.mjs";
import { saveTransportConfig } from "../src/transportConfig.mjs";

let weftHome;

beforeEach(() => {
  weftHome = mkdtempSync(join(tmpdir(), "weft-home-"));
});

afterEach(() => {
  rmSync(weftHome, { recursive: true, force: true });
});

test("throws an actionable error when nothing is configured", () => {
  assert.throws(() => resolveTransportDescriptor({ baseDir: weftHome }), /weft set-transport/);
});

test("resolves whatever was persisted via `weft set-transport` (config file is the only source)", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportDescriptor({ baseDir: weftHome }), { kind: "local" });
});

test("a persisted devtunnel choice is stored as a bare marker (url is provisioned later per channel)", () => {
  saveTransportConfig({ kind: "devtunnel" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportDescriptor({ baseDir: weftHome }), { kind: "devtunnel" });
});

test("a persisted supabase choice resolves exactly as saved", () => {
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportDescriptor({ baseDir: weftHome }), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("resolveTransportByName only offers the user-facing transports (supabase)", () => {
  assert.deepEqual(SUPPORTED_TRANSPORT_NAMES, ["supabase"]);
});

test("resolveTransportByName resolves supabase from the persisted config", () => {
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportByName("supabase", { baseDir: weftHome }), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("resolveTransportByName is case-insensitive and trims whitespace", () => {
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportByName("  SUPABASE ", { baseDir: weftHome }), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("resolveTransportByName throws an actionable error when supabase isn't configured yet", () => {
  assert.throws(() => resolveTransportByName("supabase", { baseDir: weftHome }), /weft set-transport supabase/);
});

test("resolveTransportByName throws if the persisted config is a different kind", () => {
  saveTransportConfig({ kind: "devtunnel" }, { baseDir: weftHome });
  assert.throws(() => resolveTransportByName("supabase", { baseDir: weftHome }), /weft set-transport supabase/);
});

test("resolveTransportByName rejects local/devtunnel — hidden from this user-facing path", () => {
  for (const hidden of ["local", "devtunnel", "bluetooth"]) {
    assert.throws(() => resolveTransportByName(hidden, { baseDir: weftHome }), (err) => {
      assert.match(err.message, new RegExp(`unknown transport "${hidden}"`));
      for (const name of SUPPORTED_TRANSPORT_NAMES) assert.match(err.message, new RegExp(name));
      return true;
    });
  }
});

test("resolveTransport passes non-devtunnel descriptors through unchanged", async () => {
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  const descriptor = await resolveTransport({ baseDir: weftHome });
  assert.deepEqual(descriptor, { kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" });
});

test("resolveTransport routes a persisted devtunnel marker into resolveDevTunnelTransport (throws with `weft devtunnel start` hint when no relay is running)", async () => {
  // Symmetric with the Supabase transport: pairing never spawns the "server". If the user hasn't
  // brought the shared relay up via `weft devtunnel start`, this must fail fast with an actionable
  // message rather than hang, retry, or try to invoke the devtunnel CLI. The full spawn/reuse
  // behavior lives in ensureDevTunnelRelay and is covered by devtunnel.test.mjs.
  saveTransportConfig({ kind: "devtunnel" }, { baseDir: weftHome });
  await assert.rejects(
    resolveTransport({ baseDir: weftHome }),
    /weft devtunnel start/,
  );
});

// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTransportDescriptor, resolveTransportByName, resolveTransport, SUPPORTED_TRANSPORT_NAMES } from "../src/transportFactory.mjs";
import { saveTransportConfig, saveSupabaseCredentials, supabaseCredentialsPath } from "../src/transportConfig.mjs";

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

test("a persisted supabase choice hydrates url + anonKey from ~/.weft/supabase.json", () => {
  // The pointer file records only `{kind: "supabase"}`; the resolver reads the sibling
  // supabase.json (written by the installer or `weft set-transport supabase --url X --anon-key Y`)
  // and merges it in. This is what gets stamped into the pairing QR.
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportDescriptor({ baseDir: weftHome }), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("a persisted supabase pointer with no supabase.json throws a hard error naming the file", () => {
  // Deliberately no saveSupabaseCredentials call. `weft set-transport supabase` (no flags) is
  // legitimate as long as the file already exists (installer-seeded); if it doesn't, we don't
  // silently fall back to anything — we say what's missing and where.
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  const expectedPath = supabaseCredentialsPath({ baseDir: weftHome });
  assert.throws(() => resolveTransportDescriptor({ baseDir: weftHome }), (err) => {
    assert.match(err.message, /supabase credentials file not found/);
    assert.ok(err.message.includes(expectedPath), `error should include ${expectedPath}`);
    return true;
  });
});

test("resolveTransportByName only offers the user-facing transports (supabase)", () => {
  assert.deepEqual(SUPPORTED_TRANSPORT_NAMES, ["supabase"]);
});

test("resolveTransportByName resolves supabase from the persisted config", () => {
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportByName("supabase", { baseDir: weftHome }), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("resolveTransportByName is case-insensitive and trims whitespace", () => {
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
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
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
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

// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTransportDescriptor, resolveTransportByName, SUPPORTED_TRANSPORT_NAMES } from "../src/transportFactory.mjs";
import { saveTransportConfig } from "../src/transportConfig.mjs";

const ENV_KEYS = [
  "HELM_TRANSPORT",
  "HELM_SUPABASE_URL",
  "HELM_SUPABASE_ANON_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "HELM_WEBPUBSUB_NEGOTIATE_URL",
];

let helmHome;
let savedEnv;

beforeEach(() => {
  helmHome = mkdtempSync(join(tmpdir(), "helm-home-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  rmSync(helmHome, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("defaults to supabase when nothing is configured and supabase env vars are present", () => {
  process.env.HELM_SUPABASE_URL = "https://default.supabase.co";
  process.env.HELM_SUPABASE_ANON_KEY = "default-anon";
  assert.deepEqual(resolveTransportDescriptor({ baseDir: helmHome }), {
    kind: "supabase",
    url: "https://default.supabase.co",
    anonKey: "default-anon",
  });
});

test("throws an actionable error when nothing is configured and no supabase env vars exist", () => {
  assert.throws(() => resolveTransportDescriptor({ baseDir: helmHome }), /helm-cli set-transport/);
});

test("a persisted `helm-cli set-transport` choice wins over the supabase default", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: helmHome });
  assert.deepEqual(resolveTransportDescriptor({ baseDir: helmHome }), { kind: "local" });
});

test("HELM_TRANSPORT env var wins over a persisted config", () => {
  saveTransportConfig({ kind: "webpubsub", negotiateUrl: "https://stale.example" }, { baseDir: helmHome });
  process.env.HELM_TRANSPORT = "local";
  assert.deepEqual(resolveTransportDescriptor({ baseDir: helmHome }), { kind: "local" });
});

test("HELM_TRANSPORT=webpubsub requires HELM_WEBPUBSUB_NEGOTIATE_URL", () => {
  process.env.HELM_TRANSPORT = "webpubsub";
  assert.throws(() => resolveTransportDescriptor({ baseDir: helmHome }), /HELM_WEBPUBSUB_NEGOTIATE_URL/);
});

test("resolveTransportByName resolves a valid name regardless of persisted config/env", () => {
  saveTransportConfig({ kind: "webpubsub", negotiateUrl: "https://stale.example" }, { baseDir: helmHome });
  assert.deepEqual(resolveTransportByName("local"), { kind: "local" });
});

test("resolveTransportByName is case-insensitive and trims whitespace", () => {
  assert.deepEqual(resolveTransportByName("  LOCAL "), { kind: "local" });
});

test("resolveTransportByName rejects an unknown name with the supported list", () => {
  assert.throws(() => resolveTransportByName("bluetooth"), (err) => {
    assert.match(err.message, /unknown transport "bluetooth"/);
    for (const name of SUPPORTED_TRANSPORT_NAMES) assert.match(err.message, new RegExp(name));
    return true;
  });
});

test("resolveTransportByName surfaces the same misconfiguration error as resolveFromEnv", () => {
  assert.throws(() => resolveTransportByName("webpubsub"), /HELM_WEBPUBSUB_NEGOTIATE_URL/);
});

// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTransportConfig, loadTransportConfig, saveTransportConfig } from "../src/transportConfig.mjs";

let helmHome;

beforeEach(() => {
  helmHome = mkdtempSync(join(tmpdir(), "helm-home-"));
});

afterEach(() => {
  rmSync(helmHome, { recursive: true, force: true });
});

test("loadTransportConfig returns null when nothing is configured", () => {
  assert.equal(loadTransportConfig({ baseDir: helmHome }), null);
});

test("save/load round-trips a local descriptor", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: helmHome });
  assert.deepEqual(loadTransportConfig({ baseDir: helmHome }), { kind: "local" });
});

test("save/load round-trips a supabase descriptor", () => {
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: helmHome });
  assert.deepEqual(loadTransportConfig({ baseDir: helmHome }), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("save/load round-trips a webpubsub descriptor", () => {
  saveTransportConfig({ kind: "webpubsub", negotiateUrl: "https://neg.example/api" }, { baseDir: helmHome });
  assert.deepEqual(loadTransportConfig({ baseDir: helmHome }), {
    kind: "webpubsub",
    negotiateUrl: "https://neg.example/api",
  });
});

test("saveTransportConfig rejects an invalid descriptor", () => {
  assert.throws(() => saveTransportConfig({ kind: "bogus" }, { baseDir: helmHome }), /invalid transport descriptor/);
  assert.throws(
    () => saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co" }, { baseDir: helmHome }),
    /invalid transport descriptor/,
  );
});

test("a second save overwrites the first", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: helmHome });
  saveTransportConfig({ kind: "webpubsub", negotiateUrl: "https://neg.example/api" }, { baseDir: helmHome });
  assert.deepEqual(loadTransportConfig({ baseDir: helmHome }), {
    kind: "webpubsub",
    negotiateUrl: "https://neg.example/api",
  });
});

test("clearTransportConfig removes the persisted choice", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: helmHome });
  clearTransportConfig({ baseDir: helmHome });
  assert.equal(loadTransportConfig({ baseDir: helmHome }), null);
});

test("clearTransportConfig on an already-empty store is a no-op", () => {
  assert.doesNotThrow(() => clearTransportConfig({ baseDir: helmHome }));
});

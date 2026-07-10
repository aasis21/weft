// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTransportConfig, loadTransportConfig, saveTransportConfig } from "../src/transportConfig.mjs";

let weftHome;

beforeEach(() => {
  weftHome = mkdtempSync(join(tmpdir(), "weft-home-"));
});

afterEach(() => {
  rmSync(weftHome, { recursive: true, force: true });
});

test("loadTransportConfig returns null when nothing is configured", () => {
  assert.equal(loadTransportConfig({ baseDir: weftHome }), null);
});

test("save/load round-trips a local descriptor", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), { kind: "local" });
});

test("save/load round-trips a supabase descriptor", () => {
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("save/load round-trips a webpubsub descriptor", () => {
  saveTransportConfig({ kind: "webpubsub", negotiateUrl: "https://neg.example/api" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), {
    kind: "webpubsub",
    negotiateUrl: "https://neg.example/api",
  });
});

test("saveTransportConfig rejects an invalid descriptor", () => {
  assert.throws(() => saveTransportConfig({ kind: "bogus" }, { baseDir: weftHome }), /invalid transport descriptor/);
  assert.throws(
    () => saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co" }, { baseDir: weftHome }),
    /invalid transport descriptor/,
  );
});

test("a second save overwrites the first", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "webpubsub", negotiateUrl: "https://neg.example/api" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), {
    kind: "webpubsub",
    negotiateUrl: "https://neg.example/api",
  });
});

test("clearTransportConfig removes the persisted choice", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  clearTransportConfig({ baseDir: weftHome });
  assert.equal(loadTransportConfig({ baseDir: weftHome }), null);
});

test("clearTransportConfig on an already-empty store is a no-op", () => {
  assert.doesNotThrow(() => clearTransportConfig({ baseDir: weftHome }));
});

test("saveTransportConfig merges into weft.config.json without clobbering other keys", () => {
  writeFileSync(join(weftHome, "weft.config.json"), JSON.stringify({ someOtherSetting: 42 }));
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  const raw = JSON.parse(readFileSync(join(weftHome, "weft.config.json"), "utf8"));
  assert.deepEqual(raw, { someOtherSetting: 42, transport: { kind: "local" } });
});

test("clearTransportConfig removes only the transport key, keeping other config", () => {
  writeFileSync(join(weftHome, "weft.config.json"), JSON.stringify({ someOtherSetting: 42 }));
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  clearTransportConfig({ baseDir: weftHome });
  const raw = JSON.parse(readFileSync(join(weftHome, "weft.config.json"), "utf8"));
  assert.deepEqual(raw, { someOtherSetting: 42 });
  assert.equal(loadTransportConfig({ baseDir: weftHome }), null);
});

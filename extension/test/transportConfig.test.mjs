// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearTransportConfig,
  loadTransportConfig,
  saveTransportConfig,
  saveSupabaseCredentials,
  loadSupabaseCredentials,
  clearSupabaseCredentials,
  supabaseCredentialsPath,
  loadDeviceName,
  saveDeviceName,
} from "../src/transportConfig.mjs";

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

test("save/load round-trips a supabase descriptor as a bare pointer (creds live in supabase.json)", () => {
  // Inline url/anonKey are intentionally stripped: the pointer file records ONLY which kind the
  // user chose. Credentials are stored separately by saveSupabaseCredentials (below), so
  // switching transports back and forth never destroys them.
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), { kind: "supabase" });
});

test("saveTransportConfig rejects an invalid descriptor", () => {
  assert.throws(() => saveTransportConfig({ kind: "bogus" }, { baseDir: weftHome }), /invalid transport descriptor/);
  assert.throws(() => saveTransportConfig(null, { baseDir: weftHome }), /invalid transport descriptor/);
});

test("a second save overwrites the first", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  assert.deepEqual(loadTransportConfig({ baseDir: weftHome }), { kind: "supabase" });
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

test("loadDeviceName returns null when nothing is configured", () => {
  assert.equal(loadDeviceName({ baseDir: weftHome }), null);
});

test("save/load round-trips a device name, trimmed", () => {
  saveDeviceName("  My Laptop  ", { baseDir: weftHome });
  assert.equal(loadDeviceName({ baseDir: weftHome }), "My Laptop");
});

test("saveDeviceName rejects an empty/whitespace-only name", () => {
  assert.throws(() => saveDeviceName("", { baseDir: weftHome }), /non-empty string/);
  assert.throws(() => saveDeviceName("   ", { baseDir: weftHome }), /non-empty string/);
});

test("saveDeviceName rejects a name over the length limit", () => {
  assert.throws(() => saveDeviceName("x".repeat(61), { baseDir: weftHome }), /60 characters or fewer/);
});

test("saveDeviceName merges into weft.config.json without clobbering the transport", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  saveDeviceName("My Laptop", { baseDir: weftHome });
  const raw = JSON.parse(readFileSync(join(weftHome, "weft.config.json"), "utf8"));
  assert.deepEqual(raw, { transport: { kind: "local" }, deviceName: "My Laptop" });
});

// --- Supabase credentials live in a sibling file (~/.weft/supabase.json), independent of the
// pointer above. This lets the installer seed hosted defaults once and `weft set-transport
// supabase` (no flags) flip the pointer without asking for creds again. --------------------

test("loadSupabaseCredentials returns null when the file doesn't exist", () => {
  assert.equal(loadSupabaseCredentials({ baseDir: weftHome }), null);
});

test("saveSupabaseCredentials round-trips through loadSupabaseCredentials", () => {
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  assert.deepEqual(loadSupabaseCredentials({ baseDir: weftHome }), {
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
  // File exists next to (not inside) weft.config.json.
  assert.ok(existsSync(supabaseCredentialsPath({ baseDir: weftHome })));
  assert.equal(supabaseCredentialsPath({ baseDir: weftHome }), join(weftHome, "supabase.json"));
});

test("saveSupabaseCredentials trims whitespace and rejects empty fields", () => {
  saveSupabaseCredentials({ url: "  https://x.supabase.co  ", anonKey: "  anon  " }, { baseDir: weftHome });
  assert.deepEqual(loadSupabaseCredentials({ baseDir: weftHome }), {
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
  assert.throws(() => saveSupabaseCredentials({ url: "", anonKey: "anon" }, { baseDir: weftHome }), /url must be a non-empty string/);
  assert.throws(() => saveSupabaseCredentials({ url: "https://x", anonKey: "   " }, { baseDir: weftHome }), /anonKey must be a non-empty string/);
});

test("loadSupabaseCredentials returns null for corrupt JSON or missing fields (never throws)", () => {
  const credsPath = supabaseCredentialsPath({ baseDir: weftHome });
  writeFileSync(credsPath, "{not valid json");
  assert.equal(loadSupabaseCredentials({ baseDir: weftHome }), null);
  writeFileSync(credsPath, JSON.stringify({ url: "https://x" }));  // missing anonKey
  assert.equal(loadSupabaseCredentials({ baseDir: weftHome }), null);
});

test("saveSupabaseCredentials does NOT touch weft.config.json (independent files)", () => {
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  const configBefore = readFileSync(join(weftHome, "weft.config.json"), "utf8");
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  const configAfter = readFileSync(join(weftHome, "weft.config.json"), "utf8");
  assert.equal(configBefore, configAfter);
});

test("clearTransportConfig does NOT delete supabase.json (creds outlive the pointer)", () => {
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  saveTransportConfig({ kind: "supabase" }, { baseDir: weftHome });
  clearTransportConfig({ baseDir: weftHome });
  // Pointer is gone but creds are still on disk — flipping back is a one-liner without re-typing.
  assert.equal(loadTransportConfig({ baseDir: weftHome }), null);
  assert.deepEqual(loadSupabaseCredentials({ baseDir: weftHome }), {
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("clearSupabaseCredentials removes supabase.json and is a no-op if already gone", () => {
  saveSupabaseCredentials({ url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
  clearSupabaseCredentials({ baseDir: weftHome });
  assert.equal(loadSupabaseCredentials({ baseDir: weftHome }), null);
  assert.doesNotThrow(() => clearSupabaseCredentials({ baseDir: weftHome }));
});

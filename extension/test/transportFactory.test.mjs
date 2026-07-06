// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTransportDescriptor, resolveTransportByName, resolveTransportForChannel, SUPPORTED_TRANSPORT_NAMES } from "../src/transportFactory.mjs";
import { saveTransportConfig } from "../src/transportConfig.mjs";

const ENV_KEYS = [
  "WEFT_TRANSPORT",
  "WEFT_SUPABASE_URL",
  "WEFT_SUPABASE_ANON_KEY",
  "SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "WEFT_WEBPUBSUB_NEGOTIATE_URL",
];

let weftHome;
let savedEnv;

beforeEach(() => {
  weftHome = mkdtempSync(join(tmpdir(), "weft-home-"));
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  rmSync(weftHome, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("defaults to supabase when nothing is configured and supabase env vars are present", () => {
  process.env.WEFT_SUPABASE_URL = "https://default.supabase.co";
  process.env.WEFT_SUPABASE_ANON_KEY = "default-anon";
  assert.deepEqual(resolveTransportDescriptor({ baseDir: weftHome }), {
    kind: "supabase",
    url: "https://default.supabase.co",
    anonKey: "default-anon",
  });
});

test("throws an actionable error when nothing is configured and no supabase env vars exist", () => {
  assert.throws(() => resolveTransportDescriptor({ baseDir: weftHome }), /weft set-transport/);
});

test("a persisted `weft set-transport` choice wins over the supabase default", () => {
  saveTransportConfig({ kind: "local" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportDescriptor({ baseDir: weftHome }), { kind: "local" });
});

test("a persisted devtunnel choice is stored as a bare marker (url is provisioned later per channel)", () => {
  saveTransportConfig({ kind: "devtunnel" }, { baseDir: weftHome });
  assert.deepEqual(resolveTransportDescriptor({ baseDir: weftHome }), { kind: "devtunnel" });
});

test("WEFT_TRANSPORT env var wins over a persisted config", () => {
  saveTransportConfig({ kind: "webpubsub", negotiateUrl: "https://stale.example" }, { baseDir: weftHome });
  process.env.WEFT_TRANSPORT = "local";
  assert.deepEqual(resolveTransportDescriptor({ baseDir: weftHome }), { kind: "local" });
});

test("WEFT_TRANSPORT=webpubsub requires WEFT_WEBPUBSUB_NEGOTIATE_URL", () => {
  process.env.WEFT_TRANSPORT = "webpubsub";
  assert.throws(() => resolveTransportDescriptor({ baseDir: weftHome }), /WEFT_WEBPUBSUB_NEGOTIATE_URL/);
});

test("resolveTransportByName only offers the user-facing transports (supabase)", () => {
  assert.deepEqual(SUPPORTED_TRANSPORT_NAMES, ["supabase"]);
});

test("resolveTransportByName resolves supabase regardless of persisted config/env", () => {
  saveTransportConfig({ kind: "webpubsub", negotiateUrl: "https://stale.example" }, { baseDir: weftHome });
  process.env.WEFT_SUPABASE_URL = "https://x.supabase.co";
  process.env.WEFT_SUPABASE_ANON_KEY = "anon";
  assert.deepEqual(resolveTransportByName("supabase"), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("resolveTransportByName is case-insensitive and trims whitespace", () => {
  process.env.WEFT_SUPABASE_URL = "https://x.supabase.co";
  process.env.WEFT_SUPABASE_ANON_KEY = "anon";
  assert.deepEqual(resolveTransportByName("  SUPABASE "), {
    kind: "supabase",
    url: "https://x.supabase.co",
    anonKey: "anon",
  });
});

test("resolveTransportByName rejects local/webpubsub/devtunnel — hidden from this user-facing path", () => {
  for (const hidden of ["local", "webpubsub", "devtunnel", "bluetooth"]) {
    assert.throws(() => resolveTransportByName(hidden), (err) => {
      assert.match(err.message, new RegExp(`unknown transport "${hidden}"`));
      for (const name of SUPPORTED_TRANSPORT_NAMES) assert.match(err.message, new RegExp(name));
      return true;
    });
  }
});

test("resolveTransportForChannel passes non-devtunnel descriptors through unchanged", async () => {
  process.env.WEFT_SUPABASE_URL = "https://x.supabase.co";
  process.env.WEFT_SUPABASE_ANON_KEY = "anon";
  const descriptor = await resolveTransportForChannel({ baseDir: weftHome, channelId: "chan-1" });
  assert.deepEqual(descriptor, { kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" });
});

test("resolveTransportForChannel expands a persisted devtunnel marker into a real, provisioned descriptor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const FAKE_CLI_SCRIPT = `
const args = process.argv.slice(2);
const [cmd] = args;
if (cmd === "--version") { console.log("fake 1.0"); process.exit(0); }
if (args.join(" ") === "user show") { process.exit(0); }
if (cmd === "create" && args.includes("--json")) {
  console.log(JSON.stringify({ tunnel: { tunnelId: "fake-tunnel-id" } }));
  process.exit(0);
}
if (cmd === "port") { process.exit(0); }
if (cmd === "access") { process.exit(0); }
if (cmd === "delete") { console.log("Deleted: fake-tunnel-id"); process.exit(0); }
if (cmd === "host") {
  console.log("Connect via browser: https://fake-abc123-9999.usw2.devtunnels.ms");
  setInterval(() => {}, 1000);
} else { process.exit(1); }
`;
  const scriptPath = join(dir, "fake-devtunnel.mjs");
  writeFileSync(scriptPath, FAKE_CLI_SCRIPT);
  const isWindows = process.platform === "win32";
  const shimPath = join(dir, isWindows ? "devtunnel.cmd" : "devtunnel");
  if (isWindows) {
    writeFileSync(shimPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
  } else {
    writeFileSync(shimPath, `#!/bin/sh\nexec node "${scriptPath}" "$@"\n`);
    chmodSync(shimPath, 0o755);
  }
  process.env.WEFT_DEVTUNNEL_BIN = shimPath;
  process.env.WEFT_DEVTUNNEL_IDLE_MS = "300";
  process.env.WEFT_DEVTUNNEL_CHECK_MS = "100";
  saveTransportConfig({ kind: "devtunnel" }, { baseDir: weftHome });
  try {
    const descriptor = await resolveTransportForChannel({ baseDir: weftHome, channelId: "chan-1" });
    assert.equal(descriptor.kind, "devtunnel");
    assert.equal(descriptor.url, "wss://fake-abc123-9999.usw2.devtunnels.ms?channelId=chan-1");
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.WEFT_DEVTUNNEL_IDLE_MS;
    delete process.env.WEFT_DEVTUNNEL_CHECK_MS;
    rmSync(dir, { recursive: true, force: true });
  }
});

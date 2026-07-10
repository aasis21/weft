// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTransportDescriptor, resolveTransportByName, resolveTransportForChannel, SUPPORTED_TRANSPORT_NAMES } from "../src/transportFactory.mjs";
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

test("resolveTransportByName rejects local/webpubsub/devtunnel — hidden from this user-facing path", () => {
  for (const hidden of ["local", "webpubsub", "devtunnel", "bluetooth"]) {
    assert.throws(() => resolveTransportByName(hidden, { baseDir: weftHome }), (err) => {
      assert.match(err.message, new RegExp(`unknown transport "${hidden}"`));
      for (const name of SUPPORTED_TRANSPORT_NAMES) assert.match(err.message, new RegExp(name));
      return true;
    });
  }
});

test("resolveTransportForChannel passes non-devtunnel descriptors through unchanged", async () => {
  saveTransportConfig({ kind: "supabase", url: "https://x.supabase.co", anonKey: "anon" }, { baseDir: weftHome });
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

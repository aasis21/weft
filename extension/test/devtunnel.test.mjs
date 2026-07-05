// SPDX-License-Identifier: Apache-2.0
// Exercises devtunnel.mjs against a FAKE `devtunnel` CLI (a tiny Node script invoked via a .cmd
// shim) rather than the real one, so this suite runs anywhere without a devtunnel install/login —
// the real CLI was separately verified end-to-end by hand (see checkpoint notes).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_CLI_SCRIPT = `
const args = process.argv.slice(2);
const [cmd] = args;
if (cmd === "--version") { console.log("fake 1.0"); process.exit(0); }
if (args.join(" ") === "user show") { process.exit(process.env.FAKE_DEVTUNNEL_LOGGED_IN ? 0 : 1); }
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
  process.exitCode = undefined;
} else {
  process.exit(1);
}
`;

function makeFakeCli(dir) {
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
  return shimPath;
}

async function freshModule() {
  // devtunnel.mjs caches the resolved binary + provisioned tunnel at module scope — import with a
  // cache-busting query so each test starts from a clean slate.
  return import(`../src/devtunnel.mjs?t=${Date.now()}-${Math.random()}`);
}

test("findDevTunnelBinary resolves HELM_DEVTUNNEL_BIN when it runs successfully", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-devtunnel-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.HELM_DEVTUNNEL_BIN = bin;
    const { findDevTunnelBinary } = await freshModule();
    assert.equal(await findDevTunnelBinary(), bin);
  } finally {
    delete process.env.HELM_DEVTUNNEL_BIN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provisionDevTunnelTransport throws an actionable error when not logged in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-devtunnel-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.HELM_DEVTUNNEL_BIN = bin;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    const { provisionDevTunnelTransport } = await freshModule();
    await assert.rejects(provisionDevTunnelTransport({ channelId: "chan-1" }), /devtunnel user login/);
  } finally {
    delete process.env.HELM_DEVTUNNEL_BIN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provisionDevTunnelTransport builds a wss URL with the channelId, reusing the tunnel on a second call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-devtunnel-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.HELM_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    const { provisionDevTunnelTransport, stopDevTunnel } = await freshModule();

    const first = await provisionDevTunnelTransport({ channelId: "chan-a" });
    assert.equal(first.kind, "devtunnel");
    assert.equal(first.url, "wss://fake-abc123-9999.usw2.devtunnels.ms?channelId=chan-a");

    const second = await provisionDevTunnelTransport({ channelId: "chan-b" });
    assert.equal(second.url, "wss://fake-abc123-9999.usw2.devtunnels.ms?channelId=chan-b");

    await stopDevTunnel();
  } finally {
    delete process.env.HELM_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    rmSync(dir, { recursive: true, force: true });
  }
});

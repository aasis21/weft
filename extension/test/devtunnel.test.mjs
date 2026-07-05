// SPDX-License-Identifier: Apache-2.0
// Exercises devtunnel.mjs + relayServerProcess.mjs against a FAKE `devtunnel` CLI (a tiny Node
// script invoked via a .cmd/shell shim) rather than the real one, so this suite runs anywhere
// without a devtunnel install/login — the real CLI was separately verified end-to-end by hand
// (see checkpoint notes). The shared relay is now a DETACHED child process, so these tests spawn
// it for real (short idle timeouts via env overrides) and assert on the registry file it
// publishes/clears, rather than importing in-process state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, readFileSync, existsSync } from "node:fs";
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
  // devtunnel.mjs resolves+caches the binary at module scope — import with a cache-busting query
  // so each test starts from a clean slate.
  return import(`../src/devtunnel.mjs?t=${Date.now()}-${Math.random()}`);
}

const waitFor = async (predicate, message, timeoutMs = 5000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail(`Timed out waiting for ${message}`);
};

async function forceKill(pid) {
  if (process.platform === "win32") {
    const { execFile } = await import("node:child_process");
    const { promisify } = await import("node:util");
    try {
      await promisify(execFile)("taskkill", ["/pid", String(pid), "/t", "/f"]);
    } catch {
      // best-effort — process may have already exited.
    }
    return;
  }
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // best-effort
  }
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
  const homeDir = mkdtempSync(join(tmpdir(), "helm-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.HELM_DEVTUNNEL_BIN = bin;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    const { provisionDevTunnelTransport } = await freshModule();
    await assert.rejects(
      provisionDevTunnelTransport({ channelId: "chan-1", baseDir: homeDir }),
      /devtunnel user login/,
    );
  } finally {
    delete process.env.HELM_DEVTUNNEL_BIN;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("provisionDevTunnelTransport spawns the shared relay, publishes a registry entry, and reuses it on a second call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "helm-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.HELM_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    const { provisionDevTunnelTransport } = await freshModule();

    const first = await provisionDevTunnelTransport({ channelId: "chan-a", baseDir: homeDir });
    assert.equal(first.kind, "devtunnel");
    assert.equal(first.url, "wss://fake-abc123-9999.usw2.devtunnels.ms?channelId=chan-a");

    const registryPath = join(homeDir, "devtunnel.json");
    await waitFor(() => existsSync(registryPath), "registry file to appear");
    const entry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.ok(entry.pid);
    assert.ok(entry.relayPort);
    assert.equal(entry.baseUrl, "wss://fake-abc123-9999.usw2.devtunnels.ms");

    // Second call (different channelId, same "machine"/HELM_HOME) should discover + reuse the
    // already-published registry entry rather than spawning a second relay process.
    const second = await provisionDevTunnelTransport({ channelId: "chan-b", baseDir: homeDir });
    assert.equal(second.url, "wss://fake-abc123-9999.usw2.devtunnels.ms?channelId=chan-b");
    const entryAfterSecond = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(entryAfterSecond.pid, entry.pid, "second call reused the same relay process");

    // Clean up the detached relay process this test spawned so it doesn't linger past the test
    // run. NOTE: we force-kill rather than asserting graceful self-teardown here — on Windows,
    // process.kill(pid, "SIGTERM") from another process unconditionally terminates the target
    // immediately rather than delivering a real signal the target can handle (Windows has no
    // POSIX signals), so a manually-triggered graceful shutdown isn't reliably testable this way.
    // Self-teardown via the idle timer (the ACTUAL production cleanup path) is covered by the
    // next test instead.
    await forceKill(entry.pid);
    rmSync(registryPath, { force: true });
  } finally {
    delete process.env.HELM_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("the shared relay self-tears-down after its idle timeout with no connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "helm-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "helm-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.HELM_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    process.env.HELM_DEVTUNNEL_IDLE_MS = "300";
    process.env.HELM_DEVTUNNEL_CHECK_MS = "100";
    const { provisionDevTunnelTransport } = await freshModule();

    await provisionDevTunnelTransport({ channelId: "chan-a", baseDir: homeDir });
    const registryPath = join(homeDir, "devtunnel.json");
    await waitFor(() => existsSync(registryPath), "registry file to appear");

    // Nobody ever connects to the relay in this test — it should self-idle-out and clean up
    // its own registry entry without any external teardown call.
    await waitFor(() => !existsSync(registryPath), "registry file to be cleared by self idle-teardown", 10_000);
  } finally {
    delete process.env.HELM_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    delete process.env.HELM_DEVTUNNEL_IDLE_MS;
    delete process.env.HELM_DEVTUNNEL_CHECK_MS;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

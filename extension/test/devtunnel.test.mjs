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
import { appendFileSync } from "node:fs";
function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {}
}
const stageDelayMs = Number(process.env.FAKE_DEVTUNNEL_STAGE_DELAY_MS) || 0;
const args = process.argv.slice(2);
const [cmd] = args;
if (cmd === "--version") { console.log("fake 1.0"); process.exit(0); }
if (args.join(" ") === "user show") { process.exit(process.env.FAKE_DEVTUNNEL_LOGGED_IN ? 0 : 1); }
if (cmd === "create" && args.includes("--json")) {
  if (stageDelayMs) sleepSync(stageDelayMs);
  console.log(JSON.stringify({ tunnel: { tunnelId: "fake-tunnel-id" } }));
  process.exit(0);
}
if (cmd === "port") { if (stageDelayMs) sleepSync(stageDelayMs); process.exit(0); }
if (cmd === "access") { if (stageDelayMs) sleepSync(stageDelayMs); process.exit(0); }
if (cmd === "delete") { console.log("Deleted: fake-tunnel-id"); process.exit(0); }
if (cmd === "host") {
  if (process.env.FAKE_DEVTUNNEL_HOST_LOG) {
    appendFileSync(process.env.FAKE_DEVTUNNEL_HOST_LOG, "1\\n");
  }
  if (stageDelayMs) sleepSync(stageDelayMs);
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

test("findDevTunnelBinary resolves WEFT_DEVTUNNEL_BIN when it runs successfully", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    const { findDevTunnelBinary } = await freshModule();
    assert.equal(await findDevTunnelBinary(), bin);
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("provisionDevTunnelTransport throws an actionable error when not logged in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    const { provisionDevTunnelTransport } = await freshModule();
    await assert.rejects(
      provisionDevTunnelTransport({ channelId: "chan-1", baseDir: homeDir }),
      /devtunnel user login/,
    );
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("provisionDevTunnelTransport spawns the shared relay, publishes a registry entry, and reuses it on a second call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
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

    // Second call (different channelId, same "machine"/WEFT_HOME) should discover + reuse the
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
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("the shared relay self-tears-down after its idle timeout with no connections", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    process.env.WEFT_DEVTUNNEL_IDLE_MS = "300";
    process.env.WEFT_DEVTUNNEL_CHECK_MS = "100";
    const { provisionDevTunnelTransport } = await freshModule();

    await provisionDevTunnelTransport({ channelId: "chan-a", baseDir: homeDir });
    const registryPath = join(homeDir, "devtunnel.json");
    await waitFor(() => existsSync(registryPath), "registry file to appear");

    // Nobody ever connects to the relay in this test — it should self-idle-out and clean up
    // its own registry entry without any external teardown call.
    await waitFor(() => !existsSync(registryPath), "registry file to be cleared by self idle-teardown", 10_000);
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    delete process.env.WEFT_DEVTUNNEL_IDLE_MS;
    delete process.env.WEFT_DEVTUNNEL_CHECK_MS;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("provisionDevTunnelTransport reports stage progress via onProgress as the relay comes up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    // Slow each devtunnel-CLI step down just enough that the 100ms status-file poll observes
    // several distinct stages rather than racing straight to the final registry entry.
    process.env.FAKE_DEVTUNNEL_STAGE_DELAY_MS = "150";
    const { provisionDevTunnelTransport } = await freshModule();

    const stages = [];
    const descriptor = await provisionDevTunnelTransport({
      channelId: "chan-progress",
      baseDir: homeDir,
      onProgress: (stage) => stages.push(stage),
    });

    assert.equal(descriptor.kind, "devtunnel");
    assert.ok(stages.length > 0, "expected at least one stage progress callback");
    // Stages must appear in the order relayServerProcess.mjs publishes them (a subset is fine —
    // the exact ones observed depend on scheduling, but relative order must never regress).
    const order = ["starting-relay", "creating-tunnel", "creating-port", "creating-access", "hosting", "waiting-for-url"];
    let lastIndex = -1;
    for (const stage of stages) {
      const idx = order.indexOf(stage);
      assert.ok(idx >= 0, `unexpected stage: ${stage}`);
      assert.ok(idx >= lastIndex, `stage ${stage} observed out of order`);
      lastIndex = idx;
    }

    const registryPath = join(homeDir, "devtunnel.json");
    const entry = JSON.parse(readFileSync(registryPath, "utf8"));
    await forceKill(entry.pid);
    rmSync(registryPath, { force: true });
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    delete process.env.FAKE_DEVTUNNEL_STAGE_DELAY_MS;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("provisionDevTunnelTransport retries across cycles without re-spawning the relay, then succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  const hostLog = join(dir, "host-calls.log");
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    process.env.FAKE_DEVTUNNEL_HOST_LOG = hostLog;
    // Each devtunnel-CLI step takes ~250ms (create+port+access+host ≈ 1s total plus relay/process
    // startup overhead), but the first "cycle" only gets 400ms — short enough to force at least
    // one onRetry before the relay finishes coming up well within the 10s max-wait ceiling.
    process.env.FAKE_DEVTUNNEL_STAGE_DELAY_MS = "250";
    process.env.WEFT_DEVTUNNEL_TIMEOUT_MS = "400";
    process.env.WEFT_DEVTUNNEL_MAX_WAIT_MS = "10000";
    const { provisionDevTunnelTransport } = await freshModule();

    let retryCalls = 0;
    const descriptor = await provisionDevTunnelTransport({
      channelId: "chan-retry",
      baseDir: homeDir,
      onRetry: () => {
        retryCalls += 1;
      },
    });

    assert.equal(descriptor.kind, "devtunnel");
    assert.ok(retryCalls >= 1, "expected at least one retry cycle before success");

    // The detached relay process must only have been spawned once across all retry cycles — the
    // fake CLI's "host" subcommand logs one line per invocation.
    const hostCalls = existsSync(hostLog) ? readFileSync(hostLog, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.equal(hostCalls.length, 1, "expected the relay child process to be spawned exactly once");

    const registryPath = join(homeDir, "devtunnel.json");
    const entry = JSON.parse(readFileSync(registryPath, "utf8"));
    await forceKill(entry.pid);
    rmSync(registryPath, { force: true });
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    delete process.env.FAKE_DEVTUNNEL_HOST_LOG;
    delete process.env.FAKE_DEVTUNNEL_STAGE_DELAY_MS;
    delete process.env.WEFT_DEVTUNNEL_TIMEOUT_MS;
    delete process.env.WEFT_DEVTUNNEL_MAX_WAIT_MS;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("provisionDevTunnelTransport gives an actionable error after exhausting the max-wait ceiling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    // Stage delay far longer than the max-wait ceiling — every cycle times out, so the whole
    // provision should exhaust retries and throw the actionable message pointing at the CLI.
    process.env.FAKE_DEVTUNNEL_STAGE_DELAY_MS = "2000";
    process.env.WEFT_DEVTUNNEL_TIMEOUT_MS = "200";
    process.env.WEFT_DEVTUNNEL_MAX_WAIT_MS = "600";
    const { provisionDevTunnelTransport } = await freshModule();

    await assert.rejects(
      provisionDevTunnelTransport({ channelId: "chan-exhaust", baseDir: homeDir }),
      /weft devtunnel status|weft devtunnel start/,
    );
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    delete process.env.FAKE_DEVTUNNEL_STAGE_DELAY_MS;
    delete process.env.WEFT_DEVTUNNEL_TIMEOUT_MS;
    delete process.env.WEFT_DEVTUNNEL_MAX_WAIT_MS;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("forceStopDevTunnel tears down a running relay and clears the registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    const { provisionDevTunnelTransport, forceStopDevTunnel, healthyRegistryEntry } = await freshModule();

    await provisionDevTunnelTransport({ channelId: "chan-stop", baseDir: homeDir });
    const registryPath = join(homeDir, "devtunnel.json");
    await waitFor(() => existsSync(registryPath), "registry file to appear");

    const { stopped } = await forceStopDevTunnel({ baseDir: homeDir });
    assert.equal(stopped, true);
    await waitFor(() => !existsSync(registryPath), "registry file to be cleared by forceStopDevTunnel");
    assert.equal(await healthyRegistryEntry(homeDir), null);
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("forceStopDevTunnel is a no-op when nothing is registered", async () => {
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const { forceStopDevTunnel } = await freshModule();
    const result = await forceStopDevTunnel({ baseDir: homeDir });
    assert.equal(result.stopped, false);
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});


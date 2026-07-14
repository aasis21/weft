// SPDX-License-Identifier: Apache-2.0
// Exercises devtunnel.mjs + relayServerProcess.mjs against a FAKE `devtunnel` CLI (a tiny Node
// script invoked via a .cmd/shell shim) rather than the real one, so this suite runs anywhere
// without a devtunnel install/login — the real CLI was separately verified end-to-end by hand
// (see checkpoint notes). The shared relay is an ATTACHED child process whose lifetime is tied
// to the parent (test) process, so these tests spawn it for real and assert on the registry
// file it publishes/clears, rather than importing in-process state; each test force-kills its
// spawned child in its finally block so the test process can exit cleanly.
//
// Two entry points are tested in parallel:
//   - ensureDevTunnelRelay() is the spawn/wait path (only the standalone `weft devtunnel start`
//     CLI calls it): CLI discovery, auto-login, stage progress, retry-across-cycles, exhaust.
//     Returns `{ baseUrl, child }` — the caller owns the child's lifetime.
//   - resolveDevTunnelTransport() is the read-only pairing-path lookup: returns a descriptor if
//     a healthy relay is already running (throws pointing at `weft devtunnel start` otherwise).
//     Never spawns, never waits — symmetric with how the Supabase transport just uses whatever
//     Supabase project the user configured.
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
  if (process.env.FAKE_DEVTUNNEL_CREATE_LOG) {
    appendFileSync(process.env.FAKE_DEVTUNNEL_CREATE_LOG, "1\\n");
  }
  if (stageDelayMs) sleepSync(stageDelayMs);
  console.log(JSON.stringify({ tunnel: { tunnelId: "fake-tunnel-id" } }));
  process.exit(0);
}
if (cmd === "show") { process.exit(process.env.FAKE_DEVTUNNEL_SHOW_FAILS ? 1 : 0); }
if (cmd === "port") { if (stageDelayMs) sleepSync(stageDelayMs); process.exit(0); }
if (cmd === "access") { if (stageDelayMs) sleepSync(stageDelayMs); process.exit(0); }
if (cmd === "delete") {
  if (process.env.FAKE_DEVTUNNEL_DELETE_LOG) {
    appendFileSync(process.env.FAKE_DEVTUNNEL_DELETE_LOG, "1\\n");
  }
  console.log("Deleted: fake-tunnel-id");
  process.exit(0);
}
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

test("ensureDevTunnelRelay throws an actionable error when not logged in", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    const { ensureDevTunnelRelay } = await freshModule();
    await assert.rejects(
      ensureDevTunnelRelay({ baseDir: homeDir }),
      /devtunnel user login/,
    );
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveDevTunnelTransport throws with an actionable error when no relay is running", async () => {
  // No CLI shim, no WEFT_DEVTUNNEL_BIN, no registry file — the pairing-path lookup must NEVER
  // touch the CLI or try to spawn anything, so this should throw purely from finding no healthy
  // registry entry. The error message must point the user at `weft devtunnel start`.
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const { resolveDevTunnelTransport } = await freshModule();
    await assert.rejects(
      resolveDevTunnelTransport({ baseDir: homeDir }),
      /weft devtunnel start/,
    );
  } finally {
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("resolveDevTunnelTransport returns a channel-agnostic base-URL descriptor when the shared relay is already running", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    const { ensureDevTunnelRelay, resolveDevTunnelTransport } = await freshModule();

    // Prime the shared relay via the standalone-CLI path (what `weft devtunnel start` runs).
    await ensureDevTunnelRelay({ baseDir: homeDir });
    const registryPath = join(homeDir, "devtunnel.json");
    await waitFor(() => existsSync(registryPath), "registry file to appear");
    const entry = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.ok(entry.pid);
    assert.ok(entry.relayPort);
    assert.equal(entry.baseUrl, "wss://fake-abc123-9999.usw2.devtunnels.ms");

    // Pairing-path lookup returns a pure `{kind, url: baseUrl}` descriptor — no channelId baked
    // in, exactly like the Supabase descriptor. channelId is applied by whoever constructs the
    // WebSocket later (see transportFactory.mjs / mobile weftClient.ts).
    const descriptor = await resolveDevTunnelTransport({ baseDir: homeDir });
    assert.deepEqual(descriptor, {
      kind: "devtunnel",
      url: "wss://fake-abc123-9999.usw2.devtunnels.ms",
    });

    // A second lookup reuses the same running relay rather than spawning a second one.
    const again = await resolveDevTunnelTransport({ baseDir: homeDir });
    assert.deepEqual(again, descriptor);
    const entryAfterSecond = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(entryAfterSecond.pid, entry.pid, "second lookup reused the same relay process");

    // Clean up the relay child process this test spawned so the test-runner process can exit
    // cleanly. NOTE: we force-kill rather than asserting graceful teardown here — on Windows,
    // process.kill(pid, "SIGTERM") from another process unconditionally terminates the target
    // immediately rather than delivering a real signal the target can handle (Windows has no
    // POSIX signals), so a manually-triggered graceful shutdown isn't reliably testable this
    // way. The `forceStopDevTunnel tears down…` test below covers the actual production
    // cleanup path (which uses taskkill directly for exactly this reason).
    await forceKill(entry.pid);
    rmSync(registryPath, { force: true });
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("ensureDevTunnelRelay provisions and reuses the shared relay without needing a channelId", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    const { ensureDevTunnelRelay } = await freshModule();

    // No channelId anywhere — this is a channel-agnostic, machine-wide resource.
    const { baseUrl, child } = await ensureDevTunnelRelay({ baseDir: homeDir });
    assert.equal(baseUrl, "wss://fake-abc123-9999.usw2.devtunnels.ms");
    assert.ok(child, "first ensureDevTunnelRelay call owns the spawned child");

    const registryPath = join(homeDir, "devtunnel.json");
    await waitFor(() => existsSync(registryPath), "registry file to appear");
    const entry = JSON.parse(readFileSync(registryPath, "utf8"));

    // A second call reuses the already-published entry rather than spawning a second relay —
    // and correspondingly returns `child: null`, signalling the caller doesn't own anything.
    const second = await ensureDevTunnelRelay({ baseDir: homeDir });
    assert.equal(second.baseUrl, baseUrl);
    assert.equal(second.child, null, "second call must not spawn (returns child: null)");
    const entryAfterSecond = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(entryAfterSecond.pid, entry.pid, "second call reused the same relay process");

    await forceKill(entry.pid);
    rmSync(registryPath, { force: true });
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("ensureDevTunnelRelay reports stage progress via onProgress as the relay comes up", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    // Slow each devtunnel-CLI step down just enough that the 100ms status-file poll observes
    // several distinct stages rather than racing straight to the final registry entry.
    process.env.FAKE_DEVTUNNEL_STAGE_DELAY_MS = "150";
    const { ensureDevTunnelRelay } = await freshModule();

    const stages = [];
    const { baseUrl } = await ensureDevTunnelRelay({
      baseDir: homeDir,
      onProgress: (stage) => stages.push(stage),
    });

    assert.equal(baseUrl, "wss://fake-abc123-9999.usw2.devtunnels.ms");
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

test("ensureDevTunnelRelay retries across cycles without re-spawning the relay, then succeeds", async () => {
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
    const { ensureDevTunnelRelay } = await freshModule();

    let retryCalls = 0;
    const { baseUrl } = await ensureDevTunnelRelay({
      baseDir: homeDir,
      onRetry: () => {
        retryCalls += 1;
      },
    });

    assert.equal(baseUrl, "wss://fake-abc123-9999.usw2.devtunnels.ms");
    assert.ok(retryCalls >= 1, "expected at least one retry cycle before success");

    // The relay child process must only have been spawned once across all retry cycles — the
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

test("ensureDevTunnelRelay gives an actionable error after exhausting the max-wait ceiling", async () => {
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
    const { ensureDevTunnelRelay } = await freshModule();

    await assert.rejects(
      ensureDevTunnelRelay({ baseDir: homeDir }),
      /re-run `weft devtunnel start`/,
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
    const { ensureDevTunnelRelay, forceStopDevTunnel, healthyRegistryEntry } = await freshModule();

    await ensureDevTunnelRelay({ baseDir: homeDir });
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

test("persistent pairing: stop preserves the cloud tunnel + durable record instead of deleting it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  const deleteLog = join(dir, "delete-calls.log");
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    process.env.FAKE_DEVTUNNEL_DELETE_LOG = deleteLog;
    // Opt this home dir into persistent pairing — the switch the whole feature gates on.
    writeFileSync(join(homeDir, "weft.config.json"), JSON.stringify({ pairing: { persistent: true } }));
    const { ensureDevTunnelRelay, forceStopDevTunnel, healthyRegistryEntry } = await freshModule();

    await ensureDevTunnelRelay({ baseDir: homeDir });
    const registryPath = join(homeDir, "devtunnel.json");
    await waitFor(() => existsSync(registryPath), "registry file to appear");
    const before = JSON.parse(readFileSync(registryPath, "utf8"));

    const { stopped, preserved } = await forceStopDevTunnel({ baseDir: homeDir });
    assert.equal(stopped, true);
    assert.equal(preserved, true, "persistent stop must report preserved:true");

    // The durable record survives — same tunnelId + relayPort + baseUrl, but now marked not-alive
    // and with the pid dropped so pairing/status see the relay as down.
    assert.ok(existsSync(registryPath), "persistent stop must KEEP devtunnel.json");
    const after = JSON.parse(readFileSync(registryPath, "utf8"));
    assert.equal(after.tunnelId, before.tunnelId);
    assert.equal(after.relayPort, before.relayPort);
    assert.equal(after.baseUrl, before.baseUrl);
    assert.equal(after.alive, false);
    assert.equal(after.pid, undefined, "preserved record must not carry a stale pid");

    // The cloud tunnel must NOT have been deleted.
    assert.equal(existsSync(deleteLog), false, "persistent stop must not call devtunnel delete");

    // With no live pid, health reports the relay as down (informational alive flag aside).
    assert.equal(await healthyRegistryEntry(homeDir), null);
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    delete process.env.FAKE_DEVTUNNEL_DELETE_LOG;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});

test("persistent pairing: a restart reuses the preserved tunnel (same identity, no fresh create)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "weft-devtunnel-"));
  const homeDir = mkdtempSync(join(tmpdir(), "weft-home-"));
  const createLog = join(dir, "create-calls.log");
  const hostLog = join(dir, "host-calls.log");
  try {
    const bin = makeFakeCli(dir);
    process.env.WEFT_DEVTUNNEL_BIN = bin;
    process.env.FAKE_DEVTUNNEL_LOGGED_IN = "1";
    process.env.FAKE_DEVTUNNEL_CREATE_LOG = createLog;
    process.env.FAKE_DEVTUNNEL_HOST_LOG = hostLog;
    writeFileSync(join(homeDir, "weft.config.json"), JSON.stringify({ pairing: { persistent: true } }));
    const { ensureDevTunnelRelay, forceStopDevTunnel } = await freshModule();

    // First start: fresh create.
    await ensureDevTunnelRelay({ baseDir: homeDir });
    const registryPath = join(homeDir, "devtunnel.json");
    await waitFor(() => existsSync(registryPath), "registry file to appear");
    const first = JSON.parse(readFileSync(registryPath, "utf8"));

    // Stop (preserves the tunnel).
    await forceStopDevTunnel({ baseDir: homeDir });
    await waitFor(
      () => JSON.parse(readFileSync(registryPath, "utf8")).alive === false,
      "registry to be marked not-alive after stop",
    );

    // Second start: must REUSE the preserved tunnel — same tunnelId + relayPort, and crucially
    // `devtunnel create` must NOT be called again (host is, since a new relay child is spawned).
    await ensureDevTunnelRelay({ baseDir: homeDir });
    await waitFor(
      () => JSON.parse(readFileSync(registryPath, "utf8")).alive === true,
      "registry to be marked alive after restart",
    );
    const second = JSON.parse(readFileSync(registryPath, "utf8"));

    assert.equal(second.tunnelId, first.tunnelId, "restart must reuse the same tunnelId");
    assert.equal(second.relayPort, first.relayPort, "restart must reuse the same relay port");
    assert.equal(second.baseUrl, first.baseUrl, "restart must reproduce the same URL");

    const createCalls = existsSync(createLog) ? readFileSync(createLog, "utf8").trim().split("\n").filter(Boolean) : [];
    const hostCalls = existsSync(hostLog) ? readFileSync(hostLog, "utf8").trim().split("\n").filter(Boolean) : [];
    assert.equal(createCalls.length, 1, "devtunnel create must be called exactly once across both starts");
    assert.equal(hostCalls.length, 2, "devtunnel host must be called once per start");

    await forceKill(second.pid);
    rmSync(registryPath, { force: true });
  } finally {
    delete process.env.WEFT_DEVTUNNEL_BIN;
    delete process.env.FAKE_DEVTUNNEL_LOGGED_IN;
    delete process.env.FAKE_DEVTUNNEL_CREATE_LOG;
    delete process.env.FAKE_DEVTUNNEL_HOST_LOG;
    rmSync(dir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});


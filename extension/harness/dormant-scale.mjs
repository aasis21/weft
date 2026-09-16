// SPDX-License-Identifier: Apache-2.0
import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createRuntimeIdentity } from "../src/runtimeIdentity.mjs";
import { startRuntimeLifecycleHost } from "../src/runtimeLifecycle.mjs";

const DEFAULT_COUNTS = Object.freeze([20, 100]);
const TWENTY_SESSION_RSS_BUDGET_BYTES = 5 * 1_024 * 1_024;
const IDLE_SAMPLE_MS = 300;
const IDLE_CPU_TOLERANCE_MS = 15;
const REMOTE_RESOURCE_TYPES = new Set([
  "GETADDRINFOREQWRAP",
  "HTTP2SESSION",
  "HTTPCLIENTREQUEST",
  "TCPCONNECTWRAP",
  "TLSWRAP",
]);

function parseCount(value) {
  const count = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(count) || count < 1) throw new Error(`Invalid dormant session count: ${value}`);
  return count;
}

function percentile(values, fraction) {
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.min(ordered.length - 1, Math.floor(ordered.length * fraction))];
}

function resourceCounts() {
  const counts = {};
  for (const type of process.getActiveResourcesInfo()) counts[type] = (counts[type] ?? 0) + 1;
  return counts;
}

function resourceTotal(counts) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function osHandleCount() {
  if (process.platform === "win32") {
    const result = spawnSync("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-Process -Id ${process.pid}).HandleCount`,
    ], { encoding: "utf8", windowsHide: true });
    if (result.status === 0) {
      const count = Number.parseInt(result.stdout.trim(), 10);
      if (Number.isSafeInteger(count)) return { count, source: "Get-Process.HandleCount" };
    }
  } else if (process.platform === "linux" && existsSync("/proc/self/fd")) {
    return { count: readdirSync("/proc/self/fd").length, source: "/proc/self/fd" };
  }
  return { count: process._getActiveHandles?.().length ?? resourceTotal(resourceCounts()), source: "Node active handles" };
}

function activeRemoteSocketCount() {
  return (process._getActiveHandles?.() ?? []).filter((handle) =>
    typeof handle?.remoteAddress === "string" || Number.isInteger(handle?.remotePort)).length;
}

async function settle() {
  for (let index = 0; index < 3; index++) {
    globalThis.gc?.();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

async function stableRss() {
  const samples = [];
  for (let index = 0; index < 5; index++) {
    await settle();
    samples.push(process.memoryUsage.rss());
  }
  return percentile(samples, 0.5);
}

async function sampleIdleCpu() {
  const startedAt = performance.now();
  const usage = process.cpuUsage();
  await new Promise((resolve) => setTimeout(resolve, IDLE_SAMPLE_MS));
  const elapsedMs = performance.now() - startedAt;
  const delta = process.cpuUsage(usage);
  return {
    elapsedMs,
    cpuMs: (delta.user + delta.system) / 1_000,
  };
}

function createIdentity(index) {
  return createRuntimeIdentity({
    storeAuthority: "sha256:dormant-scale-store",
    sessionId: `dormant-session-${index}`,
    terminalInstanceId: `terminal-${index}`,
    runtimeInstanceId: `runtime-${process.pid}-${index}`,
    generation: 1,
  }, { scope: {} });
}

async function startHost(baseDir, index) {
  const startedAt = performance.now();
  const host = await startRuntimeLifecycleHost({
    identity: createIdentity(index),
    handlers: {},
  }, {
    baseDir,
    presenceOptions: {
      now: () => 1,
      capability: `capability-${index}`,
    },
    discoveryOptions: {
      verify: async () => ({ live: true }),
    },
  });
  return { host, startupMs: performance.now() - startedAt };
}

async function warmRuntime(baseDir, count) {
  const hosts = [];
  for (let index = 0; index < count; index++) {
    hosts.push(await startHost(baseDir, `warmup-${index}`));
  }
  for (const item of hosts.reverse()) await item.host.close();
  await settle();
}

async function runWorker(count) {
  assert.equal(typeof globalThis.gc, "function", "run the dormant scale harness with --expose-gc");
  const baseDir = mkdtempSync(join(tmpdir(), `weft-dormant-scale-${count}-`));
  const remoteActivity = [];
  let recordRemoteActivity = false;
  const hook = createHook({
    init(_asyncId, type) {
      if (recordRemoteActivity && REMOTE_RESOURCE_TYPES.has(type)) remoteActivity.push(type);
    },
  });
  hook.enable();

  const hosts = [];
  try {
    // Node and libuv grow their allocators in page-sized chunks while endpoints are first
    // created. Warm the same endpoint count and close it before taking the baseline so RSS
    // measures retained dormant-session overhead, not one-time allocator expansion.
    await warmRuntime(baseDir, count);
    const baselineResources = resourceCounts();
    const baselineHandles = osHandleCount();
    const baselineRemoteSockets = activeRemoteSocketCount();
    const baselineCpu = await sampleIdleCpu();
    const baselineRss = await stableRss();

    recordRemoteActivity = true;
    for (let index = 0; index < count; index++) hosts.push(await startHost(baseDir, index));
    await settle();

    const dormantRss = await stableRss();
    const dormantResources = resourceCounts();
    const dormantHandles = osHandleCount();
    const dormantRemoteSockets = activeRemoteSocketCount();
    const dormantCpu = await sampleIdleCpu();
    const activityBeforeIdle = resourceCounts();
    await new Promise((resolve) => setTimeout(resolve, IDLE_SAMPLE_MS));
    const activityAfterIdle = resourceCounts();

    const runtimeRoot = join(baseDir, "runtimes", "v1");
    const runtimeDirectories = readdirSync(runtimeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."));
    const presenceBytes = runtimeDirectories.reduce((sum, entry) =>
      sum + statSync(join(runtimeRoot, entry.name, "presence.json")).size +
      statSync(join(runtimeRoot, entry.name, "capability")).size, 0);

    assert.equal(runtimeDirectories.length, count, "each dormant session must own one presence directory");
    assert.equal(remoteActivity.length, 0, "dormant sessions must not initiate TCP, TLS, HTTP, or DNS activity");
    assert.equal(
      dormantRemoteSockets,
      baselineRemoteSockets,
      "dormant sessions must not retain remote socket connections",
    );
    if (dormantHandles.source !== "Node active handles") {
      assert.ok(
        dormantHandles.count - baselineHandles.count >= count,
        "OS handle measurement must observe at least one endpoint handle per dormant session",
      );
    }
    assert.deepEqual(
      activityAfterIdle,
      activityBeforeIdle,
      "dormant sessions must not create background activity while idle",
    );
    assert.ok(
      dormantCpu.cpuMs <= baselineCpu.cpuMs + IDLE_CPU_TOLERANCE_MS,
      `idle CPU ${dormantCpu.cpuMs.toFixed(2)} ms exceeded baseline ${baselineCpu.cpuMs.toFixed(2)} ms plus tolerance`,
    );

    const result = {
      count,
      rss: {
        baselineBytes: baselineRss,
        dormantBytes: dormantRss,
        incrementalBytes: Math.max(0, dormantRss - baselineRss),
      },
      handles: {
        source: dormantHandles.source,
        baseline: baselineHandles.count,
        dormant: dormantHandles.count,
        incremental: dormantHandles.count - baselineHandles.count,
      },
      startupLatencyMs: {
        total: hosts.reduce((sum, item) => sum + item.startupMs, 0),
        median: percentile(hosts.map((item) => item.startupMs), 0.5),
        p95: percentile(hosts.map((item) => item.startupMs), 0.95),
        max: Math.max(...hosts.map((item) => item.startupMs)),
      },
      idleCpu: {
        baselineMs: baselineCpu.cpuMs,
        dormantMs: dormantCpu.cpuMs,
        sampleMs: dormantCpu.elapsedMs,
        toleranceMs: IDLE_CPU_TOLERANCE_MS,
      },
      activityProxy: {
        beforeIdle: activityBeforeIdle,
        afterIdle: activityAfterIdle,
      },
      presenceBytes,
      remoteConnections: {
        initiated: remoteActivity.length,
        activeBefore: baselineRemoteSockets,
        activeDormant: dormantRemoteSockets,
      },
    };

    for (const item of hosts.reverse()) await item.host.close();
    hosts.length = 0;
    recordRemoteActivity = false;
    await settle();

    const cleanupResources = resourceCounts();
    const cleanupHandles = osHandleCount();
    const remainingRuntimeDirectories = existsSync(runtimeRoot)
      ? readdirSync(runtimeRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length
      : 0;
    assert.equal(remainingRuntimeDirectories, 0, "closing dormant sessions must remove every presence directory");
    assert.ok(
      resourceTotal(cleanupResources) <= resourceTotal(baselineResources),
      "closing dormant sessions must release their endpoint resources",
    );
    result.cleanup = {
      remainingRuntimeDirectories,
      handles: cleanupHandles.count,
      resources: cleanupResources,
      remoteSockets: activeRemoteSocketCount(),
    };
    assert.ok(
      cleanupHandles.count <= baselineHandles.count + 2,
      "closing dormant sessions must release their OS handles",
    );
    assert.equal(
      result.cleanup.remoteSockets,
      baselineRemoteSockets,
      "cleanup must not leave remote socket connections",
    );
    return result;
  } finally {
    hook.disable();
    for (const item of hosts.reverse()) await item.host.close();
    rmSync(baseDir, { recursive: true, force: true });
  }
}

function runIsolatedWorker(count) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--expose-gc",
      fileURLToPath(import.meta.url),
      "--worker",
      String(count),
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Dormant scale worker ${count} failed (${code}):\n${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Dormant scale worker ${count} returned invalid JSON: ${error.message}\n${stdout}`));
      }
    });
  });
}

export async function runDormantScaleHarness(counts = DEFAULT_COUNTS) {
  const results = [];
  for (const count of counts) results.push(await runIsolatedWorker(parseCount(count)));
  const twenty = results.find((result) => result.count === 20);
  if (twenty) {
    assert.ok(
      twenty.rss.incrementalBytes < TWENTY_SESSION_RSS_BUDGET_BYTES,
      `20 dormant sessions used ${(twenty.rss.incrementalBytes / 1_024 / 1_024).toFixed(2)} MB incremental RSS; budget is <5 MB`,
    );
  }
  return {
    budget: {
      sessionCount: 20,
      maxIncrementalRssBytesExclusive: TWENTY_SESSION_RSS_BUDGET_BYTES,
      excludes: "Node process baseline measured after module and count-matched endpoint warmup",
    },
    platform: process.platform,
    node: process.version,
    results,
  };
}

const workerIndex = process.argv.indexOf("--worker");
if (workerIndex !== -1) {
  const result = await runWorker(parseCount(process.argv[workerIndex + 1]));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = await runDormantScaleHarness();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// SPDX-License-Identifier: Apache-2.0
//
// ensureStationRunning(): the one operation behind `weft start`, the Control Center primary button
// and `weft update`. It observes the background Station (worker pipe + task definition), decides
// with the pure decideStationAction(), then starts, replaces or repairs exactly one worker. It never
// touches pairing files or device trust. Callers must hold the management lock
// (management.execute("station.start") does).
import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  backgroundCommand, backgroundInstallId, backgroundTaskOperation, forceStopBackground,
  readWorkerCrashReport, startBackground, stopBackground,
} from "./backgroundLifecycle.mjs";
import { isPidAlive } from "./registryFile.mjs";
import { appendStationLog, stationLogPath } from "./stationLog.mjs";
import { weftHome } from "./projects.mjs";
import { resolveVersion } from "./version.mjs";

export const STATION_SILENCE_LIMIT_MS = 15_000;
export const STATION_LOCAL_READY_TIMEOUT_MS = 30_000;
export const STATION_QUIESCE_TIMEOUT_MS = 10_000;

/**
 * Pure decision used by ensureStationRunning and the Control Center button. Self-contained (no
 * outer references) because Control Center serializes it into the page script.
 *
 * observed: { state, version, installId, silentMs, pid, taskInstallId, expected: { version, installId } }
 * state is a Station workload state: "stopped", "foreground", "crash-looping", "failed",
 * "unresponsive" (task running, pipe silent), "stopping", or any state a worker answers with.
 */
export function decideStationAction(observed) {
  const silenceLimitMs = 15000;
  const value = observed || {};
  const expected = value.expected || {};
  const state = String(value.state || "stopped");
  if (state === "foreground") {
    return { action: "foreground", pid: value.pid ?? null, label: "Station runs in a terminal" };
  }
  if (state === "stopped") {
    return {
      action: "start", label: "Start Station",
      replaceDefinition: Boolean(value.taskInstallId && expected.installId && value.taskInstallId !== expected.installId),
    };
  }
  if (state === "crash-looping" || state === "failed") return { action: "repair", reason: "crash-looping", label: "Repair Station" };
  if (state === "unresponsive") {
    return typeof value.silentMs === "number" && value.silentMs < silenceLimitMs
      ? { action: "wait", label: "Checking Station…" }
      : { action: "force-restart", reason: "unresponsive", label: "Repair Station" };
  }
  if (state === "stopping") return { action: "wait", label: "Checking Station…" };
  if (value.version !== expected.version) {
    const from = value.version || "unknown";
    return { action: "replace", reason: "update", from, to: expected.version ?? null, label: "Restart to update (" + from + " → " + expected.version + ")" };
  }
  if (expected.installId && value.installId !== expected.installId) {
    return { action: "replace", reason: "different-install", from: value.version, to: expected.version, label: "Repair Station" };
  }
  return { action: "already-running", label: "Running ✓" };
}

/** What a Station started from this CLI would report: the build version and installation identity. */
export function expectedStationIdentity(cliPath) {
  return { version: resolveVersion(), installId: backgroundInstallId({ cliPath }) };
}

export class StationEnsureError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}

/** Foreground `weft start` process that owns listener.lock, or null. */
export function foregroundStationPid(baseDir = weftHome()) {
  let pid;
  try { pid = Number.parseInt(readFileSync(join(baseDir, "listener.lock"), "utf8"), 10); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  return isPidAlive(pid) ? pid : null;
}

/** Stop a foreground Station after the user confirmed it in a terminal. */
export async function stopForegroundStation(pid, {
  kill = (target) => process.kill(target), isAlive = isPidAlive,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)), now = Date.now, timeoutMs = 10_000,
} = {}) {
  try { kill(pid); } catch (error) { if (error.code !== "ESRCH") throw error; }
  const deadline = now() + timeoutMs;
  while (isAlive(pid) && now() < deadline) await sleep(100);
  if (isAlive(pid)) throw new StationEnsureError("foreground-still-running", `The terminal Station (PID ${pid}) did not exit. Close it with Ctrl+C, then run weft start again.`, { pid });
}

const isNetworkReady = (state) => ["ready", "endpoint-refresh-needed"].includes(state);

function summarize(outcome, decision, status, extra = {}) {
  return {
    outcome, action: decision.action, reason: decision.reason ?? null,
    from: decision.from ?? null, to: decision.to ?? null,
    state: status?.state ?? null, stage: status?.stage ?? null, deviceName: status?.deviceName ?? null,
    paired: status?.paired === true, phoneName: status?.phoneName ?? null, connected: status?.connected ?? null,
    version: status?.version ?? null, installId: status?.installId ?? null,
    pid: status?.pid ?? null, startedAt: status?.startedAt ?? null, baseUrl: status?.baseUrl ?? null,
    local: status ? "ready" : "unknown",
    network: isNetworkReady(status?.state) && !status?.networkPending ? "ready" : "connecting",
    ...extra,
  };
}

export async function ensureStationRunning({
  reason = "start", replaceForeground = false, onProgress = null,
  baseDir = weftHome(), cliPath,
  expected = expectedStationIdentity(cliPath),
  background = {},
  prepare = async () => {},
  readForeground = () => foregroundStationPid(baseDir),
  stopForeground = (pid) => stopForegroundStation(pid),
  crashReport = (options) => readWorkerCrashReport("station", { baseDir, ...options }),
  now = Date.now,
  sleep = (ms) => new Promise((done) => setTimeout(done, ms)),
  pollIntervalMs = 500,
  silenceLimitMs = STATION_SILENCE_LIMIT_MS,
  localTimeoutMs = STATION_LOCAL_READY_TIMEOUT_MS,
  networkTimeoutMs = 60_000,
  log = (event, fields, level = "info") => appendStationLog(event, fields, { baseDir, level }),
} = {}) {
  const options = { baseDir, cliPath };
  const ops = {
    command: background.command ?? backgroundCommand,
    task: background.task ?? backgroundTaskOperation,
    start: background.start ?? startBackground,
    stop: background.stop ?? stopBackground,
    forceStop: background.forceStop ?? forceStopBackground,
  };
  const step = (stage, label, fields = {}) => onProgress?.({ step: true, stage, label, ...fields });

  async function observe() {
    const worker = await ops.command("station", "status", null, options);
    if (worker) {
      const crash = crashReport({ workerStartedAt: worker.startedAt });
      const state = crash?.repeated && worker.state !== "ready" ? "crash-looping" : worker.state;
      return { state, version: worker.version ?? null, installId: worker.installId ?? null, pid: worker.pid ?? null, worker, crash, expected };
    }
    const foreground = readForeground();
    if (foreground) return { state: "foreground", pid: foreground, expected };
    const task = await ops.task("status", { ...options, role: "station" });
    const crash = crashReport({});
    const state = task?.state === "Running" ? crash?.repeated ? "crash-looping" : "unresponsive" : "stopped";
    return { state, task, crash, taskInstallId: task?.installId ?? null, expected };
  }

  step("checking-station", "Checking Station…");
  const observedAt = now();
  let silentSince = null;
  let observed;
  let decision;
  for (;;) {
    observed = await observe();
    if (observed.state === "unresponsive") {
      silentSince ??= now();
      observed.silentMs = now() - silentSince;
    } else silentSince = null;
    decision = decideStationAction(observed);
    if (decision.action !== "wait") break;
    if (now() - observedAt > silenceLimitMs + localTimeoutMs) {
      throw new StationEnsureError("station-busy", "Station is still stopping. Wait a moment, then run weft start again.");
    }
    await sleep(pollIntervalMs);
  }
  step("station-version", observed.worker
    ? `Installed version ${expected.version} · Station running ${observed.version ?? "an unknown version"}`
    : `Installed version ${expected.version}`, { installed: expected.version, running: observed.version ?? null });
  log("station.ensure", { reason, action: decision.action, why: decision.reason ?? null, from: decision.from ?? null, to: decision.to ?? null });

  if (decision.action === "already-running") return summarize("already-running", decision, observed.worker);
  if (decision.action === "foreground" && !replaceForeground) {
    throw new StationEnsureError("foreground-owned",
      `Station is running in a terminal (PID ${decision.pid}). Stop it there, or run weft start in a terminal to replace it.`,
      { pid: decision.pid });
  }

  await prepare();
  const previousCrash = observed.crash ?? null;
  if (previousCrash) log("station.ensure_previous_crash", { count: previousCrash.quickCrashesInARow, code: previousCrash.exit?.code, error: previousCrash.lastError?.name ?? null }, "warn");
  let outcome = "started";
  if (decision.action === "foreground") {
    step("replacing-foreground", `Stopping the terminal Station (PID ${decision.pid})…`);
    await stopForeground(decision.pid);
    outcome = "replaced-foreground";
  } else if (decision.action === "replace") {
    step("restarting-station", decision.reason === "update"
      ? `Restarting Station on ${expected.version} (was ${decision.from})…`
      : "Restarting Station from this installation…");
    await ops.stop("station", options, { timeoutMs: STATION_QUIESCE_TIMEOUT_MS });
    outcome = "restarted";
  } else if (decision.action === "force-restart") {
    step("repairing-station", "Station is not responding; restarting it…");
    await ops.forceStop("station", options);
    outcome = "repaired";
  } else if (decision.action === "repair") {
    step("repairing-station", "Station keeps crashing; restarting it once…");
    await ops.stop("station", options, { timeoutMs: STATION_QUIESCE_TIMEOUT_MS });
    outcome = "repaired";
  } else if (decision.replaceDefinition) {
    await ops.task("stop", { ...options, role: "station" });
  }
  if (decision.action === "start" || decision.action === "foreground") step("starting-station", "Starting Station…");

  const startedAt = now();
  let announcedConnecting = false;
  let status;
  try {
    status = await ops.start("station", options, {
      localTimeoutMs, timeoutMs: localTimeoutMs + networkTimeoutMs, allowNetworkPending: true,
      onProgress: (workerStatus) => {
        if (!announcedConnecting && !isNetworkReady(workerStatus?.state)) {
          announcedConnecting = true;
          step("connecting-relay", "Connecting relay…");
        }
      },
    });
  } catch (error) {
    const crash = crashReport({});
    const logPath = stationLogPath({ baseDir });
    if (crash && crash.lastCrashAt >= startedAt || decision.action === "repair") {
      const last = crash?.lastError ?? previousCrash?.lastError ?? null;
      throw new StationEnsureError("station-crashing",
        `Station crashed again after restarting.${last ? ` Last error: ${last.name}: ${last.message}` : ` ${error.message}`} See ${logPath}.`,
        { lastError: last, logPath, cause: error });
    }
    throw error;
  }
  log("station.ensure_completed", { reason, outcome, version: status?.version ?? null, network: isNetworkReady(status?.state) && !status?.networkPending ? "ready" : "connecting" });
  return summarize(outcome, decision, status, { previousCrash });
}

/** Human-friendly duration for the Station summary. */
export function formatUptime(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "just started";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Summary block shared by `weft start` and `weft status`. */
export function stationSummaryLines(summary, { now = Date.now() } = {}) {
  const headline = summary.outcome === "already-running" ? "✓ Weft Station is already running — nothing to restart."
    : summary.outcome === "restarted" ? `✓ Weft Station restarted on ${summary.version ?? summary.to}${summary.from ? ` (was ${summary.from})` : ""}.`
      : summary.outcome === "repaired" ? "✓ Weft Station was repaired and is running."
        : summary.outcome === "status" ? "Weft Station is running."
          : "✓ Weft Station is running.";
  const phone = !summary.paired ? "not paired"
    : `${summary.phoneName ? `${summary.phoneName} ` : ""}paired · ${summary.connected === true ? "connected" : "not connected right now"}`;
  return [
    headline,
    `  Device   ${summary.deviceName ?? "this computer"}`,
    `  Version  ${summary.version ?? "not reported"}`,
    `  Uptime   ${Number.isFinite(summary.startedAt) ? formatUptime(now - summary.startedAt) : "not reported"}`,
    `  Phone    ${phone}`,
    `  Relay    ${summary.network === "ready" ? "connected" : "connecting… (Station is up locally; it keeps retrying)"}`,
    "  Manage   weft status · weft stop · weft ui",
  ];
}

/**
 * Remove `node_modules/.node-pty.*.backup` folders left when an update could not delete the old
 * native runtime (for example EPERM while a running worker still had it loaded). Best-effort.
 */
export function cleanupNodePtyBackups(installDir, { remove = (path) => rmSync(path, { recursive: true, force: true }) } = {}) {
  const folder = join(installDir, "node_modules");
  let names;
  try { names = readdirSync(folder); }
  catch (error) { if (error.code === "ENOENT") return { removed: [], remaining: [] }; throw error; }
  const removed = [];
  const remaining = [];
  for (const name of names.filter((entry) => /^\.node-pty\..+\.backup$/.test(entry))) {
    try { remove(join(folder, name)); removed.push(name); }
    catch (error) { remaining.push({ name, code: error.code ?? error.name }); }
  }
  return { removed, remaining };
}

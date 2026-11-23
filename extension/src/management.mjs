// SPDX-License-Identifier: Apache-2.0
import { open, mkdir, readFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import QRCode from "qrcode";
import { pairingQrText } from "./pairingLink.mjs";
import { weftHome, listProjects, addProject, removeProject, setDefault } from "./projects.mjs";
import {
  loadTransportConfig, loadDeviceName, loadDefaultPermissionMode, isPersistentPairingEnabled,
  isTerminalEnabled, loadFileSharingConfig, saveManagementSettings, loadSupabaseCredentials,
  isDiagnosticLoggingEnabled,
} from "./transportConfig.mjs";
import { rotatePersistedIdentity, clearPersistedIdentity, getOrCreatePersistedIdentity, readSavedPairing } from "./pairingIdentity.mjs";
import {
  backgroundCommand, backgroundTaskOperation, startBackground, stopBackground, forceStopBackground, backgroundInstallId,
  readWorkerCrashReport, readUnexpectedTaskExit, describeWorkerProblem,
} from "./backgroundLifecycle.mjs";
import { ensureStationRunning } from "./ensureStation.mjs";
import {
  healthyRegistryEntry, probePublicRelay, findDevTunnelBinary, isDevTunnelLoggedIn,
  ensureDevTunnelLogin, DEVTUNNEL_REGISTRY_FILE, describeStage, readDevTunnelAuthentication,
} from "./devtunnel.mjs";
import { readRegistry, isPidAlive } from "./registryFile.mjs";
import { scanSessions } from "./sessionRegistry.mjs";
import { createSessionControlClient } from "./sessionControl.mjs";
import { sessionHealth } from "@aasis21/weft-shared";
import { resolveVersion } from "./version.mjs";
import { readStationDiagnostics, appendStationLog } from "./stationLog.mjs";

export class ManagementError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const actions = {
  "station.start": ["reason", "replaceForeground"], "station.stop": ["confirmed"], "station.restart": ["confirmed"],
  "relay.start": [], "relay.stop": ["confirmed"], "relay.restart": ["confirmed"],
  "project.add": ["name", "path", "makeDefault"],
  "project.remove": ["name", "confirmed"], "project.default": ["name"],
  "settings.save": ["deviceName", "permissionMode", "pairingMode", "terminalEnabled", "loggingEnabled", "files", "transport", "confirmed", "expectedRevision"],
  "pairing.replace": ["confirmed"],
  "pairing.rotate": ["confirmed"],
  "session.activate": ["runtimeId"], "session.disconnect": ["runtimeId", "confirmed"],
  "session.start": ["projectName", "name", "mode", "confirmed"],
  "sessions.reloadAll": ["confirmed", "source", "installedVersion"],
};

/** First Weft version whose sessions can hold a reload until their current turn ends. */
const RELOAD_WHEN_IDLE_SINCE = "0.2.76";

function versionAtLeast(version, minimum) {
  const parts = (value) => String(value ?? "").split(/[.+-]/).slice(0, 3).map((part) => Number.parseInt(part, 10));
  const have = parts(version);
  if (have.length < 3 || have.some(Number.isNaN)) return false;
  const need = parts(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== need[index]) return have[index] > need[index];
  }
  return true;
}
export function validateManagementAction(action, payload) {
  if (!Object.hasOwn(actions, action)) throw new ManagementError("invalid-action", "This management action is not supported.");
  if (!payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).some((key) => !actions[action].includes(key))) {
    throw new ManagementError("invalid-input", "Invalid management request fields.");
  }
  for (const key of ["name", "path", "runtimeId", "projectName"]) {
    if (action === "session.start" && key === "name" && payload.name === undefined) continue;
    if (actions[action].includes(key) && (typeof payload[key] !== "string" ||
        !payload[key].trim() || payload[key].length > (key === "path" ? 2048 : 256) || /[\0\r\n]/.test(payload[key]))) {
      throw new ManagementError("invalid-input", `A valid ${key} is required.`);
    }
  }
  if (action === "project.add" && !isAbsolute(payload.path)) throw new ManagementError("invalid-input", "Use an absolute folder path.");
  if (payload.makeDefault !== undefined && typeof payload.makeDefault !== "boolean") throw new ManagementError("invalid-input", "Invalid default selection.");
  if (payload.confirmed !== undefined && typeof payload.confirmed !== "boolean") throw new ManagementError("invalid-input", "Invalid confirmation.");
  if (payload.reason !== undefined && !["start", "update", "control-center"].includes(payload.reason)) throw new ManagementError("invalid-input", "Invalid start reason.");
  if (payload.source !== undefined && payload.source !== "update") throw new ManagementError("invalid-input", "Invalid reload source.");
  if (payload.installedVersion !== undefined && (typeof payload.installedVersion !== "string" || !/^\d+\.\d+\.\d+[\w.+-]{0,40}$/.test(payload.installedVersion))) throw new ManagementError("invalid-input", "Invalid installed version.");
  if (payload.replaceForeground !== undefined && typeof payload.replaceForeground !== "boolean") throw new ManagementError("invalid-input", "Invalid foreground replacement.");
  if (payload.mode !== undefined && !["default", "allow-all"].includes(payload.mode)) throw new ManagementError("invalid-input", "Invalid session permission mode.");
  if (action === "session.start" && payload.mode === "allow-all" && payload.confirmed !== true) throw new ManagementError("confirmation-required", "Confirm launching Copilot with Allow all permissions.");
  if (["station.stop", "station.restart", "relay.stop", "relay.restart", "project.remove", "pairing.replace", "pairing.rotate", "session.disconnect", "sessions.reloadAll"].includes(action) && payload.confirmed !== true) {
    throw new ManagementError("confirmation-required", "Confirm the action and its impact before continuing.");
  }
}

export async function withManagementLock(baseDir, run, { timeoutMs = 200_000 } = {}) {
  await mkdir(baseDir, { recursive: true, mode: 0o700 });
  const path = join(baseDir, "management.lock");
  const token = randomUUID();
  const deadline = Date.now() + timeoutMs;
  let handle;
  while (!handle) {
    try {
      handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(JSON.stringify({ pid: process.pid, token })); }
      catch (error) { await handle.close(); await unlink(path); throw error; }
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      // Do not reclaim stale locks automatically: deleting a lock is not an atomic
      // compare-and-swap and could remove a concurrent operation's new lock.
      let owner;
      try { owner = JSON.parse(await readFile(path, "utf8")); }
      catch (failure) {
        if (failure.code === "ENOENT") continue;
        if (!(failure instanceof SyntaxError)) throw failure;
        if (Date.now() >= deadline) throw new ManagementError("invalid-lock", "The management lock is incomplete or corrupt. Inspect it before retrying.");
      }
      if (owner?.pid && !isPidAlive(owner.pid)) {
        throw new ManagementError("interrupted-operation", "A previous management process stopped unexpectedly. Inspect management.lock in the Weft data folder before removing that stale lock.");
      }
      if (Date.now() >= deadline) throw new ManagementError("operation-busy", "Another Weft management operation is still running. Check its status before retrying.");
      await sleep(100);
    }
  }
  try { return await run(); }
  finally {
    await handle.close();
    const owner = JSON.parse(await readFile(path, "utf8"));
    if (owner.token !== token) throw new ManagementError("ownership-changed", "Management lock ownership changed.");
    await unlink(path);
  }
}

export function createManagement({
  baseDir = weftHome(), cliPath, platform = process.platform,
  background = { command: backgroundCommand, task: backgroundTaskOperation, start: startBackground, stop: stopBackground, forceStop: forceStopBackground },
  scan = scanSessions, sessionClient = createSessionControlClient,
  relayHealth = healthyRegistryEntry, publicProbe = probePublicRelay,
  authentication = readDevTunnelAuthentication,
  statusProbeTimeoutMs = 4_000,
} = {}) {
  baseDir = resolve(baseDir);
  const options = { baseDir, cliPath };
  // Task Scheduler (PowerShell) and session identity probes can take tens of seconds on a busy
  // Windows host. Each probe kind runs at most once at a time; status polls join the in-flight
  // probe but wait only a bounded time, and a late result still refreshes the last-known value.
  const PROBE_PENDING = Symbol("probe-pending");
  const probesInFlight = new Map();
  const lastProbeResults = new Map();
  function boundedProbe(key, run) {
    let probe = probesInFlight.get(key);
    if (!probe) {
      probe = Promise.resolve().then(run)
        .then((value) => { lastProbeResults.set(key, value); return value; })
        .finally(() => { probesInFlight.delete(key); });
      probe.catch(() => {});
      probesInFlight.set(key, probe);
    }
    let timer;
    const bound = new Promise((done) => { timer = setTimeout(() => done(PROBE_PENDING), statusProbeTimeoutMs); });
    timer.unref?.();
    return Promise.race([probe, bound]).finally(() => clearTimeout(timer));
  }
  const settings = () => ({
    transport: loadTransportConfig(options),
    deviceName: loadDeviceName(options), permissionMode: loadDefaultPermissionMode(options),
    pairingMode: isPersistentPairingEnabled(options) ? "persistent" : "ephemeral",
    terminalEnabled: isTerminalEnabled(options), files: loadFileSharingConfig(options),
    loggingEnabled: isDiagnosticLoggingEnabled(options),
  });
  const settingsRevision = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const supportsBackgroundWorkloads = () => ["win32", "darwin"].includes(platform);
  const requireBackgroundWorkloads = () => {
    if (!supportsBackgroundWorkloads()) {
      throw new ManagementError("unsupported-host", "Background workload controls require Windows or macOS. Use foreground CLI commands on this platform.");
    }
  };
  const ensureNotForeground = (role) => {
    if (role !== "station") return;
    let pid;
    try { pid = Number.parseInt(readFileSync(join(baseDir, "listener.lock"), "utf8"), 10); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (isPidAlive(pid)) return background.command("station", "status", null, options).then((status) => {
      if (!status) throw new ManagementError("foreground-owned", "Station is owned by a foreground terminal. Stop it there before changing its lifecycle.");
    });
  };
  async function prepareRelay({ interactive = false, report = () => {} } = {}) {
    if (await relayHealth(undefined, { baseDir, verifyPublic: true })) return;
    const registry = readRegistry(DEVTUNNEL_REGISTRY_FILE, options);
    if (registry && registry.alive !== false && isPidAlive(registry.pid) && !(await background.command("relay", "status", null, options))) {
      throw new ManagementError("foreground-owned", "The relay is owned by a foreground terminal. Manage it there.");
    }
    report("checking-cli");
    const bin = await findDevTunnelBinary();
    if (!bin) throw new ManagementError("missing-devtunnel", "The Dev Tunnel CLI was not found or did not respond to devtunnel --version within 30 seconds. Check it in a terminal, then retry.");
    report("checking-sign-in");
    if (interactive) await ensureDevTunnelLogin(bin, { onProgress: report });
    else if (!(await isDevTunnelLoggedIn(bin))) throw new ManagementError("sign-in-required", "Run devtunnel user login -g in a terminal, then retry. Browser startup never waits on terminal input.");
  }
  async function workloads() {
    const result = {};
    await Promise.all(["station", "relay"].map(async (role) => {
      if (!supportsBackgroundWorkloads()) { result[role] = { state: "unsupported", supported: false }; return; }
      try { await roleStatus(role, result); }
      catch (error) {
        statusPartFailed(role, error);
        result[role] = { state: "unknown", supported: true, error: "Status for this workload could not be verified. Refresh before starting or stopping it." };
      }
    }));
    await relayStatus(result);
    if (supportsBackgroundWorkloads() && result.station.state === "stopped") {
      let pid;
      try { pid = Number.parseInt(readFileSync(join(baseDir, "listener.lock"), "utf8"), 10); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (isPidAlive(pid)) result.station = { state: "foreground", supported: false, pid, error: "Station is owned by a terminal. Manage it there." };
    }
    return result;
  }
  // Log each crash loop and each unexpected task exit once, not on every 5-second status poll.
  const reportedWorkerProblems = new Set();
  function reportWorkerProblemOnce(key, event, fields) {
    if (reportedWorkerProblems.has(key)) return;
    reportedWorkerProblems.add(key);
    appendStationLog(event, fields, { baseDir, level: "warn" });
  }
  let lastPresences = null;
  // Supervisor health per runtime, as last reported by a running Station (null: none reporting).
  let stationSessions = null;
  // Merge the in-memory phone traffic of Station and active sessions. Session discovery is reused
  // from the dashboard's own status polling, so this stays cheap enough to refresh every 2 seconds.
  async function traffic() {
    const sources = [];
    const entries = [];
    const collect = (source, kind, result) => {
      const list = Array.isArray(result?.entries) ? result.entries.slice(-100) : [];
      for (const entry of list) entries.push({ ...entry, id: `${kind}:${source.id}:${entry.id}`, source: source.name, sourceKind: kind });
      sources.push({ ...source, kind, state: "reporting", count: list.length });
    };
    if (supportsBackgroundWorkloads()) {
      try {
        const result = await background.command("station", "traffic", null, { ...options, timeoutMs: 3000 });
        if (result) collect({ id: "station", name: "Station" }, "station", result);
        else sources.push({ id: "station", name: "Station", kind: "station", state: "stopped" });
      } catch {
        sources.push({ id: "station", name: "Station", kind: "station", state: "unsupported" });
      }
    }
    if (!lastPresences) {
      try { lastPresences = (await scan({ baseDir, cleanup: false })).live ?? []; }
      catch { lastPresences = []; }
    }
    await Promise.all(lastPresences.slice(0, 20).map(async (record, index) => {
      const fallback = `Copilot session ${index + 1}`;
      const runtimeId = record.run.runtimeId;
      try {
        const result = await sessionClient(record, { baseDir }).command("traffic", null, { timeoutMs: 1500 });
        const title = typeof result?.title === "string" && result.title.trim()
          ? result.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : fallback;
        collect({ id: runtimeId, name: title }, "session", result);
      } catch {
        sources.push({ id: runtimeId, name: fallback, kind: "session", state: "unsupported" });
      }
    }));
    entries.sort((a, b) => b.lastAt - a.lastAt);
    const recent = Date.now() - 5 * 60_000;
    const lastFromPhone = entries.find((entry) => entry.direction === "in")?.lastAt ?? null;
    return {
      enabled: isDiagnosticLoggingEnabled(options), checkedAt: Date.now(), sources,
      summary: {
        received: entries.filter((e) => e.direction === "in" && e.lastAt >= recent).reduce((n, e) => n + e.count, 0),
        sent: entries.filter((e) => e.direction === "out" && e.lastAt >= recent).reduce((n, e) => n + e.count, 0),
        lastFromPhone,
        problems: entries.filter((e) => ["failed", "no-reply"].includes(e.result)).length,
      },
      entries: entries.slice(0, 100),
    };
  }
  function statusPartFailed(phase, error) {
    appendStationLog("ui.status_part_failed", { phase, code: error?.code ?? error?.name ?? "Error" }, { baseDir, level: "warn" });
  }
  async function roleStatus(role, result) {
    const controlRecord = readRegistry(`background-${role}.json`, options);
    // A registry record left by a worker that already exited cannot answer; skip contacting it.
    const workerExited = Number.isSafeInteger(controlRecord?.pid) && controlRecord.pid > 0 && !isPidAlive(controlRecord.pid);
    const workerStatus = workerExited ? null : await background.command(role, "status", null, options);
    if (role === "station" && !workerStatus) stationSessions = null;
    if (workerStatus) {
      const { state, error, paired, phoneName, deviceName, baseUrl, pid, startedAt, version, installId,
        connected, lastPeerContactAt, watchLevel, stage, progressAt, attempt, nextRetryAt,
        nextCheckAt, lastHealthyAt, localHealth, forwarding, checkedAt, transportState, transportCheckedAt, transportKind, transportEndpoint } = workerStatus;
      result[role] = { state, error, paired, phoneName, deviceName, baseUrl, pid, startedAt, version, installId,
        connected, lastPeerContactAt, watchLevel, stage, progressAt, attempt, nextRetryAt,
        nextCheckAt, lastHealthyAt, localHealth, forwarding, checkedAt, transportState, transportCheckedAt, transportKind, transportEndpoint,
        stageLabel: stage ? describeStage(stage) : null, supported: true };
      if (role === "station") {
        result[role].checkedAt = Date.now();
        stationSessions = Array.isArray(workerStatus.sessions) ? workerStatus.sessions : null;
      }
      const currentRecord = readRegistry(`background-${role}.json`, options);
      if (controlRecord?.identity?.runtimeInstanceId &&
          controlRecord.identity.runtimeInstanceId === currentRecord?.identity?.runtimeInstanceId) {
        result[role].pid ??= controlRecord.pid;
        result[role].startedAt ??= controlRecord.processStartedAt;
      }
      attachCrashReport(role, result[role]);
      return;
    }
    const label = role === "station" ? "Station" : "The relay";
    let task = await boundedProbe(`task:${role}`, () => background.task("status", { ...options, role }));
    const checking = task === PROBE_PENDING;
    if (checking) {
      task = lastProbeResults.get(`task:${role}`);
      if (!task) {
        result[role] = workerExited
          ? { state: "stopped", supported: true, checking: true, staleWorker: true,
            error: `${label}'s last worker is no longer running. Background task status is still being checked.` }
          : { state: "unknown", supported: true, checking: true,
            error: `${label} status is still being checked. Refresh in a few seconds before starting or stopping it.` };
        return;
      }
    }
    result[role] = { state: task.state === "Running" ? "unresponsive" : "stopped", supported: true,
      ...(checking ? { checking: true } : {}), ...(workerExited ? { staleWorker: true } : {}) };
    if (task.state === "Running") {
      // Between crashes the worker is down while the supervisor waits to restart it.
      attachCrashReport(role, result[role]);
      return;
    }
    const unexpectedStop = readUnexpectedTaskExit(role, task, { baseDir });
    if (unexpectedStop) {
      result[role].unexpectedStop = unexpectedStop;
      result[role].error = describeWorkerProblem(role, { unexpectedStop });
      reportWorkerProblemOnce(`${role}:stop:${unexpectedStop.exit.code}`, "worker.unexpected_stop", { role, code: unexpectedStop.exit.code });
    }
  }
  function attachCrashReport(role, workload) {
    const crash = readWorkerCrashReport(role, { baseDir, workerStartedAt: workload.startedAt });
    if (!crash) return;
    workload.crash = crash;
    if (!crash.repeated) return;
    // A worker that reached ready is up again; otherwise it is stuck crashing and restarting.
    if (workload.state !== "ready") workload.state = "crash-looping";
    workload.error = describeWorkerProblem(role, { crash });
    reportWorkerProblemOnce(`${role}:loop:${crash.streakStartedAt}`, "worker.crash_loop",
      { role, count: crash.quickCrashesInARow, code: crash.exit.code, error: crash.lastError?.name });
  }
  async function relayStatus(result) {
    if (!result.relay) return;
    try {
      const registry = readRegistry(DEVTUNNEL_REGISTRY_FILE, options);
      if (!(registry?.alive !== false && isPidAlive(registry?.pid))) return;
      const health = await relayHealth(undefined, { baseDir });
      const { unexpectedStop, ...current } = result.relay;
      result.relay = { ...current, state: health ? "ready" : "unhealthy", error: unexpectedStop ? undefined : current.error,
        managerPid: result.relay.pid, managerStartedAt: result.relay.startedAt,
        pid: registry.pid, startedAt: registry.startedAt ?? null, baseUrl: registry.baseUrl, localHealth: health ? "ok" : "unhealthy" };
      if (health) {
        const forwarding = await publicProbe(registry.baseUrl);
        result.relay.forwarding = forwarding;
        result.relay.checkedAt = Date.now();
        if (forwarding === "ok") result.relay.lastHealthyAt = result.relay.checkedAt;
        if (forwarding === "rejected") result.relay = { ...result.relay, state: "degraded", error: "Local relay is running, but public forwarding is unavailable. The manager will try recovery." };
        if (forwarding === "unreachable") result.relay = { ...result.relay, state: "waiting-network", error: "Public forwarding could not be reached. Check network connectivity." };
      }
    } catch (error) {
      statusPartFailed("relay-health", error);
      result.relay = { ...result.relay, forwarding: "unknown", error: result.relay.error ?? "Relay health could not be verified. Refresh status." };
    }
  }
  // Live sessions come from their own records (sessionRegistry); health comes from Station's
  // supervisor when it is running, otherwise from the same shared projection over the record alone.
  async function runtimes() {
    const scanned = await scan({ baseDir, cleanup: false });
    lastPresences = scanned.live ?? [];
    const conflicted = new Set((scanned.sessions ?? []).filter((group) => group.ownerConflict)
      .flatMap((group) => group.runtimes.map((record) => record.run.runtimeId)));
    const supervised = new Map((stationSessions ?? []).map((item) => [item.runtimeId, item]));
    const discovery = {
      status: conflicted.size ? "conflict" : (scanned.unverified?.length || scanned.foreign?.length) ? "uncertain" : "verified",
    };
    return { discovery, list: await Promise.all(lastPresences.map(async (record) => {
      const runtimeId = record.run.runtimeId;
      const observed = supervised.get(runtimeId);
      const health = observed ?? sessionHealth(record, {
        observer: "station", processAlive: true, ...(conflicted.has(runtimeId) ? { ownerConflict: true } : {}),
      });
      const base = {
        runtimeId, sessionId: record.session.sessionId, pid: record.run.pid,
        state: record.link.state, label: health.label, reason: health.reason ?? null,
        lastRepair: observed?.lastRepair ?? null, cwd: record.run.cwd, version: record.run.version,
        lastPeerContactAt: record.link.lastPhoneContactAt ?? null,
      };
      try {
        const s = await sessionClient(record, { baseDir }).command("status", null, { timeoutMs: 1000 });
        return {
          ...base, paired: s?.paired, phoneName: s?.phoneName,
          connected: base.state === "linked" ? (typeof s?.connected === "boolean" ? s.connected : null) : false,
          watchLevel: base.state === "dormant" ? "off" : s?.watchLevel ?? null, title: s?.title ?? null,
          cwd: s?.cwd ?? base.cwd, version: s?.version ?? base.version,
          lastPeerContactAt: s?.lastPeerContactAt ?? base.lastPeerContactAt, busy: s?.busy ?? null,
        };
      } catch {
        return { ...base, connected: null, watchLevel: null, error: "Live session status unavailable." };
      }
    })) };
  }
  async function target(runtimeId) {
    const scanned = await scan({ baseDir, cleanup: false });
    const record = scanned.live?.find((item) => item.run.runtimeId === runtimeId);
    if (!record) throw new ManagementError("stale-session", "This session is no longer available. Refresh the session list.");
    if ((scanned.sessions ?? []).some((group) => group.ownerConflict && group.runtimes.some((item) => item.run.runtimeId === runtimeId))) {
      throw new ManagementError("runtime-conflict", "Two Copilot processes claim this session. Close one before controlling it.");
    }
    return sessionClient(record, { baseDir });
  }
  async function sessionCommand(client, command, payload, timeoutMs) {
    try {
      return await client.command(command, payload, { timeoutMs });
    } catch (error) {
      throw new ManagementError(error?.code ?? "session-failed", error?.message ?? "Session operation failed.");
    }
  }
  async function execute(action, payload = {}, { interactive = false, trustedCli = false, operationId, onProgress } = {}) {
    validateManagementAction(action, payload);
    const started = Date.now();
    const operation = createHash("sha256").update(operationId ?? randomUUID()).digest("hex").slice(0, 12);
    const log = (event, fields, level = "info") => appendStationLog(event, {
      operation, phase: action, ...fields,
    }, { baseDir, level });
    log("management.requested", { pid: process.pid });
    const report = (stage, fields = {}) => onProgress?.({ stage, label: describeStage(stage), progressAt: Date.now(), ...fields });
    const startRole = async (role) => {
      report(`starting-${role}`);
      return background.start(role, options, { onProgress: (status) => report(status.stage ?? `starting-${role}`, {
        attempt: status.attempt, progressAt: status.progressAt ?? Date.now(), nextRetryAt: status.nextRetryAt,
      }) });
    };
    if (action.startsWith("station.") || action.startsWith("relay.")) report("waiting-management");
    return withManagementLock(baseDir, async () => {
      if (action.startsWith("project.")) {
        if (action === "project.add") return addProject(payload.name, payload.path, { ...options, makeDefault: payload.makeDefault === true });
        if (action === "project.remove") return removeProject(payload.name, options);
        return setDefault(payload.name, options);
      }
      if (action === "settings.save") {
        const old = settings();
        if (payload.expectedRevision !== undefined && payload.expectedRevision !== settingsRevision(old)) {
          throw new ManagementError("settings-conflict", "Settings changed in another window or CLI. Refresh and review your edits before saving.");
        }
        if (!trustedCli && payload.confirmed !== true && (
          payload.permissionMode === "allow-all" && old.permissionMode !== "allow-all" ||
          payload.pairingMode !== undefined && payload.pairingMode !== old.pairingMode ||
          payload.transport !== undefined && payload.transport.kind !== (old.transport?.kind ?? "clear") ||
          payload.terminalEnabled === true && !old.terminalEnabled ||
          payload.files?.enabled === true && JSON.stringify(payload.files) !== JSON.stringify(old.files)
        )) throw new ManagementError("confirmation-required", "Confirm the settings change, including remote access and restart requirements.");
        try { saveManagementSettings(payload, options); }
        catch (error) { throw new ManagementError("invalid-settings", error.message); }
        if (payload.pairingMode === "ephemeral") clearPersistedIdentity(options);
        if (payload.pairingMode === "persistent") await getOrCreatePersistedIdentity(options);
        return { settings: settings(), message: "Settings saved. Restart affected workers/sessions to apply lifecycle settings; Files policy is checked on each request." };
      }
      if (action === "session.start") {
        const response = await background.command("station", "activate", {
          requestId: operationId ?? randomUUID(),
          target: { project: payload.projectName },
          options: { permissionMode: payload.mode ?? "default", ...(payload.name ? { title: payload.name } : {}) },
        }, { ...options, timeoutMs: 55_000 });
        if (!response) throw new ManagementError("station-required", "Start Station before launching a new Copilot session.");
        if (response.outcome && response.outcome !== "done") {
          throw new ManagementError(response.reason ?? response.outcome, response.result?.message ?? `The session request ended: ${response.outcome}.`);
        }
        const pairingPayload = response.result?.payload ?? null;
        const code = pairingPayload ? pairingQrText(pairingPayload) : null;
        return {
          state: response.outcome ?? response.stage, runtimeId: response.result?.runtimeId ?? null,
          message: "Session launch requested through Station. Do not repeat an uncertain launch.",
          code, qr: code ? await QRCode.toDataURL(code) : null,
        };
      }
      if (action === "sessions.reloadAll") {
        // Sessions already on the installed version are left alone. 0.2.76+ sessions reload when
        // idle and otherwise right after their current turn; older ones reload at once, so the
        // automatic post-update pass skips them instead of cutting a turn off.
        // `weft update` runs the previous CLI, so it names the version it just installed.
        const installed = payload.installedVersion ?? resolveVersion();
        const scanned = await scan({ baseDir, cleanup: false });
        const results = await Promise.all((scanned.live ?? []).map(async (record) => {
          const version = record.run?.version ?? null;
          if (version === installed) return "current";
          const waitsForTurn = versionAtLeast(version, RELOAD_WHEN_IDLE_SINCE);
          if (payload.source === "update" && !waitsForTurn) return "manual";
          try {
            const result = await sessionClient(record, { baseDir })
              .command("reloadExtension", { opId: randomUUID(), whenIdle: true }, { timeoutMs: 5_000 });
            if (result?.state === "waiting-for-turn") return "waiting";
            if (result?.state === "activity-unknown") return "manual";
            return "reloaded";
          } catch (error) {
            return error?.code === "unsupported" ? "unsupported" : "failed";
          }
        }));
        const count = (value) => results.filter((item) => item === value).length;
        const summary = {
          reloaded: count("reloaded"), waiting: count("waiting"), current: count("current"),
          manual: count("manual"), unsupported: count("unsupported"), failed: count("failed"),
        };
        log("sessions.reload_all", { ...summary, source: payload.source ?? "control-center" });
        const sessions = (n) => `${n} session${n === 1 ? "" : "s"}`;
        const parts = [
          summary.reloaded && `reloaded Weft in ${sessions(summary.reloaded)}`,
          summary.waiting && `${sessions(summary.waiting)} reload when the current turn ends`,
          summary.current && `${sessions(summary.current)} already run ${installed}`,
          summary.manual && `${sessions(summary.manual)} need a manual reload (Reload Weft in open sessions, or /extensions reload)`,
          summary.unsupported && `${sessions(summary.unsupported)} need /extensions reload typed in the session`,
          summary.failed && `${sessions(summary.failed)} did not answer`,
        ].filter(Boolean);
        const text = parts.join("; ");
        return {
          ...summary,
          message: results.length === 0 ? "No open Copilot sessions use Weft." : `${text.charAt(0).toUpperCase()}${text.slice(1)}.`,
        };
      }
      if (action.startsWith("session.")) {
        const client = await target(payload.runtimeId);
        const result = action === "session.activate"
          ? await sessionCommand(client, "activate", { requestId: operationId ?? randomUUID() }, 30_000)
          : await sessionCommand(client, "quiesce", { opId: operationId ?? randomUUID(), reason: "control-center" }, 30_000);
        return { state: result?.state, message: "Session connection updated. Copilot itself was not terminated." };
      }
      if (action === "pairing.rotate") {
        await rotatePersistedIdentity(options);
        return { message: "Saved pairing identity rotated. Restart Station and scan a new QR." };
      }
      requireBackgroundWorkloads();
      const role = action.startsWith("relay.") ? "relay" : "station";
      // station.start decides about a foreground Station itself (ensureStationRunning).
      if (action !== "station.start") await ensureNotForeground(role);
      if (action === "pairing.replace") {
        await background.stop("station", options);
        await rotatePersistedIdentity(options);
        return { state: "stopped", message: "Phone trust replaced. Start Station and scan its new QR." };
      }
      if (action.endsWith(".stop") || action.endsWith(".restart")) {
        if (role === "relay") {
          const entry = readRegistry(DEVTUNNEL_REGISTRY_FILE, options);
          if (entry?.alive !== false && isPidAlive(entry?.pid) && !(await background.command("relay", "status", null, options))) {
            throw new ManagementError("foreground-owned", "The relay is owned by a foreground terminal. Stop it there.");
          }
        }
        const stopped = await background.stop(role, options);
        if (action.endsWith(".stop")) return stopped;
      }
      if (role === "station") {
        // Already under the management lock: observe, decide, then replace/repair/start one worker.
        return ensureStationRunning({
          reason: payload.reason ?? (action === "station.restart" ? "restart" : "control-center"),
          replaceForeground: trustedCli && payload.replaceForeground === true,
          baseDir, cliPath, background,
          onProgress: (event) => onProgress?.({ progressAt: Date.now(), ...event }),
          prepare: async () => {
            if (!listProjects(options).length) throw new ManagementError("project-required", "Register at least one project folder before starting Station.");
            const config = loadTransportConfig(options);
            if (!config) throw new ManagementError("transport-required", "Choose a transport in Setup before starting Station.");
            if (config.kind === "supabase" && !loadSupabaseCredentials(options)) throw new ManagementError("credentials-required", "Supabase credentials are missing. Configure them through weft set-transport or the installer.");
            if (config.kind === "devtunnel") {
              onProgress?.({ step: true, stage: "connecting-relay", label: "Connecting relay…", progressAt: Date.now() });
              await prepareRelay({ interactive, report });
              await startRole("relay");
            }
          },
        });
      }
      await prepareRelay({ interactive, report });
      const status = await startRole(role);
      return { state: status.state, deviceName: status.deviceName, paired: status.paired, baseUrl: status.baseUrl };
    }).then((result) => {
      log("management.completed", { elapsedMs: Date.now() - started });
      return result;
    }).catch((error) => {
      log("management.failed", { code: error.code ?? error.name, elapsedMs: Date.now() - started }, "error");
      throw error;
    });
  }
  let pendingState = null;
  let authPending = null;
  let authValue = null;
  async function auth(force = false) {
    if (!force && authValue && Date.now() - authValue.checkedAt < 60_000) return authValue;
    authPending ??= authentication().then((value) => {
      authValue = value;
      return value;
    }).finally(() => { authPending = null; });
    return authPending;
  }
  // Status never waits on the Dev Tunnel CLI: return the last result and refresh in the background.
  function cachedAuth() {
    if (!authValue || Date.now() - authValue.checkedAt >= 60_000) void auth().catch(() => {});
    return authValue ?? { state: "checking", provider: null, account: null, checkedAt: null,
      message: "Checking Dev Tunnel sign-in in the background." };
  }
  function safeOrigin(value) {
    try { const url = new URL(value); return ["https:", "http:", "wss:", "ws:"].includes(url.protocol) ? url.origin : null; }
    catch { return null; }
  }
  async function readState() {
      const warnings = [];
      const currentSettings = settings();
      const kind = currentSettings.transport?.kind ?? null;
      const [work, runtime] = await Promise.all([workloads(), boundedProbe("sessions", runtimes).then((value) => {
        if (value !== PROBE_PENDING) return value;
        const last = lastProbeResults.get("sessions");
        warnings.push(last ? "Copilot session status is still being checked; showing the last verified session list."
          : "Copilot session discovery is still running. Refresh in a few seconds; no session was changed.");
        return last ?? { discovery: { status: "checking", runtimes: [] }, list: [] };
      }).catch((error) => {
        statusPartFailed("sessions", error);
        warnings.push("Copilot session discovery is temporarily unavailable. Refresh status; no session was changed.");
        return { discovery: { status: "unavailable", runtimes: [] }, list: [] };
      })]);
      const signIn = kind === "devtunnel" ? cachedAuth() : null;
      if (["conflict", "uncertain"].includes(runtime.discovery.status)) warnings.push("Some session identities could not be verified; uncertain sessions cannot be controlled.");
      const savedPairing = readSavedPairing(options);
      work.station.savedPairing = savedPairing;
      if (work.station.state === "stopped") {
        work.station.paired = savedPairing.paired;
        work.station.connected = false;
      }
      const credentials = kind === "supabase" ? loadSupabaseCredentials(options) : null;
      const projectOrigin = credentials ? safeOrigin(credentials.url) : null;
      const endpoint = kind === "devtunnel" ? safeOrigin(work.relay.baseUrl)
        : projectOrigin && /^https?:/.test(projectOrigin) ? projectOrigin : null;
      const connection = {
        kind, endpoint, configSource: "~/.weft/weft.config.json",
        configured: kind === "supabase" ? !!endpoint && !!credentials?.anonKey?.trim() : kind === "devtunnel",
        auth: signIn, liveState: work.station.state === "stopped" ? "not-running"
          : work.station.transportKind && (work.station.transportKind !== kind ||
              work.station.transportEndpoint && endpoint && work.station.transportEndpoint !== endpoint) ? "restart-needed"
            : work.station.transportKind === kind ? work.station.transportState ?? "unreported" : "unreported",
        checkedAt: work.station.transportCheckedAt ?? null,
        unusedRelay: kind !== "devtunnel" && !["stopped", "unsupported", "unresponsive"].includes(work.relay.state),
      };
      return { version: resolveVersion(), installId: backgroundInstallId({ cliPath }), checkedAt: Date.now(), platform, deviceName: loadDeviceName(options) ?? hostname(), ...work, projects: listProjects(options),
        settings: currentSettings, settingsRevision: settingsRevision(currentSettings), sessions: runtime.list, warnings, connection };
  }
  return {
    execute, settings, projects: () => listProjects(options),
    diagnostics: () => ({ enabled: isDiagnosticLoggingEnabled(options), entries: readStationDiagnostics(options) }),
    traffic,
    state() {
      pendingState ??= readState().finally(() => { pendingState = null; });
      return pendingState;
    },
    refreshAuthentication: () => loadTransportConfig(options)?.kind === "devtunnel" ? auth(true)
      : Promise.resolve({ state: "not-applicable", provider: null, account: null, checkedAt: Date.now() }),
    async pairing(runtimeId) {
      const response = runtimeId
        ? await sessionCommand(await target(runtimeId), "status", null, 2000).catch(() => null)
        : null;
      const status = runtimeId ? response : await background.command("station", "status", null, options);
      if (!status && !runtimeId) {
        const saved = readSavedPairing(options);
        return { state: "stopped", paired: saved.paired, savedPairing: saved, code: null, qr: null };
      }
      if (!status) throw new ManagementError("not-running", "Start the selected endpoint before showing pairing.");
      const payload = status.pairingPayload;
      const code = !status.paired && payload && payload.expiresAt > Date.now() ? pairingQrText(payload) : null;
      return { state: status.state, paired: status.paired === true, phoneName: status.phoneName, code, qr: code ? await QRCode.toDataURL(code, { width: 480, margin: 3 }) : null };
    },
    async update() {
      const origin = (process.env.WEFT_INSTALL_BASE || "https://useweft.netlify.app").replace(/\/+$/, "");
      const response = await fetch(`${origin}/release-manifest.json`, { signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new ManagementError("update-unavailable", "The published version could not be checked.");
      const manifest = await response.json();
      if (typeof manifest.version !== "string") throw new ManagementError("update-unavailable", "The published version response is invalid.");
      const current = resolveVersion();
      const numbers = (v) => v.split("-", 1)[0].split(".").map(Number);
      const left = numbers(manifest.version), right = numbers(current);
      const diff = left.map((n, i) => n - (right[i] ?? 0)).find((n) => n !== 0) ?? 0;
      return { current, latest: manifest.version, available: diff > 0,
        message: diff < 0 ? "This local build is newer than the published release." : "Use weft update in a terminal to update installed code. Configuration and pairing are preserved." };
    },
  };
}

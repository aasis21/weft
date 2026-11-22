// SPDX-License-Identifier: Apache-2.0
import { open, mkdir, readFile, unlink } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { hostname } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import QRCode from "qrcode";
import { weftHome, listProjects, addProject, removeProject, setDefault } from "./projects.mjs";
import {
  loadTransportConfig, loadDeviceName, loadDefaultPermissionMode, isPersistentPairingEnabled,
  isTerminalEnabled, loadFileSharingConfig, saveManagementSettings, loadSupabaseCredentials,
  isDiagnosticLoggingEnabled,
} from "./transportConfig.mjs";
import { rotatePersistedIdentity, clearPersistedIdentity, getOrCreatePersistedIdentity, readSavedPairing } from "./pairingIdentity.mjs";
import {
  backgroundCommand, backgroundTaskOperation, startBackground, stopBackground,
  readWorkerCrashReport, readUnexpectedTaskExit, describeWorkerProblem,
} from "./backgroundLifecycle.mjs";
import {
  healthyRegistryEntry, probePublicRelay, findDevTunnelBinary, isDevTunnelLoggedIn,
  ensureDevTunnelLogin, DEVTUNNEL_REGISTRY_FILE, describeStage, readDevTunnelAuthentication,
} from "./devtunnel.mjs";
import { readRegistry, isPidAlive } from "./registryFile.mjs";
import { discoverRuntimeLifecycles, createRuntimeLifecycleClient } from "./runtimeLifecycle.mjs";
import { resolveVersion } from "./version.mjs";
import { verifyProcessIdentities } from "./processIdentity.mjs";
import { readStationDiagnostics, appendStationLog } from "./stationLog.mjs";

export class ManagementError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const actions = {
  "station.start": [], "station.stop": ["confirmed"], "station.restart": ["confirmed"],
  "relay.start": [], "relay.stop": ["confirmed"], "relay.restart": ["confirmed"],
  "project.add": ["name", "path", "makeDefault"],
  "project.remove": ["name", "confirmed"], "project.default": ["name"],
  "settings.save": ["deviceName", "permissionMode", "pairingMode", "terminalEnabled", "loggingEnabled", "files", "transport", "confirmed", "expectedRevision"],
  "pairing.replace": ["confirmed"],
  "pairing.rotate": ["confirmed"],
  "session.activate": ["runtimeId"], "session.disconnect": ["runtimeId", "confirmed"],
  "session.start": ["projectName", "name", "mode", "confirmed"],
};
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
  if (payload.mode !== undefined && !["default", "allow-all"].includes(payload.mode)) throw new ManagementError("invalid-input", "Invalid session permission mode.");
  if (action === "session.start" && payload.mode === "allow-all" && payload.confirmed !== true) throw new ManagementError("confirmation-required", "Confirm launching Copilot with Allow all permissions.");
  if (["station.stop", "station.restart", "relay.stop", "relay.restart", "project.remove", "pairing.replace", "pairing.rotate", "session.disconnect"].includes(action) && payload.confirmed !== true) {
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
  background = { command: backgroundCommand, task: backgroundTaskOperation, start: startBackground, stop: stopBackground },
  discover = discoverRuntimeLifecycles, runtimeClient = createRuntimeLifecycleClient,
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
      try { lastPresences = (await discover({ baseDir, timeoutMs: 750, verifyBatch: verifyProcessIdentities, cleanup: false })).runtimes ?? []; }
      catch { lastPresences = []; }
    }
    await Promise.all(lastPresences.slice(0, 20).map(async (presence, index) => {
      const fallback = `Copilot session ${index + 1}`;
      try {
        const response = await runtimeClient(presence, options).command("traffic", null, { timeoutMs: 1500 });
        if (response?.ok !== true) throw new Error("unsupported");
        const title = typeof response.result?.title === "string" && response.result.title.trim()
          ? response.result.title.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 80) : fallback;
        collect({ id: presence.runtimeInstanceId, name: title }, "session", response.result);
      } catch {
        sources.push({ id: presence.runtimeInstanceId, name: fallback, kind: "session", state: "unsupported" });
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
    if (workerStatus) {
      const { state, error, paired, phoneName, deviceName, baseUrl, pid, startedAt, version,
        connected, lastPeerContactAt, watchLevel, stage, progressAt, attempt, nextRetryAt,
        nextCheckAt, lastHealthyAt, localHealth, forwarding, checkedAt, transportState, transportCheckedAt, transportKind, transportEndpoint } = workerStatus;
      result[role] = { state, error, paired, phoneName, deviceName, baseUrl, pid, startedAt, version,
        connected, lastPeerContactAt, watchLevel, stage, progressAt, attempt, nextRetryAt,
        nextCheckAt, lastHealthyAt, localHealth, forwarding, checkedAt, transportState, transportCheckedAt, transportKind, transportEndpoint,
        stageLabel: stage ? describeStage(stage) : null, supported: true };
      if (role === "station") result[role].checkedAt = Date.now();
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
  async function runtimes() {
    const discovery = await discover({ baseDir, timeoutMs: 750, verifyBatch: verifyProcessIdentities, cleanup: false });
    lastPresences = discovery.runtimes ?? [];
    return { discovery, list: await Promise.all((discovery.runtimes ?? []).map(async (presence) => {
      try {
        const response = await runtimeClient(presence, options).command("status", null, { timeoutMs: 1000 });
        if (response?.ok !== true) throw new ManagementError("runtime-unavailable", "Session status could not be verified.");
        const s = response.result;
        return {
          runtimeId: presence.runtimeInstanceId, sessionId: presence.sessionId, pid: presence.pid,
          state: s.state, paired: s.paired, phoneName: s.phoneName,
          connected: s.state === "dormant" ? false : typeof s.connected === "boolean" ? s.connected : null,
          watchLevel: s.state === "dormant" ? "off" : s.watchLevel ?? null, title: s.title, cwd: s.cwd,
          version: s.version ?? null, lastPeerContactAt: s.lastPeerContactAt ?? null, busy: s.busy ?? null,
        };
      } catch { return { runtimeId: presence.runtimeInstanceId, sessionId: presence.sessionId, pid: presence.pid, state: "unknown", connected: null, watchLevel: null, error: "Live session status unavailable." }; }
    })) };
  }
  async function target(runtimeId) {
    const discovery = await discover({ baseDir, timeoutMs: 1000, verifyBatch: verifyProcessIdentities, cleanup: false });
    if (["conflict", "uncertain"].includes(discovery.status)) throw new ManagementError("runtime-conflict", "Session identity is uncertain. Refresh before selecting a session.");
    const presence = discovery.runtimes?.find((item) => item.runtimeInstanceId === runtimeId);
    if (!presence) throw new ManagementError("stale-session", "This session is no longer available. Refresh the session list.");
    return runtimeClient(presence, options);
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
          operationId: operationId ?? randomUUID(), target: { kind: "new", projectName: payload.projectName },
          mode: payload.mode ?? "default", name: payload.name,
        }, { ...options, timeoutMs: 55_000 });
        if (!response) throw new ManagementError("station-required", "Start Station before launching a new Copilot session.");
        if (response.failure) throw new ManagementError(response.failure.code, response.failure.message);
        const code = response.pairingPayload ? JSON.stringify(response.pairingPayload) : null;
        return { state: response.state, message: "Session launch requested through Station. Do not repeat an uncertain launch.", code, qr: code ? await QRCode.toDataURL(code) : null };
      }
      if (action.startsWith("session.")) {
        const client = await target(payload.runtimeId);
        const response = await client.command(action === "session.activate" ? "activate" : "quiesce",
          action === "session.activate" ? {} : { reason: "control-center" }, { timeoutMs: 30_000 });
        if (response?.ok !== true) throw new ManagementError(response?.error?.code ?? "session-failed", response?.error?.message ?? "Session operation failed.");
        return { state: response.result?.state, message: "Session connection updated. Copilot itself was not terminated." };
      }
      if (action === "pairing.rotate") {
        await rotatePersistedIdentity(options);
        return { message: "Saved pairing identity rotated. Restart Station and scan a new QR." };
      }
      requireBackgroundWorkloads();
      const role = action.startsWith("relay.") ? "relay" : "station";
      await ensureNotForeground(role);
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
        if (!listProjects(options).length) throw new ManagementError("project-required", "Register at least one project folder before starting Station.");
        const config = loadTransportConfig(options);
        if (!config) throw new ManagementError("transport-required", "Choose a transport in Setup before starting Station.");
        if (config.kind === "supabase" && !loadSupabaseCredentials(options)) throw new ManagementError("credentials-required", "Supabase credentials are missing. Configure them through weft set-transport or the installer.");
        if (config.kind === "devtunnel") {
          await prepareRelay({ interactive, report });
          await startRole("relay");
        }
      } else await prepareRelay({ interactive, report });
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
      return { version: resolveVersion(), checkedAt: Date.now(), platform, deviceName: loadDeviceName(options) ?? hostname(), ...work, projects: listProjects(options),
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
      const response = runtimeId ? await (await target(runtimeId)).command("status", null, { timeoutMs: 2000 }) : null;
      const status = runtimeId ? response?.result : await background.command("station", "status", null, options);
      if (!status && !runtimeId) {
        const saved = readSavedPairing(options);
        return { state: "stopped", paired: saved.paired, savedPairing: saved, code: null, qr: null };
      }
      if (!status) throw new ManagementError("not-running", "Start the selected endpoint before showing pairing.");
      const payload = status.pairingPayload;
      const code = !status.paired && payload && payload.expiresAt > Date.now() ? JSON.stringify(payload) : null;
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

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
} from "./transportConfig.mjs";
import { rotatePersistedIdentity, clearPersistedIdentity, getOrCreatePersistedIdentity } from "./pairingIdentity.mjs";
import { backgroundCommand, backgroundTaskOperation, startBackground, stopBackground } from "./backgroundLifecycle.mjs";
import {
  healthyRegistryEntry, probePublicRelay, findDevTunnelBinary, isDevTunnelLoggedIn,
  ensureDevTunnelLogin, DEVTUNNEL_REGISTRY_FILE,
} from "./devtunnel.mjs";
import { readRegistry, isPidAlive } from "./registryFile.mjs";
import { discoverRuntimeLifecycles, createRuntimeLifecycleClient } from "./runtimeLifecycle.mjs";
import { resolveVersion } from "./version.mjs";
import { verifyProcessIdentities } from "./processIdentity.mjs";

export class ManagementError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const actions = {
  "station.start": [], "station.stop": ["confirmed"], "station.restart": ["confirmed"],
  "relay.start": [], "relay.stop": ["confirmed"], "relay.restart": ["confirmed"],
  "project.add": ["name", "path", "makeDefault"],
  "project.remove": ["name", "confirmed"], "project.default": ["name"],
  "settings.save": ["deviceName", "permissionMode", "pairingMode", "terminalEnabled", "files", "transport", "confirmed", "expectedRevision"],
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
} = {}) {
  baseDir = resolve(baseDir);
  const options = { baseDir, cliPath };
  const settings = () => ({
    transport: loadTransportConfig(options),
    deviceName: loadDeviceName(options), permissionMode: loadDefaultPermissionMode(options),
    pairingMode: isPersistentPairingEnabled(options) ? "persistent" : "ephemeral",
    terminalEnabled: isTerminalEnabled(options), files: loadFileSharingConfig(options),
  });
  const settingsRevision = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const requireWindows = () => {
    if (platform !== "win32") throw new ManagementError("unsupported-host", "Background workload controls currently require Windows. Use foreground CLI commands on this platform.");
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
  async function prepareRelay({ interactive = false } = {}) {
    if (await relayHealth(undefined, { baseDir, verifyPublic: true })) return;
    const registry = readRegistry(DEVTUNNEL_REGISTRY_FILE, options);
    if (registry && registry.alive !== false && isPidAlive(registry.pid) && !(await background.command("relay", "status", null, options))) {
      throw new ManagementError("foreground-owned", "The relay is owned by a foreground terminal. Manage it there.");
    }
    const bin = await findDevTunnelBinary();
    if (!bin) throw new ManagementError("missing-devtunnel", "Install the Dev Tunnel CLI before starting the relay.");
    if (interactive) await ensureDevTunnelLogin(bin);
    else if (!(await isDevTunnelLoggedIn(bin))) throw new ManagementError("sign-in-required", "Run devtunnel user login -g in a terminal, then retry. Browser startup never waits on terminal input.");
  }
  async function workloads() {
    const result = {};
    await Promise.all(["station", "relay"].map(async (role) => {
      if (platform !== "win32") { result[role] = { state: "unsupported", supported: false }; return; }
      const raw = await background.command(role, "status", null, options);
      if (raw) {
        const { state, error, paired, phoneName, deviceName, baseUrl, pid } = raw;
        result[role] = { state, error, paired, phoneName, deviceName, baseUrl, pid, supported: true };
      } else {
        const task = await background.task("status", { ...options, role });
        result[role] = { state: task.state === "Running" ? "unresponsive" : "stopped", supported: true };
      }
    }));
    const registry = readRegistry(DEVTUNNEL_REGISTRY_FILE, options);
    if (registry?.alive !== false && isPidAlive(registry?.pid)) {
      const health = await relayHealth(undefined, { baseDir });
      result.relay = { ...result.relay, state: health ? "ready" : "unhealthy", pid: registry.pid, baseUrl: registry.baseUrl };
      if (health) {
        const forwarding = await publicProbe(registry.baseUrl);
        if (forwarding === "rejected") result.relay = { ...result.relay, state: "degraded", error: "Local relay is running, but public forwarding is unavailable. The manager will try recovery." };
        if (forwarding === "unreachable") result.relay = { ...result.relay, state: "waiting-network", error: "Public forwarding could not be reached. Check network connectivity." };
      }
    }
    if (platform === "win32" && result.station.state === "stopped") {
      let pid;
      try { pid = Number.parseInt(readFileSync(join(baseDir, "listener.lock"), "utf8"), 10); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (isPidAlive(pid)) result.station = { state: "foreground", supported: false, pid, error: "Station is owned by a terminal. Manage it there." };
    }
    return result;
  }
  async function runtimes() {
    const discovery = await discover({ baseDir, timeoutMs: 750, verifyBatch: verifyProcessIdentities, cleanup: false });
    return { discovery, list: await Promise.all((discovery.runtimes ?? []).map(async (presence) => {
      try {
        const response = await runtimeClient(presence, options).command("status", null, { timeoutMs: 1000 });
        if (response?.ok !== true) throw new ManagementError("runtime-unavailable", "Session status could not be verified.");
        const s = response.result;
        return {
          runtimeId: presence.runtimeInstanceId, sessionId: presence.sessionId, pid: presence.pid,
          state: s.state, paired: s.paired, phoneName: s.phoneName,
          connected: typeof s.connected === "boolean" ? s.connected : null,
          watchLevel: s.watchLevel ?? null, title: s.title, cwd: s.cwd,
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
  async function execute(action, payload = {}, { interactive = false, trustedCli = false, operationId } = {}) {
    validateManagementAction(action, payload);
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
      requireWindows();
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
        if (!config) throw new ManagementError("transport-required", "Choose a transport in Settings before starting Station.");
        if (config.kind === "supabase" && !loadSupabaseCredentials(options)) throw new ManagementError("credentials-required", "Supabase credentials are missing. Configure them through weft set-transport or the installer.");
        if (config.kind === "devtunnel") {
          await prepareRelay({ interactive });
          await background.start("relay", options);
        }
      } else await prepareRelay({ interactive });
      const status = await background.start(role, options);
      return { state: status.state, deviceName: status.deviceName, paired: status.paired, baseUrl: status.baseUrl };
    });
  }
  let pendingState = null;
  async function readState() {
      const warnings = [];
      const [work, runtime] = await Promise.all([workloads(), runtimes()]);
      if (["conflict", "uncertain"].includes(runtime.discovery.status)) warnings.push("Some session identities could not be verified; uncertain sessions cannot be controlled.");
      const currentSettings = settings();
      return { version: resolveVersion(), checkedAt: Date.now(), platform, deviceName: loadDeviceName(options) ?? hostname(), ...work, projects: listProjects(options),
        settings: currentSettings, settingsRevision: settingsRevision(currentSettings), sessions: runtime.list, warnings };
  }
  return {
    execute, settings, projects: () => listProjects(options),
    state() {
      pendingState ??= readState().finally(() => { pendingState = null; });
      return pendingState;
    },
    async pairing(runtimeId) {
      const response = runtimeId ? await (await target(runtimeId)).command("status", null, { timeoutMs: 2000 }) : null;
      const status = runtimeId ? response?.result : await background.command("station", "status", null, options);
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

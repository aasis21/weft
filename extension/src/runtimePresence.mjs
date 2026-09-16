// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";
import { getProcessStartTime, verifyProcessIdentity } from "./processIdentity.mjs";

export const RUNTIME_PRESENCE_SCHEMA_VERSION = 1;
export const RUNTIME_CAPABILITY = "session-activation-v1";
export const RUNTIME_STATES = Object.freeze(["dormant", "activating", "active", "degraded"]);
export const MAX_PRESENCE_BYTES = 16 * 1_024;

function privateMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // POSIX modes are best-effort on Windows; the directory remains under the user's home.
  }
}

function cleanId(value, name) {
  const clean = String(value ?? "").trim();
  if (!clean || clean.length > 512) throw new Error(`${name} is invalid`);
  return clean;
}

function validatePresence(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== RUNTIME_PRESENCE_SCHEMA_VERSION) return null;
  if (!RUNTIME_STATES.includes(value.state) || !Array.isArray(value.capabilities) || value.capabilities.length > 16) {
    return null;
  }
  const stringFields = ["storeAuthority", "sessionId", "terminalInstanceId", "runtimeInstanceId", "endpoint"];
  if (stringFields.some((key) => typeof value[key] !== "string" || !value[key] || value[key].length > 512)) return null;
  const integerFields = ["generation", "pid", "processStartedAt", "updatedAt"];
  if (integerFields.some((key) => !Number.isSafeInteger(value[key]) || value[key] < 1)) return null;
  if (value.capabilities.some((item) => typeof item !== "string" || !item || item.length > 128)) return null;
  return Object.freeze({ ...value, capabilities: Object.freeze([...value.capabilities]) });
}

function writePrivateFile(file, contents) {
  writeFileSync(file, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  privateMode(file, 0o600);
}

function writePresenceAtomic(file, presence) {
  const serialized = `${JSON.stringify(presence, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_PRESENCE_BYTES) throw new Error("runtime presence exceeds its size limit");
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writePrivateFile(tmp, serialized);
  renameSync(tmp, file);
  privateMode(file, 0o600);
}

export function runtimesDirectory({ baseDir } = {}) {
  return join(weftHome(baseDir), "runtimes", "v1");
}

export function runtimeDirectory(runtimeInstanceId, { baseDir } = {}) {
  return join(runtimesDirectory({ baseDir }), cleanId(runtimeInstanceId, "runtimeInstanceId"));
}

export function readRuntimeCapability(runtimeInstanceId, { baseDir } = {}) {
  const file = join(runtimeDirectory(runtimeInstanceId, { baseDir }), "capability");
  const size = statSync(file).size;
  if (size < 2 || size > 1_024) throw new Error("runtime capability is invalid");
  return cleanId(readFileSync(file, "utf8"), "capability");
}

export async function publishRuntimePresence(
  {
    identity,
    endpoint,
    state = "dormant",
    capabilities = [RUNTIME_CAPABILITY],
    pid = process.pid,
    processStartedAt,
  },
  {
    baseDir,
    now = Date.now,
    getStartTime = getProcessStartTime,
    capability = randomBytes(32).toString("base64url"),
  } = {},
) {
  if (!identity || typeof identity !== "object") throw new Error("identity is required");
  const finalDir = runtimeDirectory(identity.runtimeInstanceId, { baseDir });
  const parent = runtimesDirectory({ baseDir });
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  privateMode(weftHome(baseDir), 0o700);
  privateMode(join(weftHome(baseDir), "runtimes"), 0o700);
  privateMode(parent, 0o700);
  const tempDir = join(parent, `.${identity.runtimeInstanceId}.${process.pid}.${randomUUID()}.tmp`);
  mkdirSync(tempDir, { mode: 0o700 });
  privateMode(tempDir, 0o700);
  try {
    const startedAt = processStartedAt ?? await getStartTime(pid);
    const presence = validatePresence({
      schemaVersion: RUNTIME_PRESENCE_SCHEMA_VERSION,
      ...identity,
      pid,
      processStartedAt: startedAt,
      endpoint: cleanId(endpoint, "endpoint"),
      state,
      capabilities: [...capabilities],
      updatedAt: now(),
    });
    if (!presence) throw new Error("runtime presence is invalid");
    writePrivateFile(join(tempDir, "presence.json"), `${JSON.stringify(presence, null, 2)}\n`);
    writePrivateFile(join(tempDir, "capability"), `${cleanId(capability, "capability")}\n`);
    try {
      renameSync(tempDir, finalDir);
    } catch (error) {
      if (!existsSync(finalDir)) throw error;
      const duplicate = new Error(`runtime presence already exists for ${identity.runtimeInstanceId}`);
      duplicate.code = "EEXIST";
      throw duplicate;
    }
    privateMode(finalDir, 0o700);

    let current = presence;
    let closed = false;
    return {
      directory: finalDir,
      capability,
      get presence() {
        return current;
      },
      update(patch = {}) {
        if (closed) throw new Error("runtime presence is closed");
        const next = validatePresence({
          ...current,
          ...patch,
          schemaVersion: RUNTIME_PRESENCE_SCHEMA_VERSION,
          storeAuthority: current.storeAuthority,
          sessionId: current.sessionId,
          terminalInstanceId: current.terminalInstanceId,
          runtimeInstanceId: current.runtimeInstanceId,
          generation: current.generation,
          pid: current.pid,
          processStartedAt: current.processStartedAt,
          endpoint: current.endpoint,
          updatedAt: now(),
        });
        if (!next) throw new Error("runtime presence update is invalid");
        writePresenceAtomic(join(finalDir, "presence.json"), next);
        current = next;
        return current;
      },
      close({ remove = true } = {}) {
        if (closed) return;
        closed = true;
        if (remove) rmSync(finalDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

function readPresence(dir, baseDir) {
  const file = join(dir, "presence.json");
  if (statSync(file).size > MAX_PRESENCE_BYTES) return null;
  const presence = validatePresence(JSON.parse(readFileSync(file, "utf8")));
  if (!presence) return null;
  readRuntimeCapability(presence.runtimeInstanceId, { baseDir });
  return presence;
}

export async function scanRuntimePresence(
  {
    baseDir,
    storeAuthority = null,
    sessionId = null,
    cleanup = true,
    verify = verifyProcessIdentity,
    probe = null,
  } = {},
) {
  const parent = runtimesDirectory({ baseDir });
  let entries;
  try {
    entries = readdirSync(parent, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return { status: "none", runtimes: [], rejected: [] };
    throw error;
  }
  const runtimes = [];
  const rejected = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const dir = join(parent, entry.name);
    let presence;
    try {
      presence = readPresence(dir, baseDir);
    } catch {
      presence = null;
    }
    if (!presence || presence.runtimeInstanceId !== entry.name) {
      rejected.push({ directory: dir, reason: "corrupt" });
      if (cleanup) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (storeAuthority && presence.storeAuthority !== storeAuthority) continue;
    if (sessionId && presence.sessionId !== sessionId) continue;
    const processResult = await verify(presence);
    if (processResult?.live !== true) {
      rejected.push({ presence, reason: processResult?.reason ?? "process-unverifiable" });
      if (cleanup && processResult?.live === false) rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (probe) {
      try {
        const proof = await probe(presence);
        if (proof !== true) {
          rejected.push({ presence, reason: "endpoint-proof-failed" });
          continue;
        }
      } catch {
        rejected.push({ presence, reason: "endpoint-unverifiable" });
        continue;
      }
    }
    runtimes.push(presence);
  }
  const uncertain = rejected.some(({ presence, reason }) =>
    presence &&
    (!storeAuthority || presence.storeAuthority === storeAuthority) &&
    (!sessionId || presence.sessionId === sessionId) &&
    (
      reason === "process-unverifiable" ||
      reason === "endpoint-unverifiable" ||
      reason === "endpoint-proof-failed"
    ));
  const groups = new Map();
  for (const runtime of runtimes) {
    const key = `${runtime.storeAuthority}\0${runtime.sessionId}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  }
  const conflicts = [...groups.entries()]
    .filter(([, count]) => count > 1)
    .map(([key]) => {
      const separator = key.indexOf("\0");
      return { storeAuthority: key.slice(0, separator), sessionId: key.slice(separator + 1) };
    });
  return {
    status: conflicts.length > 0
      ? "conflict"
      : uncertain
        ? "uncertain"
        : runtimes.length === 0
          ? "none"
          : runtimes.length === 1
            ? "single"
            : "multiple",
    runtimes,
    rejected,
    conflicts,
  };
}

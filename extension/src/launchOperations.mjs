// SPDX-License-Identifier: Apache-2.0
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";
import { isPidAlive } from "./registryFile.mjs";

export const LAUNCH_OPERATIONS_DIR = "launch-operations";
export const LAUNCH_IDENTITIES_DIR = "launch-identities";
export const LAUNCH_RESERVATIONS_DIR = "launch-reservations";
export const RESOLVED_TTL_MS = 24 * 60 * 60 * 1_000;
export const UNRESOLVED_NEW_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

const TERMINAL_STATES = new Set(["failed", "claimed", "abandoned", "superseded"]);
const PROGRESS = Object.freeze({ accepted: 0, launched: 1, ready: 2, claimed: 3 });

function safeId(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function ensureDir(name, baseDir) {
  const dir = join(weftHome(baseDir), name);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on Windows.
  }
  return dir;
}

export function launchOperationsDir({ baseDir } = {}) {
  return ensureDir(LAUNCH_OPERATIONS_DIR, baseDir);
}

export function launchIdentitiesDir({ baseDir } = {}) {
  return ensureDir(LAUNCH_IDENTITIES_DIR, baseDir);
}

function reservationsDir(baseDir) {
  return ensureDir(LAUNCH_RESERVATIONS_DIR, baseDir);
}

export function launchOperationPath(requestId, { baseDir } = {}) {
  return join(launchOperationsDir({ baseDir }), `${safeId(requestId)}.json`);
}

export function launchIdentityPath(requestId, { baseDir } = {}) {
  return join(launchIdentitiesDir({ baseDir }), `${safeId(requestId)}.json`);
}

function reservationPath(sessionId, baseDir) {
  return join(reservationsDir(baseDir), `${safeId(sessionId)}.json`);
}

function lockPath(kind, key, baseDir) {
  const dir = ensureDir(".launch-locks", baseDir);
  return join(dir, `${kind}-${safeId(key)}.lock`);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const dir = file.slice(0, Math.max(file.lastIndexOf("\\"), file.lastIndexOf("/")));
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${safeId(file)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  try {
    chmodSync(tmp, 0o600);
  } catch {
    // Best-effort on Windows.
  }
  renameSync(tmp, file);
  try {
    chmodSync(file, 0o600);
  } catch {
    // Best-effort on Windows.
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withEntryLock(kind, key, baseDir, fn) {
  const file = lockPath(kind, key, baseDir);
  const deadline = Date.now() + 5_000;
  let fd;
  while (fd === undefined) {
    try {
      fd = openSync(file, "wx", 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: Date.now() }), "utf8");
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const owner = readJson(file);
      let stale = false;
      try {
        stale = Date.now() - statSync(file).mtimeMs > 30_000 && !isPidAlive(owner?.pid);
      } catch {
        stale = true;
      }
      if (stale) {
        try {
          unlinkSync(file);
        } catch {
          // Another process may have recovered it first.
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for launch operation ${key}`);
      await delay(10);
    }
  }
  try {
    return await fn();
  } finally {
    try {
      closeSync(fd);
    } catch {
      // Best-effort.
    }
    try {
      unlinkSync(file);
    } catch {
      // Best-effort.
    }
  }
}

function normalizedRequest(request) {
  const operation = request?.operation === "resume" ? "resume" : "new";
  return {
    operation,
    projectName: operation === "new" && typeof request?.projectName === "string" ? request.projectName.trim() : null,
    sessionId: operation === "resume" && typeof request?.sessionId === "string" ? request.sessionId.trim() : null,
    mode: request?.mode === "allow-all" ? "allow-all" : "default",
    name: operation === "new" && typeof request?.name === "string" && request.name.trim() ? request.name.trim() : null,
    force: operation === "resume" && request?.force === true,
  };
}

function fingerprint(request) {
  return createHash("sha256").update(JSON.stringify(normalizedRequest(request))).digest("hex");
}

export function readLaunchOperation(requestId, { baseDir } = {}) {
  if (!requestId) return null;
  const record = readJson(launchOperationPath(requestId, { baseDir }));
  return record?.requestId === requestId ? record : null;
}

export async function beginLaunchOperation(request, { baseDir, now = Date.now() } = {}) {
  const requestId = typeof request?.requestId === "string" ? request.requestId.trim() : "";
  if (!requestId) throw new Error("Launch requestId is required");
  const normalized = normalizedRequest(request);
  const requestFingerprint = fingerprint(normalized);
  return withEntryLock("request", requestId, baseDir, async () => {
    const existing = readLaunchOperation(requestId, { baseDir });
    if (existing) {
      return existing.fingerprint === requestFingerprint
        ? { kind: "duplicate", record: existing }
        : { kind: "conflict", record: existing };
    }

    const create = async () => {
      const record = {
        version: 1,
        requestId,
        fingerprint: requestFingerprint,
        ownerToken: randomUUID(),
        ...normalized,
        state: "accepted",
        pairingPayload: null,
        identityFile: null,
        pid: null,
        error: null,
        createdAt: now,
        updatedAt: now,
        launchedAt: null,
        readyAt: null,
        claimedAt: null,
        failedAt: null,
      };
      writeJsonAtomic(launchOperationPath(requestId, { baseDir }), record);
      return { kind: "created", record };
    };

    if (normalized.operation !== "resume" || !normalized.sessionId) return create();
    return withEntryLock("resume", normalized.sessionId, baseDir, async () => {
      const file = reservationPath(normalized.sessionId, baseDir);
      const reservation = readJson(file);
      if (reservation?.requestId && reservation.requestId !== requestId) {
        const owner = readLaunchOperation(reservation.requestId, { baseDir });
        if (!owner || !TERMINAL_STATES.has(owner.state)) {
          const error = `Session resume is already reserved by launch request ${reservation.requestId}.`;
          const rejected = {
            version: 1,
            requestId,
            fingerprint: requestFingerprint,
            ownerToken: randomUUID(),
            ...normalized,
            state: "failed",
            pairingPayload: null,
            identityFile: null,
            pid: null,
            error,
            createdAt: now,
            updatedAt: now,
            launchedAt: null,
            readyAt: null,
            claimedAt: null,
            failedAt: now,
          };
          writeJsonAtomic(launchOperationPath(requestId, { baseDir }), rejected);
          return { kind: "reserved", record: rejected, reservedBy: reservation.requestId };
        }
      }
      writeJsonAtomic(file, { sessionId: normalized.sessionId, requestId, createdAt: now });
      return create();
    });
  });
}

function nextState(current, requested) {
  if (!requested || current === requested || TERMINAL_STATES.has(current)) return current;
  if (TERMINAL_STATES.has(requested)) return requested;
  return (PROGRESS[requested] ?? -1) >= (PROGRESS[current] ?? -1) ? requested : current;
}

async function releaseResumeReservation(record, baseDir) {
  if (record?.operation !== "resume" || !record.sessionId) return;
  await withEntryLock("resume", record.sessionId, baseDir, async () => {
    const file = reservationPath(record.sessionId, baseDir);
    const reservation = readJson(file);
    if (reservation?.requestId === record.requestId) {
      try {
        unlinkSync(file);
      } catch {
        // Best-effort.
      }
    }
  });
}

export async function updateLaunchOperation(
  requestId,
  updates,
  { baseDir, ownerToken, now = Date.now() } = {},
) {
  const result = await withEntryLock("request", requestId, baseDir, async () => {
    const current = readLaunchOperation(requestId, { baseDir });
    if (!current) return null;
    if (ownerToken && current.ownerToken !== ownerToken) return null;
    const requestedState = updates?.state;
    if (requestedState && TERMINAL_STATES.has(current.state) && requestedState !== current.state) {
      return current;
    }
    const state = nextState(current.state, requestedState);
    const next = {
      ...current,
      ...updates,
      requestId: current.requestId,
      fingerprint: current.fingerprint,
      ownerToken: current.ownerToken,
      state,
      updatedAt: now,
    };
    if (state === "launched" && !next.launchedAt) next.launchedAt = now;
    if (state === "ready" && !next.readyAt) {
      next.launchedAt ??= now;
      next.readyAt = now;
    }
    if (state === "claimed" && !next.claimedAt) next.claimedAt = now;
    if (state === "failed" && !next.failedAt) next.failedAt = now;
    writeJsonAtomic(launchOperationPath(requestId, { baseDir }), next);
    return next;
  });
  if (result && TERMINAL_STATES.has(result.state)) await releaseResumeReservation(result, baseDir);
  return result;
}

export async function markLaunchClaimed(requestId, options = {}) {
  return updateLaunchOperation(requestId, { state: "claimed" }, options);
}

export function listLaunchOperations({ baseDir } = {}) {
  const dir = launchOperationsDir({ baseDir });
  const records = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const record = readJson(join(dir, name));
    if (record?.requestId && record?.state) records.push(record);
  }
  return records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
}

export function publicLaunchDetails(record) {
  if (!record) return {};
  return {
    ...(record.pairingPayload ? { payload: record.pairingPayload } : {}),
    ...(record.operation ? { operation: record.operation } : {}),
    ...(record.projectName ? { projectName: record.projectName } : {}),
    ...(record.sessionId ? { sessionId: record.sessionId } : {}),
    ...(record.name ? { name: record.name } : {}),
    ...(record.error ? { error: record.error } : {}),
    ...(Number.isFinite(record.createdAt) ? { createdAt: record.createdAt } : {}),
    ...(Number.isFinite(record.launchedAt) ? { launchedAt: record.launchedAt } : {}),
    ...(Number.isFinite(record.readyAt) ? { readyAt: record.readyAt } : {}),
    ...(Number.isInteger(record.pid) && record.pid > 0 ? { pid: record.pid } : {}),
  };
}

export async function pruneLaunchOperations(
  { baseDir, now = Date.now(), resolvedTtlMs = RESOLVED_TTL_MS, unresolvedNewTtlMs = UNRESOLVED_NEW_TTL_MS } = {},
) {
  const records = listLaunchOperations({ baseDir });
  for (const record of records) {
    const age = now - (record.updatedAt ?? record.createdAt ?? now);
    if (!TERMINAL_STATES.has(record.state)) {
      if (record.operation === "new" && age > unresolvedNewTtlMs) {
        await updateLaunchOperation(
          record.requestId,
          { state: "abandoned", error: "Launch expired before it was claimed." },
          { baseDir, ownerToken: record.ownerToken, now },
        );
      }
      // Resume reservations are intentionally never released merely because they are old.
      continue;
    }
    if (age <= resolvedTtlMs) continue;
    await withEntryLock("request", record.requestId, baseDir, async () => {
      const latest = readLaunchOperation(record.requestId, { baseDir });
      if (!latest || !TERMINAL_STATES.has(latest.state)) return;
      try {
        rmSync(launchOperationPath(record.requestId, { baseDir }), { force: true });
      } catch {
        // Best-effort.
      }
      if (latest.identityFile && existsSync(latest.identityFile)) {
        try {
          rmSync(latest.identityFile, { force: true });
        } catch {
          // Best-effort.
        }
      }
    });
  }
}

export function isTerminalLaunchState(state) {
  return TERMINAL_STATES.has(state);
}

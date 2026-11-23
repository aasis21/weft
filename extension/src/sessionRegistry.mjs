// SPDX-License-Identifier: Apache-2.0
//
// The live session registry: one file per running Weft instance, written ONLY by that instance.
//
//   ~/.weft/sessions-live/<runtimeId>.json   facts the session knows about itself (LLD §3.1)
//   ~/.weft/sessions-live/<runtimeId>.key    32-byte capability for its local control pipe (0600)
//
// Station reads the records, proves process identity (pid + start time) and groups them by the
// saved Copilot session they write to. Health is derived elsewhere (shared/sessionHealth.mjs); a
// record never claims to be healthy. A record is deleted by its owner on clean shutdown, or by
// Station only after it PROVES the owning process is gone.
//
// This module stays dependency-light on purpose: the dormant extension bundle imports it.
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
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { weftHome } from "./projects.mjs";
import { getProcessStartTime, verifyProcessIdentities } from "./processIdentity.mjs";
import { isPidAlive, readRegistry } from "./registryFile.mjs";

export const SESSION_RECORD_SCHEMA = 1;
export const LIVE_DIR = "sessions-live";
export const LINK_STATES = Object.freeze(["dormant", "connecting", "waiting", "linked", "ending"]);
export const MAX_RECORD_BYTES = 16 * 1_024;
/** Throttles (LLD §3.1): state changes are written immediately. */
export const FAILURE_WRITE_INTERVAL_MS = 10_000;
export const CONTACT_WRITE_INTERVAL_MS = 60_000;
/** A corrupt record can never prove ownership; it is removed once clearly not mid-write. */
const CORRUPT_RECORD_GRACE_MS = 10 * 60_000;

const TERMINAL_ID = Symbol.for("weft.session-terminal-identity.v2");
const RUNTIMES = Symbol.for("weft.session-runtimes.v2");

function privateMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // POSIX modes are best-effort on Windows; the directory remains under the user's home.
  }
}

function text(value, max = 512) {
  return typeof value === "string" && value.trim() && value.length <= max ? value : null;
}
const int = (value, min = 0) => (Number.isSafeInteger(value) && value >= min ? value : null);
const time = (value) => (Number.isFinite(value) && value > 0 ? value : null);

// ---- identity -------------------------------------------------------------------------------

function canonicalPath(path, platform) {
  const absolute = resolve(String(path ?? ""));
  let canonical = absolute;
  try {
    canonical = realpathSync.native(absolute);
  } catch {
    // The store can be identified before its database file is created.
  }
  return platform === "win32" ? canonical.toLowerCase() : canonical;
}

/** The one-writer key's first half: which Copilot session store a session lives in. */
export function deriveStoreAuthority(storePath, { platform = process.platform } = {}) {
  if (!text(storePath, 4096)) throw new Error("storePath is required");
  return `sha256:${createHash("sha256").update(canonicalPath(storePath, platform)).digest("hex")}`;
}

/** Stable for the lifetime of this Copilot process (survives extension reloads). */
export function getTerminalInstanceId({ scope = globalThis, randomId = randomUUID } = {}) {
  if (!scope[TERMINAL_ID]) scope[TERMINAL_ID] = randomId();
  return scope[TERMINAL_ID];
}

/**
 * runtimeId is stable per (process, saved session) so an extension reload keeps the same record
 * file (no ownership gap a concurrent open could fall into); generation bumps on every reload.
 */
export function nextSessionRuntime(
  { storeAuthority, sessionId },
  { scope = globalThis, randomId = randomUUID } = {},
) {
  const key = `${storeAuthority}\0${sessionId}`;
  if (!scope[RUNTIMES]) scope[RUNTIMES] = new Map();
  const previous = scope[RUNTIMES].get(key);
  const next = { runtimeId: previous?.runtimeId ?? randomId(), generation: (previous?.generation ?? 0) + 1 };
  scope[RUNTIMES].set(key, next);
  return next;
}

// ---- record shape -----------------------------------------------------------------------------

function normalizeError(value) {
  if (!value || typeof value !== "object") return null;
  const code = text(value.code, 64);
  return code ? { code, at: time(value.at) ?? 0 } : null;
}

function normalizeOffer(value) {
  if (!value || typeof value !== "object" || !value.payload || typeof value.payload !== "object") return null;
  const channelId = text(value.channelId, 256) ?? text(value.payload.channelId, 256);
  if (!channelId) return null;
  return {
    channelId,
    name: text(value.name, 256),
    cwd: text(value.cwd, 4096),
    payload: value.payload,
    expiresAt: time(value.expiresAt) ?? time(value.payload.expiresAt),
  };
}

function normalizeLink(value = {}) {
  return {
    generation: int(value?.generation) ?? 0,
    state: LINK_STATES.includes(value?.state) ? value.state : "dormant",
    attempt: int(value?.attempt) ?? 0,
    deadlineAt: time(value?.deadlineAt),
    lastError: normalizeError(value?.lastError),
    controllerRevision: int(value?.controllerRevision) ?? 0,
    lastPhoneContactAt: time(value?.lastPhoneContactAt),
    phoneWatching: typeof value?.phoneWatching === "boolean" ? value.phoneWatching : null,
    endpointRevision: int(value?.endpointRevision) ?? 0,
  };
}

/** Validate and normalize one live record. Returns null for anything this version cannot trust. */
export function normalizeSessionRecord(value) {
  if (!value || typeof value !== "object" || value.schema !== SESSION_RECORD_SCHEMA) return null;
  const storeAuthority = text(value.session?.storeAuthority);
  const sessionId = text(value.session?.sessionId);
  const run = value.run ?? {};
  const runtimeId = text(run.runtimeId, 128);
  const generation = int(run.generation, 1);
  const pid = int(run.pid, 1);
  const processStartedAt = int(run.processStartedAt, 1);
  const pipe = text(value.control?.pipe, 1024);
  if (!storeAuthority || !sessionId || !runtimeId || !generation || !pid || !processStartedAt || !pipe) return null;
  const openedBy = run.openedBy && typeof run.openedBy === "object"
    ? { kind: text(run.openedBy.kind, 32) ?? "user", requestId: text(run.openedBy.requestId, 256) }
    : null;
  return {
    schema: SESSION_RECORD_SCHEMA,
    session: { storeAuthority, sessionId },
    run: {
      runtimeId, generation, pid, processStartedAt,
      terminalInstanceId: text(run.terminalInstanceId, 128),
      version: text(run.version, 64),
      openedBy,
      cwd: text(run.cwd, 4096),
    },
    control: { pipe },
    link: normalizeLink(value.link),
    offer: normalizeOffer(value.offer),
    updatedAt: time(value.updatedAt) ?? 0,
  };
}

/** The minimum a record from ANOTHER Weft version must carry for us to honor its ownership. */
function foreignClaim(value) {
  const sessionId = text(value?.session?.sessionId) ?? text(value?.sessionId);
  const pid = int(value?.run?.pid ?? value?.pid, 1);
  const processStartedAt = int(value?.run?.processStartedAt ?? value?.processStartedAt, 1);
  if (!sessionId || !pid || !processStartedAt) return null;
  return {
    sessionId,
    storeAuthority: text(value?.session?.storeAuthority) ?? text(value?.storeAuthority),
    pid,
    processStartedAt,
  };
}

function mergeRecord(current, patch = {}) {
  return {
    ...current,
    run: patch.run ? { ...current.run, ...patch.run } : current.run,
    link: patch.link ? { ...current.link, ...patch.link } : current.link,
    offer: Object.hasOwn(patch, "offer") ? patch.offer : current.offer,
  };
}

// ---- paths ------------------------------------------------------------------------------------

function cleanRuntimeId(value) {
  const id = text(String(value ?? ""), 128);
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id)) throw new Error("runtimeId is invalid");
  return id;
}

export function liveDirectory({ baseDir } = {}) {
  return join(weftHome(baseDir), LIVE_DIR);
}

export function recordPath(runtimeId, { baseDir } = {}) {
  return join(liveDirectory({ baseDir }), `${cleanRuntimeId(runtimeId)}.json`);
}

export function capabilityPath(runtimeId, { baseDir } = {}) {
  return join(liveDirectory({ baseDir }), `${cleanRuntimeId(runtimeId)}.key`);
}

export function readSessionCapability(runtimeId, { baseDir } = {}) {
  const file = capabilityPath(runtimeId, { baseDir });
  const size = statSync(file).size;
  if (size < 16 || size > 256) throw new Error("session capability is invalid");
  return readFileSync(file, "utf8").trim();
}

function writeAtomic(file, contents, { exclusive = false } = {}) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
  privateMode(tmp, 0o600);
  if (exclusive && existsSync(file)) {
    rmSync(tmp, { force: true });
    const error = new Error(`${file} already exists`);
    error.code = "EEXIST";
    throw error;
  }
  renameSync(tmp, file);
  privateMode(file, 0o600);
}

function serialize(record) {
  const data = `${JSON.stringify(record, null, 2)}\n`;
  if (Buffer.byteLength(data) > MAX_RECORD_BYTES) throw new Error("session record exceeds its size limit");
  return data;
}

// ---- session side: publish + throttled updates ---------------------------------------------------

/**
 * Publish this instance's live record and return a writer handle. A reload of the same runtime
 * (same runtimeId, higher generation) takes the file over in place.
 */
export async function publishSessionRecord(
  { session, run, link = {}, offer = null, pipe },
  {
    baseDir,
    now = Date.now,
    getStartTime = getProcessStartTime,
    capability = randomBytes(32).toString("base64url"),
    setTimer = (fn, ms) => {
      const handle = setTimeout(fn, ms);
      handle.unref?.();
      return handle;
    },
    clearTimer = (handle) => clearTimeout(handle),
    onWriteError = () => {},
  } = {},
) {
  const dir = liveDirectory({ baseDir });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  privateMode(weftHome(baseDir), 0o700);
  privateMode(dir, 0o700);
  const pid = run?.pid ?? process.pid;
  const processStartedAt = run?.processStartedAt ?? await getStartTime(pid);
  let current = normalizeSessionRecord({
    schema: SESSION_RECORD_SCHEMA,
    session,
    run: { ...run, pid, processStartedAt },
    control: { pipe },
    link: { state: "dormant", ...link },
    offer,
    updatedAt: now(),
  });
  if (!current) throw new Error("session record is invalid");
  const runtimeId = current.run.runtimeId;
  const keyFile = capabilityPath(runtimeId, { baseDir });
  const file = recordPath(runtimeId, { baseDir });
  const previous = (() => {
    try { return normalizeSessionRecord(JSON.parse(readFileSync(file, "utf8"))); } catch { return null; }
  })();
  // Only the same process may take a record over (an extension reload). Anything else is a bug or
  // an attack on someone else's record; refuse instead of overwriting.
  if (previous && (previous.run.pid !== pid || previous.run.generation >= current.run.generation)) {
    const error = new Error(`session record ${runtimeId} is owned by another instance`);
    error.code = "EEXIST";
    throw error;
  }
  writeAtomic(keyFile, `${capability}\n`);
  writeAtomic(file, serialize(current));

  let closed = false;
  let timer = null;
  const lastWriteAt = { failure: -Infinity, contact: -Infinity };

  const owns = () => {
    try {
      return readFileSync(keyFile, "utf8").trim() === capability;
    } catch {
      return false;
    }
  };

  function writeNow() {
    if (timer) {
      clearTimer(timer);
      timer = null;
    }
    if (closed) return false;
    if (!owns()) {
      closed = true;
      onWriteError(Object.assign(new Error("session record ownership was lost"), { code: "ESTALE" }));
      return false;
    }
    current = { ...current, updatedAt: now() };
    try {
      writeAtomic(file, serialize(current));
      return true;
    } catch (error) {
      onWriteError(error);
      return false;
    }
  }

  return {
    runtimeId,
    capability,
    file,
    get record() {
      return current;
    },
    get closed() {
      return closed;
    },
    /**
     * Merge facts. `kind` decides the write throttle: "state" writes now, "failure" at most once per
     * 10 s, "contact" at most once per 60 s. Throttled facts are kept and flushed later.
     */
    update(patch = {}, { kind = "state" } = {}) {
      if (closed) return current;
      const next = normalizeSessionRecord(mergeRecord(current, patch));
      if (!next || next.run.runtimeId !== runtimeId || next.session.sessionId !== current.session.sessionId) {
        throw new Error("session record update is invalid");
      }
      current = { ...next, run: { ...next.run, pid, processStartedAt } };
      if (kind === "state") {
        writeNow();
        return current;
      }
      const interval = kind === "failure" ? FAILURE_WRITE_INTERVAL_MS : CONTACT_WRITE_INTERVAL_MS;
      const at = now();
      const last = lastWriteAt[kind] ?? -Infinity;
      if (at - last >= interval) {
        lastWriteAt[kind] = at;
        writeNow();
      } else if (!timer) {
        timer = setTimer(() => {
          timer = null;
          lastWriteAt[kind] = now();
          writeNow();
        }, Math.max(0, last + interval - at));
      }
      return current;
    },
    flush() {
      return writeNow();
    },
    /** Remove the record (clean shutdown) or keep it for the reloading successor. */
    close({ remove = true } = {}) {
      if (timer) clearTimer(timer);
      timer = null;
      if (closed) return;
      closed = true;
      if (remove && owns()) {
        rmSync(file, { force: true });
        rmSync(keyFile, { force: true });
      }
    },
  };
}

// ---- Station side: discovery ----------------------------------------------------------------------

function readRecordFile(file) {
  const stats = statSync(file);
  if (stats.size > MAX_RECORD_BYTES) return { raw: null, mtimeMs: stats.mtimeMs };
  let raw = null;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    raw = null;
  }
  return { raw, mtimeMs: stats.mtimeMs };
}

function removeRuntimeFiles(dir, runtimeId) {
  rmSync(join(dir, `${runtimeId}.json`), { force: true });
  rmSync(join(dir, `${runtimeId}.key`), { force: true });
}

/** Group key for the one-writer invariant. */
export function sessionKey({ storeAuthority, sessionId }) {
  return `${storeAuthority ?? "*"}\0${sessionId}`;
}

/**
 * Read every live record, batch-verify process identity, delete records whose process is PROVEN
 * gone, and group the rest by saved session.
 *
 * Returns `{ live, foreign, unverified, dead, corrupt, sessions, legacyOwners }` where:
 *   live        schema-valid records whose pid + start time match a running process
 *   foreign     other-version records whose process is alive (they still own their session)
 *   unverified  records whose process could not be proven alive or dead
 *   sessions    [{ key: {storeAuthority, sessionId}, runtimes: [record], ownerConflict }]
 *   legacyOwners  live owners found in pre-0.2.75 stores (see cleanupLegacyStores)
 */
export async function scanSessions({
  baseDir,
  cleanup = true,
  verifyBatch = verifyProcessIdentities,
  now = Date.now,
  legacy = true,
} = {}) {
  const dir = liveDirectory({ baseDir });
  let names = [];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const candidates = [];
  const corrupt = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const runtimeId = name.slice(0, -5);
    let read;
    try {
      read = readRecordFile(join(dir, name));
    } catch {
      continue;
    }
    const record = normalizeSessionRecord(read.raw);
    const claim = record ? null : foreignClaim(read.raw);
    if (record && record.run.runtimeId === runtimeId) {
      candidates.push({ runtimeId, record, pid: record.run.pid, processStartedAt: record.run.processStartedAt });
    } else if (claim) {
      candidates.push({ runtimeId, foreign: claim, pid: claim.pid, processStartedAt: claim.processStartedAt });
    } else {
      corrupt.push(runtimeId);
      if (cleanup && now() - read.mtimeMs > CORRUPT_RECORD_GRACE_MS) removeRuntimeFiles(dir, runtimeId);
    }
  }
  const proofs = candidates.length ? await verifyBatch(candidates) : [];
  if (!Array.isArray(proofs) || proofs.length !== candidates.length) {
    throw new Error("Invalid batch process verification result.");
  }
  const live = [];
  const foreign = [];
  const unverified = [];
  const dead = [];
  candidates.forEach((candidate, index) => {
    const proof = proofs[index];
    if (proof?.live === true) {
      if (candidate.record) live.push(candidate.record);
      else foreign.push({ runtimeId: candidate.runtimeId, ...candidate.foreign });
    } else if (proof?.live === false) {
      dead.push(candidate.runtimeId);
      if (cleanup) removeRuntimeFiles(dir, candidate.runtimeId);
    } else {
      unverified.push(candidate.record
        ? { runtimeId: candidate.runtimeId, ...candidate.record.session, pid: candidate.pid }
        : { runtimeId: candidate.runtimeId, ...candidate.foreign });
    }
  });
  // Orphaned capability files (their record is gone) are safe to remove.
  if (cleanup) {
    const records = new Set(names.filter((name) => name.endsWith(".json")).map((name) => name.slice(0, -5)));
    for (const name of names) {
      if (name.endsWith(".key") && !records.has(name.slice(0, -4))) rmSync(join(dir, name), { force: true });
    }
  }
  const groups = new Map();
  for (const record of live) {
    const key = sessionKey(record.session);
    if (!groups.has(key)) groups.set(key, { key: { ...record.session }, runtimes: [], ownerConflict: false });
    groups.get(key).runtimes.push(record);
  }
  for (const group of groups.values()) group.ownerConflict = group.runtimes.length > 1;
  const legacyOwners = legacy ? await cleanupLegacyStores({ baseDir, verifyBatch, cleanup }) : [];
  return {
    live,
    foreign,
    unverified,
    dead,
    corrupt,
    sessions: [...groups.values()],
    legacyOwners,
  };
}

const matchesKey = (claim, { storeAuthority, sessionId }) =>
  claim.sessionId === sessionId && (!claim.storeAuthority || !storeAuthority || claim.storeAuthority === storeAuthority);

/**
 * Who writes this saved session right now? `live` (one verified runtime), `conflict` (several),
 * `unknown` (some process may hold it but we cannot prove which), or `none` — only when proven.
 *
 * `launches` lists open-request launches that may still be starting: `{ sessionId, storeAuthority,
 * pid?, processStartedAt?, alive }` — a launched process without a record yet blocks `none`.
 */
export function ownerOf(scan, key, { launches = [] } = {}) {
  const runtimes = scan.live.filter((record) =>
    record.session.sessionId === key.sessionId && record.session.storeAuthority === key.storeAuthority);
  if (runtimes.length > 1) return { state: "conflict", runtimes };
  if (runtimes.length === 1) return { state: "live", runtime: runtimes[0] };
  if (scan.foreign.some((claim) => matchesKey(claim, key))) return { state: "unknown", reason: "other-version" };
  if (scan.unverified.some((claim) => matchesKey(claim, key))) return { state: "unknown", reason: "unverifiable" };
  if (scan.legacyOwners.some((claim) => matchesKey(claim, key))) return { state: "unknown", reason: "other-version" };
  if (launches.some((launch) => matchesKey(launch, key) && launch.alive !== false)) {
    return { state: "unknown", reason: "launch-pending" };
  }
  return { state: "none" };
}

// ---- pre-0.2.75 stores (LLD §3.4) ------------------------------------------------------------------

const LEGACY_FILES = ["attached-sessions.json", "pending-sessions.json"];
const LEGACY_DIRS = ["launch-operations", "launch-reservations", "launch-identities", ".launch-locks"];

function safeReaddir(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function removeIfEmpty(dir) {
  try {
    if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Already gone.
  }
}

/**
 * Delete pre-0.2.75 session stores, but ONLY entries whose processes are dead. Entries owned by a
 * live old-version process stay until it exits, and are returned so callers treat that saved
 * session as `owner-unknown` (never launching a second writer next to it).
 */
export async function cleanupLegacyStores({
  baseDir,
  verifyBatch = verifyProcessIdentities,
  isAlive = isPidAlive,
  cleanup = true,
} = {}) {
  const home = weftHome(baseDir);
  const owners = [];

  // runtimes/v1/<id>/presence.json
  const runtimesRoot = join(home, "runtimes", "v1");
  const presences = [];
  for (const entry of safeReaddir(runtimesRoot)) {
    if (!entry.isDirectory()) continue;
    const presence = readJson(join(runtimesRoot, entry.name, "presence.json"));
    const claim = foreignClaim(presence);
    if (claim) presences.push({ dir: join(runtimesRoot, entry.name), ...claim });
    else if (cleanup) rmSync(join(runtimesRoot, entry.name), { recursive: true, force: true });
  }
  if (presences.length) {
    const proofs = await verifyBatch(presences);
    presences.forEach((presence, index) => {
      if (proofs?.[index]?.live === false) {
        if (cleanup) rmSync(presence.dir, { recursive: true, force: true });
      } else {
        owners.push({ sessionId: presence.sessionId, storeAuthority: presence.storeAuthority, pid: presence.pid, source: "runtimes" });
      }
    });
  }
  if (cleanup) {
    removeIfEmpty(runtimesRoot);
    removeIfEmpty(join(home, "runtimes"));
  }

  // attached-sessions.json: { [sessionId]: { pid } }, pending-sessions.json: { [channelId]: { pid } }
  for (const fileName of LEGACY_FILES) {
    const map = readRegistry(fileName, { baseDir });
    if (map === null) continue;
    let anyAlive = false;
    for (const [id, entry] of Object.entries(map && typeof map === "object" ? map : {})) {
      if (!isAlive(entry?.pid)) continue;
      anyAlive = true;
      if (fileName === "attached-sessions.json") {
        owners.push({ sessionId: entry.sessionId ?? id, storeAuthority: null, pid: entry.pid, source: "attached" });
      }
    }
    if (!anyAlive && cleanup) rmSync(join(home, fileName), { force: true });
  }

  // launch-operations/*.json carry the launched pid (when known) and the resumed sessionId.
  const operationsDir = join(home, "launch-operations");
  let retainedOperations = 0;
  for (const entry of safeReaddir(operationsDir)) {
    if (!entry.isFile()) continue;
    const file = join(operationsDir, entry.name);
    const operation = readJson(file);
    if (Number.isSafeInteger(operation?.pid) && operation.pid > 0 && isAlive(operation.pid)) {
      retainedOperations += 1;
      if (typeof operation.sessionId === "string" && operation.sessionId) {
        owners.push({ sessionId: operation.sessionId, storeAuthority: null, pid: operation.pid, source: "launch" });
      }
      continue;
    }
    if (cleanup) rmSync(file, { force: true });
  }
  if (cleanup && retainedOperations === 0) {
    for (const name of LEGACY_DIRS) {
      const dir = join(home, name);
      if (name === ".launch-locks") {
        for (const entry of safeReaddir(dir)) {
          const lock = readJson(join(dir, entry.name));
          if (!isAlive(lock?.pid)) rmSync(join(dir, entry.name), { force: true });
        }
        removeIfEmpty(dir);
      } else {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
  return owners;
}

// ---- small shared helpers ------------------------------------------------------------------------

/**
 * Process verification for frequent sweeps: a pid + start time proven live is re-checked cheaply
 * (is the pid still alive?) and fully re-verified (start time) at most every `maxAgeMs`, so a
 * 15 s supervisor does not spawn an OS query per sweep. Anything not recently proven goes to the
 * full batch verifier; a dead pid is always reported immediately.
 */
export function createCachedVerifier({
  verifyBatch = verifyProcessIdentities,
  isAlive = isPidAlive,
  maxAgeMs = 5 * 60_000,
  now = Date.now,
} = {}) {
  const proven = new Map();
  return async (candidates) => {
    const results = new Array(candidates.length);
    const pending = [];
    candidates.forEach((candidate, index) => {
      const key = `${candidate.pid}:${candidate.processStartedAt}`;
      const at = proven.get(key);
      if (at !== undefined && now() - at < maxAgeMs) {
        if (isAlive(candidate.pid)) {
          results[index] = { live: true, cached: true };
          return;
        }
        proven.delete(key);
        results[index] = { live: false, reason: "process-exited" };
        return;
      }
      pending.push(index);
    });
    if (pending.length) {
      const fresh = await verifyBatch(pending.map((index) => candidates[index]));
      pending.forEach((index, position) => {
        results[index] = fresh?.[position] ?? { live: null, reason: "process-unverifiable" };
        const candidate = candidates[index];
        const key = `${candidate.pid}:${candidate.processStartedAt}`;
        if (results[index]?.live === true) proven.set(key, now());
        else proven.delete(key);
      });
    }
    if (proven.size > 512) proven.delete(proven.keys().next().value);
    return results;
  };
}

/** True if a `weft start` Device Station currently holds listener.lock on this machine. */
export function isStationRunning({ baseDir } = {}) {
  const raw = readRegistry("listener.lock", { baseDir });
  const pid = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return isPidAlive(pid);
}

/** Live pairing offers from records (Station derives expiry; it never rewrites a record). */
export function liveOffers(scan, { now = Date.now() } = {}) {
  return scan.live
    .filter((record) => record.offer && (!record.offer.expiresAt || record.offer.expiresAt > now))
    .map((record) => ({
      channelId: record.offer.channelId,
      name: record.offer.name,
      cwd: record.offer.cwd,
      payload: record.offer.payload,
      runtimeId: record.run.runtimeId,
      sessionId: record.session.sessionId,
    }));
}

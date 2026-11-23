// SPDX-License-Identifier: Apache-2.0
//
// Durable open requests (LLD §3.2). Written ONLY by Station:
//
//   ~/.weft/requests/<id>/request.json     the request, its stage/outcome and a monotonic revision
//   ~/.weft/requests/<id>/identity.json    channel + laptop keys handed to a launched session (0600)
//   ~/.weft/requests/.by-session/<key>.lock  held while a non-terminal request targets that session
//
// The per-session lock is the one-writer reservation: a second request for the same saved session
// cannot dispatch until the first one ends. Terminal outcomes never change, revisions only grow,
// and stages never move backwards.
import {
  chmodSync,
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { weftHome } from "./projects.mjs";

export const REQUESTS_DIR = "requests";
export const REQUEST_SCHEMA = 1;
export const REQUEST_RETENTION_MS = 3 * 24 * 60 * 60 * 1_000;
export const STAGES = Object.freeze([
  "accepted",
  "resolving",
  "awaiting-confirmation",
  "dispatching",
  "awaiting-runtime",
  "preparing-link",
]);
export const OUTCOMES = Object.freeze(["done", "failed", "cancelled", "outcome-unknown"]);
/** Stages after which a launch may already be in flight. */
export const DISPATCHED_STAGES = Object.freeze(["dispatching", "awaiting-runtime", "preparing-link"]);

const STAGE_ORDER = new Map([
  ["accepted", 0],
  ["resolving", 1],
  ["awaiting-confirmation", 2],
  ["dispatching", 3],
  ["awaiting-runtime", 4],
  ["preparing-link", 5],
]);

const hash = (value) => createHash("sha256").update(String(value)).digest("hex");

function privateMode(path, mode) {
  try {
    chmodSync(path, mode);
  } catch {
    // Best-effort on Windows.
  }
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  privateMode(tmp, 0o600);
  renameSync(tmp, file);
  privateMode(file, 0o600);
}

export const isTerminal = (record) => Boolean(record?.outcome);
export const wasDispatched = (record) => DISPATCHED_STAGES.includes(record?.stage);

/** `${storeAuthority}-${sessionId}` keyed lock name (hashed: store authorities contain ':'). */
export function sessionLockName({ storeAuthority, sessionId }) {
  return `${hash(`${storeAuthority}\0${sessionId}`).slice(0, 40)}.lock`;
}

/**
 * The request store. Station is a single process (listener.lock), so per-request mutations are
 * serialized in memory; the per-session lock is an exclusive file so a crash leaves evidence.
 */
export function createOpenRequests({ baseDir, now = Date.now } = {}) {
  const root = () => {
    const dir = join(weftHome(baseDir), REQUESTS_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    privateMode(dir, 0o700);
    return dir;
  };
  const lockDir = () => {
    const dir = join(root(), ".by-session");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  };
  const requestDir = (requestId) => join(root(), hash(requestId).slice(0, 40));
  const requestFile = (requestId) => join(requestDir(requestId), "request.json");
  const chains = new Map();

  function serialize(requestId, fn) {
    const previous = chains.get(requestId) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.catch(() => {});
    chains.set(requestId, settled);
    settled.then(() => {
      if (chains.get(requestId) === settled) chains.delete(requestId);
    });
    return run;
  }

  function read(requestId) {
    if (typeof requestId !== "string" || !requestId) return null;
    const record = readJson(requestFile(requestId));
    return record?.requestId === requestId && record.schema === REQUEST_SCHEMA ? record : null;
  }

  function write(record) {
    mkdirSync(requestDir(record.requestId), { recursive: true, mode: 0o700 });
    writeJsonAtomic(requestFile(record.requestId), record);
    return record;
  }

  function tryLock(key, requestId) {
    const file = join(lockDir(), sessionLockName(key));
    for (let tries = 0; tries < 3; tries += 1) {
      try {
        const fd = openSync(file, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ requestId, ...key, createdAt: now() }), "utf8");
        } finally {
          closeSync(fd);
        }
        return { held: true };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const owner = readJson(file);
        if (owner?.requestId === requestId) return { held: true };
        const holder = owner?.requestId ? read(owner.requestId) : null;
        // A lock whose request ended (or vanished) is stale evidence; recover it.
        if (!holder || isTerminal(holder)) {
          try { unlinkSync(file); } catch { /* raced */ }
          continue;
        }
        return { held: false, heldBy: holder.requestId };
      }
    }
    return { held: false, heldBy: null };
  }

  function releaseLock(record) {
    const key = record?.lockKey;
    if (!key) return;
    const file = join(lockDir(), sessionLockName(key));
    const owner = readJson(file);
    if (owner?.requestId === record.requestId) {
      try { unlinkSync(file); } catch { /* already gone */ }
    }
  }

  function create({ requestId, fingerprint, requester, target, options, lockKey = null, extra = {} }) {
    const at = now();
    return write({
      schema: REQUEST_SCHEMA,
      requestId,
      revision: 0,
      fingerprint,
      requester: requester ?? null,
      target,
      options,
      lockKey,
      stage: "accepted",
      outcome: null,
      reason: null,
      result: null,
      joinedRequestId: null,
      createdAt: at,
      updatedAt: at,
      dispatchedAt: null,
      finishedAt: null,
      ...extra,
    });
  }

  return Object.freeze({
    read,

    /**
     * Accept a request idempotently. `lockKey` ({storeAuthority, sessionId}) reserves an existing
     * session. Returns `{ kind: "created" | "duplicate" | "conflict" | "joined", record }`.
     * `joined` means another non-terminal request already holds the session: this request is
     * recorded as following it (it never dispatches anything itself).
     */
    begin({ requestId, fingerprint, requester = null, target, options = {}, lockKey = null }) {
      if (typeof requestId !== "string" || !requestId.trim()) throw new TypeError("requestId is required");
      return serialize(requestId, async () => {
        const existing = read(requestId);
        if (existing) {
          return { kind: existing.fingerprint === fingerprint ? "duplicate" : "conflict", record: existing };
        }
        if (lockKey) {
          const lock = tryLock(lockKey, requestId);
          if (!lock.held) {
            return {
              kind: "joined",
              record: create({ requestId, fingerprint, requester, target, options, lockKey: null,
                extra: { joinedRequestId: lock.heldBy } }),
            };
          }
        }
        return { kind: "created", record: create({ requestId, fingerprint, requester, target, options, lockKey }) };
      });
    },

    /**
     * Apply `patch` if `expectRevision` (when given) is still current. Terminal outcomes and stage
     * order are enforced here, so a late writer can never resurrect or rewind a request.
     * Returns `{ applied, record }`.
     */
    update(requestId, patch = {}, { expectRevision } = {}) {
      return serialize(requestId, async () => {
        const current = read(requestId);
        if (!current) return { applied: false, record: null };
        if (Number.isSafeInteger(expectRevision) && current.revision !== expectRevision) {
          return { applied: false, record: current };
        }
        if (isTerminal(current)) return { applied: false, record: current };
        const stage = patch.stage && (STAGE_ORDER.get(patch.stage) ?? -1) >= (STAGE_ORDER.get(current.stage) ?? 0)
          ? patch.stage
          : current.stage;
        const at = now();
        const next = {
          ...current,
          ...patch,
          schema: REQUEST_SCHEMA,
          requestId: current.requestId,
          fingerprint: current.fingerprint,
          target: current.target,
          lockKey: current.lockKey,
          stage,
          result: patch.result === undefined ? current.result
            : patch.result === null ? null : { ...(current.result ?? {}), ...patch.result },
          revision: current.revision + 1,
          updatedAt: at,
        };
        if (DISPATCHED_STAGES.includes(stage) && !current.dispatchedAt) next.dispatchedAt = at;
        if (patch.outcome) {
          if (!OUTCOMES.includes(patch.outcome)) throw new TypeError(`unknown outcome ${patch.outcome}`);
          next.finishedAt = at;
        }
        write(next);
        if (next.outcome) releaseLock(next);
        return { applied: true, record: next };
      });
    },

    list({ nonTerminal = false } = {}) {
      const records = [];
      for (const entry of (() => { try { return readdirSync(root(), { withFileTypes: true }); } catch { return []; } })()) {
        if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
        const record = readJson(join(root(), entry.name, "request.json"));
        if (record?.schema !== REQUEST_SCHEMA || typeof record.requestId !== "string") continue;
        if (nonTerminal && isTerminal(record)) continue;
        records.push(record);
      }
      return records.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    },

    /** Where a launch's private handoff identity is written (by the terminal launcher, exclusively). */
    identityPath(requestId) {
      mkdirSync(requestDir(requestId), { recursive: true, mode: 0o700 });
      return join(requestDir(requestId), "identity.json");
    },

    /** Station start: drop lock files whose request ended or vanished. */
    recoverLocks() {
      for (const name of (() => { try { return readdirSync(lockDir()); } catch { return []; } })()) {
        const file = join(lockDir(), name);
        const owner = readJson(file);
        const holder = owner?.requestId ? read(owner.requestId) : null;
        if (!holder || isTerminal(holder)) {
          try { unlinkSync(file); } catch { /* raced */ }
        }
      }
    },

    /**
     * Delete finished requests older than the retention window unless a live session record still
     * references them (`openedBy.requestId`). Non-terminal requests are never pruned.
     */
    prune({ at = now(), retentionMs = REQUEST_RETENTION_MS, isReferenced = () => false } = {}) {
      let removed = 0;
      for (const record of this.list()) {
        if (!isTerminal(record) || at - (record.finishedAt ?? record.updatedAt ?? at) <= retentionMs) continue;
        if (isReferenced(record.requestId)) continue;
        rmSync(requestDir(record.requestId), { recursive: true, force: true });
        removed += 1;
      }
      return removed;
    },
  });
}

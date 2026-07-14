// SPDX-License-Identifier: Apache-2.0
//
// The laptop side of "offer an in-session `/weft` to a running Device Station" (the mirror image of
// the phone-driven spawn flow). A live `/weft` session cannot talk to the station↔phone encrypted
// channel directly (it doesn't hold that ECDH shared key — only the station and phone do), so it
// instead drops its own SESSION pairing payload into a small shared registry file under ~/.weft and
// the station relays it to the paired phone as a SESSION_OFFERS control message (see listener.mjs).
//
// Ownership model (deliberately single-writer-per-entry to stay race-safe, matching the
// connections.json pattern in listener.mjs):
//   - Each `/weft` session is the sole writer of its OWN entry, keyed by its channelId: it adds the
//     entry when the user runs `/weft` while a station is up, and removes it the moment a phone
//     actually pairs to the session (or on shutdown).
//   - The station is a reader: it prunes dead-pid entries in-memory on every read and never needs to
//     write. It MAY also remove an entry on SESSION_CLAIMED, but that's an idempotent delete of the
//     same key the owning session removes too, so the two never fight over other keys.
// Dead entries (a session that crashed without cleanup) self-heal: prune() drops them from every
// read, and the next session's upsert rewrites the file without them.
import { readRegistry, writeRegistryAtomic, isPidAlive } from "./registryFile.mjs";

const PENDING_FILE = "pending-sessions.json";
// The standalone Device Station records its pid here (see bin/weft.mjs acquireLock()). It's a bare
// pid, but a bare integer is still valid JSON, so readRegistry() parses it fine.
const STATION_LOCK_FILE = "listener.lock";

/** True if a standalone `weft start` Device Station is currently running on this machine. */
export function isStationRunning({ baseDir } = {}) {
  const raw = readRegistry(STATION_LOCK_FILE, { baseDir });
  const pid = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return isPidAlive(pid);
}

/** Drop any pending entries whose owning `/weft` process has exited — keeps the file self-cleaning
 *  without a separate GC pass (same approach as listener.mjs's pruneDeadConnections). */
function pruneDead(map) {
  const next = {};
  for (const [channelId, entry] of Object.entries(map ?? {})) {
    if (entry && typeof entry === "object" && isPidAlive(entry.pid)) next[channelId] = entry;
  }
  return next;
}

/**
 * The live set of pending `/weft` session offers, as `[{ channelId, name, cwd, payload }]`. Dead
 * entries are pruned from the returned view. Malformed entries (missing channelId/payload) are
 * dropped so a corrupt file can never wedge the station's offer relay.
 */
export function listPendingSessions({ baseDir } = {}) {
  const map = pruneDead(readRegistry(PENDING_FILE, { baseDir }));
  return Object.values(map)
    .filter((e) => e && typeof e.channelId === "string" && e.payload)
    .map((e) => ({
      channelId: e.channelId,
      name: typeof e.name === "string" && e.name.length > 0 ? e.name : null,
      cwd: typeof e.cwd === "string" && e.cwd.length > 0 ? e.cwd : null,
      payload: e.payload,
    }));
}

/**
 * Register (or refresh) THIS `/weft` session's offer, keyed by its channelId. `payload` is the
 * session's own buildPairingPayload() result (the same object shown in its QR). Best-effort; a
 * failed write only means the station won't discover this session, never a fatal error for the
 * session itself. Reads back once and rewrites if a concurrent writer clobbered our entry.
 */
export function registerPendingSession({ channelId, name = null, cwd = null, payload }, { baseDir } = {}) {
  if (!channelId || !payload) return false;
  const entry = { channelId, name: name ?? null, cwd: cwd ?? null, payload, pid: process.pid, ts: Date.now() };
  const map = pruneDead(readRegistry(PENDING_FILE, { baseDir }));
  map[channelId] = entry;
  writeRegistryAtomic(PENDING_FILE, map, { baseDir });
  // Single reconciliation pass: if a near-simultaneous writer's rename landed after ours and
  // dropped our key, merge it back in. Low-frequency (only two `/weft` invoked within ms).
  const readBack = readRegistry(PENDING_FILE, { baseDir });
  if (!readBack || !readBack[channelId]) {
    const merged = pruneDead(readBack);
    merged[channelId] = entry;
    writeRegistryAtomic(PENDING_FILE, merged, { baseDir });
  }
  return true;
}

/** Remove an offer by channelId (idempotent). Called by the owning session when a phone pairs to
 *  it or on shutdown, and by the station on SESSION_CLAIMED. */
export function removePendingSession(channelId, { baseDir } = {}) {
  if (!channelId) return;
  const map = pruneDead(readRegistry(PENDING_FILE, { baseDir }));
  if (Object.prototype.hasOwnProperty.call(map, channelId)) {
    delete map[channelId];
    writeRegistryAtomic(PENDING_FILE, map, { baseDir });
  }
}

/** Exposed for the station's file watcher so it doesn't hard-code the filename. */
export const PENDING_SESSIONS_FILE = PENDING_FILE;

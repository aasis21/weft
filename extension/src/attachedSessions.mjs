// SPDX-License-Identifier: Apache-2.0
//
// "Which CLI session is currently attached to a phone, and is that attachment actually healthy?"
//
// The station handles RESUME_SESSION by spawning `copilot --resume=<id>`. Nothing stopped it doing
// that for a session already running and paired, which left two CLI processes writing one
// session-store entry. The phone can only catch a subset of those collisions: it recognises a
// session by the sessionId its own cards report, so it is blind to a session that is live on this
// laptop but has no card on THIS phone — a different phone, a deleted card, a fresh install. This
// registry is what lets the laptop answer for itself.
//
// Ownership model — single-writer-per-entry, the same shape as pendingSessions.mjs:
//   - Each `/weft` session is the sole writer of its OWN entry, keyed by its CLI sessionId: it
//     records the attachment when a phone pairs, refreshes `lastHealthyAt` on every heartbeat, and
//     removes the entry when the phone goes away or the process shuts down.
//   - The station is a reader. It prunes dead-pid entries on every read and never writes.
// A session that crashes without cleanup self-heals: prune() drops it from every read.
//
// Liveness is deliberately NOT "is the pid alive". A pid says the copilot process exists, not that
// weft inside it is still talking to anyone — and if weft is wedged, resume is the user's ONLY way
// back. A pid-only guard would refuse to spawn, hand back a pairing nobody is listening on, and
// leave them with no route at all. So an entry has to keep proving itself: `lastHealthyAt` is
// stamped by the session's own heartbeat, and an entry that has stopped stamping is treated as
// unattached no matter what its pid says.
import { readRegistry, writeRegistryAtomic, isPidAlive } from "./registryFile.mjs";

const ATTACHED_FILE = "attached-sessions.json";

/** How long an entry may go without a heartbeat stamp before the station stops believing it.
 *  Deliberately several missed beats rather than one: a single late stamp is normal (the laptop
 *  slept a moment, the event loop was busy), and treating that as "wedged" would let a stray
 *  double-tap fork a second process onto a perfectly healthy session. Against relay.mjs's 15s
 *  heartbeat this is eight consecutive misses — long enough to ride out a hiccup, short enough that
 *  a genuinely wedged session doesn't block recovery for more than a couple of minutes. */
export const HEALTHY_WINDOW_MS = 2 * 60 * 1_000;

function prune(map) {
  const next = {};
  for (const [sessionId, entry] of Object.entries(map ?? {})) {
    if (entry && typeof entry === "object" && isPidAlive(entry.pid)) next[sessionId] = entry;
  }
  return next;
}

/** Every attachment this machine currently believes in, dead pids already dropped. */
export function listAttachedSessions({ baseDir } = {}) {
  const map = prune(readRegistry(ATTACHED_FILE, { baseDir }));
  return Object.values(map)
    .filter((e) => typeof e.sessionId === "string" && e.sessionId.length > 0)
    .map((e) => ({
      sessionId: e.sessionId,
      channelId: typeof e.channelId === "string" ? e.channelId : null,
      cwd: typeof e.cwd === "string" ? e.cwd : null,
      pid: e.pid,
      boundAt: e.boundAt ?? null,
      lastHealthyAt: typeof e.lastHealthyAt === "number" ? e.lastHealthyAt : 0,
    }));
}

/**
 * What the station needs to decide whether to spawn a resume. Returns null when the session is not
 * attached at all, otherwise the entry plus a `healthy` flag.
 *
 * `healthy: false` means "a process holds this session but weft in it has gone quiet" — the case
 * where resuming is the recovery, so the caller should spawn rather than hand back a dead pairing.
 */
export function findAttachedSession(sessionId, { baseDir, now = Date.now() } = {}) {
  if (!sessionId) return null;
  const entry = listAttachedSessions({ baseDir }).find((e) => e.sessionId === sessionId);
  if (!entry) return null;
  return { ...entry, healthy: now - entry.lastHealthyAt < HEALTHY_WINDOW_MS };
}

/**
 * Record (or refresh) THIS session's attachment. Called when a phone pairs and again on every
 * heartbeat — the refresh is the whole point, since a stamp that stops advancing is what tells the
 * station this session can be resumed out from under itself. Best-effort: a failed write only
 * costs the guard, never the session.
 */
export function recordAttachedSession(
  { sessionId, channelId, cwd = null },
  { baseDir, now = Date.now() } = {},
) {
  if (!sessionId || !channelId) return false;
  const map = prune(readRegistry(ATTACHED_FILE, { baseDir }));
  const previous = map[sessionId];
  map[sessionId] = {
    sessionId,
    channelId,
    cwd: cwd ?? previous?.cwd ?? null,
    pid: process.pid,
    boundAt: previous?.pid === process.pid ? (previous.boundAt ?? now) : now,
    lastHealthyAt: now,
  };
  writeRegistryAtomic(ATTACHED_FILE, map, { baseDir });
  return true;
}

/** Drop this session's attachment (idempotent) — the phone disconnected, or we're shutting down. */
export function clearAttachedSession(sessionId, { baseDir } = {}) {
  if (!sessionId) return;
  const map = prune(readRegistry(ATTACHED_FILE, { baseDir }));
  if (Object.prototype.hasOwnProperty.call(map, sessionId)) {
    delete map[sessionId];
    writeRegistryAtomic(ATTACHED_FILE, map, { baseDir });
  }
}

/** Exposed so tests and any future watcher don't hard-code the filename. */
export const ATTACHED_SESSIONS_FILE = ATTACHED_FILE;

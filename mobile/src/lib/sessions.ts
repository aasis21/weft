import { Preferences } from '@capacitor/preferences';
import type { StoredPairing } from './storage';
import { loadStoredPairing } from './storage';
import { freeSpaceUntilFitsSync } from './storageJanitor';
import { clearTranscript } from './transcripts';
import { clearEventLog } from './eventLog';

const SESSIONS_KEY = 'weft.sessions.v1';

interface SessionsStore {
  sessions: StoredSession[];
  lastActiveId: string | null;
}

/** A joined session: the ECDH pairing material plus light display metadata. */
export interface StoredSession {
  pairing: StoredPairing;
  /** The durable Copilot session id this card mirrors (learned from channel_up). Used to dedupe
   *  cards across channels/resumes. Optional: older stored entries won't have it. */
  sessionId?: string | null;
  title: string | null;
  cwd: string | null;
  addedAt: number;
  lastSeenAt: number;
  /** Last real host activity (ms). Drives newest-first ordering + warm-pool recency across reloads.
   *  Optional: older stored entries won't have it. */
  lastEventAt?: number | null;
  /** Last observed heartbeat pulse (ms) — the liveness clock. Drives boot-probe ordering and the
   *  2h auto-archive rule. Persisted (throttled) so a reload knows how recently the laptop was alive
   *  (#163). Optional: older stored entries won't have it. */
  lastHeartbeatAt?: number | null;
  /** Last moment (ms) the running app *witnessed* this session — advanced by the watchdog while the
   *  app is foreground (whether subscribed OR archived/cold). Because the watchdog only ticks while
   *  the app is alive, phone-off time never advances it. The 2-day auto-delete measures WITNESSED
   *  silence (`lastSubscribedAt − lastHeartbeatAt`), so a still-alive laptop is never auto-deleted
   *  (#163). Optional on legacy entries. */
  lastSubscribedAt?: number | null;
  /** User-pinned (#163): exempt from warm-pool eviction preference AND the 2-day auto-delete. */
  pinned?: boolean;
  /** Whether the session has unread host activity, persisted so a reload keeps the badge. */
  unread?: boolean;
  /** Number of unread host turns/events, persisted so a reload keeps the "N new" count. */
  unreadCount?: number;
  /** True once the user renamed this session on the phone; keeps the CLI title from overriding the
   *  user's chosen name after reload/resume (#37). */
  renamed?: boolean;
  /** Stable listener `deviceId` that spawned this session (see SessionMeta.spawnedFromDeviceId),
   *  persisted so the Device details screen survives reload. */
  spawnedFromDeviceId?: string;
  /** Display name of the spawning device at spawn time. */
  spawnedFromDeviceName?: string;
}

function isStoredSession(value: unknown): value is StoredSession {
  const pairing = (value as Partial<StoredSession> | undefined)?.pairing;
  // Sessions cached before the transport-descriptor refactor won't have `pairing.transport` —
  // reject them here (rather than crash on reconnect) so they're silently dropped from the list;
  // the user just rescans the QR to re-pair with a fresh, transport-carrying payload.
  return !!value && typeof value === 'object' && !!pairing?.channelId && !!pairing?.transport?.kind;
}

function normalizeStore(parsed: unknown): SessionsStore {
  if (Array.isArray(parsed)) {
    return { sessions: parsed.filter(isStoredSession), lastActiveId: null };
  }
  if (!parsed || typeof parsed !== 'object') return { sessions: [], lastActiveId: null };
  const blob = parsed as { sessions?: unknown; lastActiveId?: unknown };
  return {
    sessions: Array.isArray(blob.sessions) ? blob.sessions.filter(isStoredSession) : [],
    lastActiveId: typeof blob.lastActiveId === 'string' ? blob.lastActiveId : null,
  };
}

/** Extract every `pairing.channelId` present in the raw stored blob — INCLUDING entries that
 *  `isStoredSession` will reject (e.g. legacy sessions with no transport descriptor). Lets the load
 *  path reclaim transcript/event-log keys for entries it silently drops. */
function collectRawChannelIds(parsed: unknown): string[] {
  const arr: unknown[] = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { sessions?: unknown }).sessions)
      ? ((parsed as { sessions: unknown[] }).sessions)
      : [];
  const ids: string[] = [];
  for (const entry of arr) {
    const ch = (entry as Partial<StoredSession> | undefined)?.pairing?.channelId;
    if (typeof ch === 'string' && ch) ids.push(ch);
  }
  return ids;
}

async function readStoreRaw(): Promise<{ store: SessionsStore; rawChannelIds: string[] }> {
  try {
    const { value } = await Preferences.get({ key: SESSIONS_KEY });
    const raw = value ?? globalThis.localStorage?.getItem(SESSIONS_KEY);
    if (!raw) return { store: { sessions: [], lastActiveId: null }, rawChannelIds: [] };
    const parsed: unknown = JSON.parse(raw);
    return { store: normalizeStore(parsed), rawChannelIds: collectRawChannelIds(parsed) };
  } catch {
    return { store: { sessions: [], lastActiveId: null }, rawChannelIds: [] };
  }
}

async function readStore(): Promise<SessionsStore> {
  return (await readStoreRaw()).store;
}

async function read(): Promise<StoredSession[]> {
  return (await readStore()).sessions;
}

/** True for a localStorage/Preferences QuotaExceededError across browser engines. DOMException is not
 *  reliably an Error subclass in every engine, so match structurally by name/code rather than type. */
function isQuotaError(err: unknown): boolean {
  const e = err as { name?: string; code?: number } | null;
  if (!e || typeof e !== 'object') return false;
  return (
    e.name === 'QuotaExceededError' ||
    e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || // Firefox
    e.code === 22 ||
    e.code === 1014
  );
}

async function writeStore(store: SessionsStore): Promise<void> {
  const value = JSON.stringify(store);
  // Mirror to localStorage FIRST and never let a Preferences backend failure skip it. Previously this
  // did `await Preferences.set(...)` with no guard, so if the Preferences plugin threw (web/private
  // mode, quota, missing web impl) the mirror below was never reached and the joined channel IDs were
  // silently lost across a refresh (#186). Both stores are attempted; the read path already prefers
  // whichever has data.
  try {
    globalThis.localStorage?.setItem(SESSIONS_KEY, value);
  } catch (err) {
    // A QuotaExceededError here used to silently drop the session list, making freshly-created chats
    // vanish on refresh (they only lived in the in-memory store). The session list + pairing are the
    // connection — they must never be lost. Free space by evicting the heavy, regenerable transcript
    // and debug-log stores (worst-first: orphans → oldest cold; the active session's transcript is
    // protected), then retry. Transcripts re-hydrate from the laptop on reconnect, so this is safe.
    if (isQuotaError(err)) {
      freeSpaceUntilFitsSync(SESSIONS_KEY, value, {
        validChannelIds: store.sessions.map((s) => s.pairing.channelId),
        protectChannelIds: store.lastActiveId ? [store.lastActiveId] : [],
      });
    }
    // Otherwise localStorage is unavailable/blocked (private mode) — Preferences below is the store.
  }
  try {
    await Preferences.set({ key: SESSIONS_KEY, value });
  } catch {
    // Native/web Preferences backend unavailable — the localStorage mirror above already holds it.
  }
}

async function write(list: StoredSession[]): Promise<void> {
  const { lastActiveId } = await readStore();
  await writeStore({ sessions: list, lastActiveId });
}

/** Rank used to pick the winner among stored entries sharing a sessionId, compared lexicographically:
 *  most-recent scan (`pairing.savedAt`, bumped on every re-pair) first, then real host activity
 *  (`lastEventAt`), then the last *open* time (`lastSeenAt`). Preferring scan time means a crash
 *  between a `copilot --resume` re-scan and `channel_up` keeps the freshly-scanned channel, not the
 *  old dead one that merely happened to be opened more recently (#130); the lower tiers still break
 *  ties when two entries were scanned at the same instant. */
function dedupeRank(s: StoredSession): [number, number, number] {
  return [s.pairing?.savedAt ?? 0, s.lastEventAt ?? 0, s.lastSeenAt ?? 0];
}

function rankNewer(a: StoredSession, b: StoredSession): boolean {
  const ra = dedupeRank(a);
  const rb = dedupeRank(b);
  for (let i = 0; i < ra.length; i++) {
    if (ra[i] !== rb[i]) return ra[i] > rb[i];
  }
  return false;
}

/** Collapse stored entries that share a real sessionId (e.g. a session re-paired under a new
 *  channelId before the live reconcile removed the old one). Keeps the most-recently-active channel,
 *  preserving list order. */
function dedupeBySessionId(list: StoredSession[]): StoredSession[] {
  const seen = new Map<string, StoredSession>();
  const out: StoredSession[] = [];
  for (const s of list) {
    const sid = s.sessionId;
    if (!sid || sid === 'unknown-session') {
      out.push(s);
      continue;
    }
    const prior = seen.get(sid);
    if (!prior) {
      seen.set(sid, s);
      out.push(s);
    } else if (rankNewer(s, prior)) {
      seen.set(sid, s);
      const idx = out.indexOf(prior);
      if (idx >= 0) out[idx] = s;
    }
  }
  return out;
}

/**
 * Load every joined session. Transparently migrates a single legacy
 * `weft.pairing.v1` entry into the multi-session list on first run.
 */
export async function loadSessions(): Promise<StoredSession[]> {
  const { store, rawChannelIds } = await readStoreRaw();
  const list = dedupeBySessionId(store.sessions);

  // Reclaim storage at the source for entries dropped on load — legacy sessions rejected by
  // isStoredSession (no transport descriptor) and cards collapsed by dedupeBySessionId — whose
  // transcript/event-log keys would otherwise linger as orphans until the boot sweep. Best-effort;
  // the data is regenerable from the laptop, so a failure here is harmless.
  const kept = new Set(list.map((s) => s.pairing.channelId));
  for (const id of rawChannelIds) {
    if (kept.has(id)) continue;
    void clearTranscript(id).catch(() => {});
    void clearEventLog(id).catch(() => {});
  }

  if (list.length > 0) return list;
  const legacy = await loadStoredPairing();
  if (legacy?.channelId && legacy.publicKeyB64) {
    const migrated: StoredSession = {
      pairing: legacy,
      title: null,
      cwd: null,
      addedAt: legacy.savedAt ?? Date.now(),
      lastSeenAt: legacy.savedAt ?? Date.now(),
    };
    await write([migrated]);
    return [migrated];
  }
  return [];
}

export async function loadLastActiveSessionId(): Promise<string | null> {
  return (await readStore()).lastActiveId;
}

export async function setLastActiveSessionId(channelId: string | null): Promise<void> {
  const { sessions } = await readStore();
  await writeStore({ sessions, lastActiveId: channelId });
}

export async function upsertSession(session: StoredSession): Promise<void> {
  const list = await read();
  const next = [
    ...list.filter((s) => s.pairing.channelId !== session.pairing.channelId),
    session,
  ];
  await write(next);
}

export async function patchSession(
  channelId: string,
  patch: Partial<
    Pick<
      StoredSession,
      | 'title'
      | 'cwd'
      | 'lastSeenAt'
      | 'sessionId'
      | 'lastEventAt'
      | 'lastHeartbeatAt'
      | 'lastSubscribedAt'
      | 'pinned'
      | 'unread'
      | 'unreadCount'
      | 'renamed'
      | 'spawnedFromDeviceId'
      | 'spawnedFromDeviceName'
    >
  >,
): Promise<void> {
  const list = await read();
  let changed = false;
  const next = list.map((s) => {
    if (s.pairing.channelId !== channelId) return s;
    changed = true;
    return { ...s, ...patch };
  });
  if (changed) await write(next);
}

export async function removeSession(channelId: string): Promise<void> {
  const list = await read();
  await write(list.filter((s) => s.pairing.channelId !== channelId));
}

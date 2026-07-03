import { Preferences } from '@capacitor/preferences';
import type { StoredPairing } from './storage';
import { loadStoredPairing } from './storage';

const SESSIONS_KEY = 'helm.sessions.v1';

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
  /** Whether the session has unread host activity, persisted so a reload keeps the badge. */
  unread?: boolean;
  /** Number of unread host turns/events, persisted so a reload keeps the "N new" count. */
  unreadCount?: number;
  /** True once the user renamed this session on the phone; keeps the CLI title from overriding the
   *  user's chosen name after reload/resume (#37). */
  renamed?: boolean;
}

async function read(): Promise<StoredSession[]> {
  try {
    const { value } = await Preferences.get({ key: SESSIONS_KEY });
    const raw = value ?? globalThis.localStorage?.getItem(SESSIONS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as StoredSession[];
    return Array.isArray(parsed) ? parsed.filter((s) => s?.pairing?.channelId) : [];
  } catch {
    return [];
  }
}

async function write(list: StoredSession[]): Promise<void> {
  const value = JSON.stringify(list);
  await Preferences.set({ key: SESSIONS_KEY, value });
  globalThis.localStorage?.setItem(SESSIONS_KEY, value);
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
 * `helm.pairing.v1` entry into the multi-session list on first run.
 */
export async function loadSessions(): Promise<StoredSession[]> {
  const list = dedupeBySessionId(await read());
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
    Pick<StoredSession, 'title' | 'cwd' | 'lastSeenAt' | 'sessionId' | 'lastEventAt' | 'unread' | 'unreadCount' | 'renamed'>
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

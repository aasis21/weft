import { Preferences } from '@capacitor/preferences';
import { compactTranscript } from './transcripts';

// Storage auto-clean ("janitor").
//
// On the web/PWA build there is no native Preferences backend, so EVERYTHING the app persists
// (session list, pairing, transcripts, debug event logs) lands in the browser's localStorage,
// which Chrome caps at ~5 MB per origin. When that cap is hit, `localStorage.setItem` throws
// `QuotaExceededError` and the write is silently lost — most painfully the session-list write
// (`weft.sessions.v1`), which made freshly-created chats vanish on refresh (they only lived in the
// in-memory store).
//
// This module frees space WITHOUT ever losing what matters. It only evicts the two heavy,
// fully-regenerable stores — per-channel transcripts (`weft.transcript.v1.*`) and per-channel debug
// event logs (`weft.eventlog.v1.*`). Both are re-hydrated from the laptop on reconnect (recent-turns
// replay), so dropping them costs nothing durable. The PRECIOUS keys below — the session list, the
// pairing/device material that IS the connection, and small settings — are never touched.

/** Keys that carry the session list, pairing/connection material, and settings. NEVER evicted. */
const PRECIOUS_KEYS: ReadonlySet<string> = new Set([
  'weft.sessions.v1',
  'weft.pairing.v1',
  'weft.devices.v1',
  'weft.settings.v1',
  'weft.deviceId.v1',
  'weft.debugMode.v1',
]);

const TRANSCRIPT_PREFIX = 'weft.transcript.v1.';
const EVENTLOG_PREFIX = 'weft.eventlog.v1.';

/** Soft target for total localStorage usage, measured in UTF-16 code units (what the browser caps).
 *  Chrome's ~5 MB per-origin limit is ~2.6M code units; we trim to well under half that so a burst of
 *  transcript writes has ample headroom before it can ever hit the cap. */
const SOFT_BUDGET_CHARS = 1_500_000;

/** When compacting a cold/archived transcript to free space, keep at most this many recent items and
 *  drop the paginated history entirely — enough to show the chat's latest context, re-pulling older
 *  turns from the laptop on demand. */
const COMPACT_MAX_ITEMS = 40;

type PrunableKind = 'eventlog' | 'transcript';

interface PrunableEntry {
  key: string;
  kind: PrunableKind;
  channelId: string;
  savedAt: number;
  /** UTF-16 code units this entry occupies (key + value), i.e. its localStorage weight. */
  chars: number;
}

function ls(): Storage | undefined {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
}

function classify(key: string): { kind: PrunableKind; channelId: string } | null {
  if (key.startsWith(TRANSCRIPT_PREFIX)) {
    return { kind: 'transcript', channelId: key.slice(TRANSCRIPT_PREFIX.length) };
  }
  if (key.startsWith(EVENTLOG_PREFIX)) {
    return { kind: 'eventlog', channelId: key.slice(EVENTLOG_PREFIX.length) };
  }
  return null;
}

function parseSavedAt(value: string | null): number {
  if (!value) return 0;
  try {
    const savedAt = (JSON.parse(value) as { savedAt?: unknown }).savedAt;
    return typeof savedAt === 'number' && Number.isFinite(savedAt) ? savedAt : 0;
  } catch {
    return 0;
  }
}

/** Snapshot every prunable (transcript / event-log) entry currently in localStorage. */
function listPrunable(store: Storage): PrunableEntry[] {
  const out: PrunableEntry[] = [];
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key || PRECIOUS_KEYS.has(key)) continue;
    const meta = classify(key);
    if (!meta) continue;
    const value = store.getItem(key);
    out.push({
      key,
      kind: meta.kind,
      channelId: meta.channelId,
      savedAt: parseSavedAt(value),
      chars: key.length + (value?.length ?? 0),
    });
  }
  return out;
}

/** Total localStorage weight (UTF-16 code units across all keys + values). */
export function estimateUsageChars(): number {
  const store = ls();
  if (!store) return 0;
  let total = 0;
  for (let i = 0; i < store.length; i++) {
    const key = store.key(i);
    if (!key) continue;
    total += key.length + (store.getItem(key)?.length ?? 0);
  }
  return total;
}

/** A human-facing usage snapshot for an on-phone storage meter. */
export function usageSnapshot(): { chars: number; bytes: number; budgetChars: number; ratio: number } {
  const chars = estimateUsageChars();
  return {
    chars,
    bytes: chars * 2,
    budgetChars: SOFT_BUDGET_CHARS,
    ratio: chars / SOFT_BUDGET_CHARS,
  };
}

/**
 * Order prunable entries worst-first (evict from the front):
 *   1. orphans   — channel not in the live session/device set (crashed/reconciled leftovers)
 *   2. event logs — debug-only, oldest first
 *   3. transcripts — oldest first
 * Protected channels (the active + warm sessions) are pushed to the very back so they're only ever
 * sacrificed as a last resort to keep the precious session-list write alive.
 */
function orderedEvictionCandidates(
  entries: PrunableEntry[],
  validChannelIds: ReadonlySet<string>,
  protectChannelIds: ReadonlySet<string>,
): PrunableEntry[] {
  const rank = (e: PrunableEntry): number => {
    const orphan = !validChannelIds.has(e.channelId);
    const protectedCh = protectChannelIds.has(e.channelId);
    // Lower rank = evict earlier.
    if (protectedCh) return e.kind === 'eventlog' ? 8 : 9;
    if (orphan) return e.kind === 'eventlog' ? 0 : 1;
    return e.kind === 'eventlog' ? 2 : 3;
  };
  return [...entries].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return a.savedAt - b.savedAt; // oldest first within a tier
  });
}

function removeSync(store: Storage, key: string): void {
  try {
    store.removeItem(key);
  } catch {
    /* ignore */
  }
  // Keep the native Preferences copy in sync too (best-effort, async).
  void Preferences.remove({ key }).catch(() => {});
}

/**
 * EMERGENCY (synchronous): free just enough room so a critical `localStorage.setItem(key, value)`
 * succeeds, then return whether it did. Evicts prunable entries one at a time (worst-first) and
 * retries the write after each removal, so it removes the minimum necessary. Used by the session-list
 * writer to guarantee the list + pairing are never dropped on a QuotaExceededError.
 */
export function freeSpaceUntilFitsSync(
  targetKey: string,
  targetValue: string,
  opts: { validChannelIds: Iterable<string>; protectChannelIds?: Iterable<string> },
): boolean {
  const store = ls();
  if (!store) return false;
  const valid = new Set(opts.validChannelIds);
  const protectedCh = new Set(opts.protectChannelIds ?? []);
  const candidates = orderedEvictionCandidates(listPrunable(store), valid, protectedCh);
  const trySet = (): boolean => {
    try {
      store.setItem(targetKey, targetValue);
      return true;
    } catch {
      return false;
    }
  };
  if (trySet()) return true;
  for (const entry of candidates) {
    removeSync(store, entry.key);
    if (trySet()) return true;
  }
  return trySet();
}

/**
 * PROACTIVE (async): keep localStorage tidy. Always drops orphaned transcripts/event-logs (channels
 * no longer in the live set), then, if still over the soft budget, trims the oldest cold entries down
 * toward the budget — never evicting a protected (active/warm) channel unless nothing else remains.
 * Safe to call on every boot and opportunistically after persist bursts.
 */
export async function sweepStorage(opts: {
  validChannelIds: Iterable<string>;
  protectChannelIds?: Iterable<string>;
  budgetChars?: number;
}): Promise<{ evicted: number; compacted: number; freedChars: number }> {
  const store = ls();
  if (!store) return { evicted: 0, compacted: 0, freedChars: 0 };
  const valid = new Set(opts.validChannelIds);
  const protectedCh = new Set(opts.protectChannelIds ?? []);
  const budget = opts.budgetChars ?? SOFT_BUDGET_CHARS;

  const entries = listPrunable(store);
  const ordered = orderedEvictionCandidates(entries, valid, protectedCh);

  let total = estimateUsageChars();
  let evicted = 0;
  let compacted = 0;
  let freedChars = 0;

  const evict = (entry: PrunableEntry): void => {
    removeSync(store, entry.key);
    total -= entry.chars;
    freedChars += entry.chars;
    evicted += 1;
  };

  // A cold entry = still in the live set but NOT active/warm (i.e. archived). These are the safe
  // targets once orphans are gone.
  const isCold = (e: PrunableEntry): boolean => valid.has(e.channelId) && !protectedCh.has(e.channelId);

  // Pass 1: always remove orphans (worthless leftovers), regardless of budget.
  for (const entry of ordered) {
    if (!valid.has(entry.channelId)) evict(entry);
  }

  // Pass 2: still over budget → evict cold debug event-logs (debug-only, lowest value), oldest first.
  if (total > budget) {
    for (const entry of ordered) {
      if (total <= budget) break;
      if (entry.kind === 'eventlog' && isCold(entry)) evict(entry);
    }
  }

  // Pass 3: still over budget → COMPACT cold transcripts to their recent tail rather than dropping
  // them. Keeps the archived chat and its latest context; the older history re-pulls from the laptop
  // on demand. Archived chats are hit first (they're the cold, non-warm ones), oldest first.
  if (total > budget) {
    for (const entry of ordered) {
      if (total <= budget) break;
      if (entry.kind !== 'transcript' || !isCold(entry)) continue;
      const freed = await compactTranscript(entry.channelId, {
        maxItems: COMPACT_MAX_ITEMS,
        maxHistory: 0,
      });
      if (freed > 0) {
        total -= freed;
        freedChars += freed;
        compacted += 1;
      }
    }
  }

  // Pass 4: last resort — still over budget after compaction, fully evict oldest cold transcripts.
  if (total > budget) {
    for (const entry of ordered) {
      if (total <= budget) break;
      if (entry.kind === 'transcript' && isCold(entry)) evict(entry);
    }
  }

  return { evicted, compacted, freedChars };
}

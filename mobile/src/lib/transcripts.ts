import { Preferences } from '@capacitor/preferences';
import type { PersistedTimeline } from './timeline';

// Local-first transcript store. The phone PERSISTS every transcript it renders and
// RESTORES it on refresh, so a reload shows the conversation instantly from the device
// without re-pulling from the laptop. Mirrors sessions.ts: Preferences is the source of
// truth, with a localStorage mirror so a browser refresh (web build) restores too.
const PREFIX = 'weft.transcript.v1.';
const VERSION = 1 as const;
const discarded = new Set<string>();

interface Envelope {
  v: number;
  savedAt: number;
  data: PersistedTimeline;
}

function keyFor(channelId: string): string {
  return `${PREFIX}${channelId}`;
}

export function allowTranscriptWrites(channelId: string): void {
  if (channelId) discarded.delete(channelId);
}

export function discardTranscriptWrites(channelId: string): void {
  if (channelId) discarded.add(channelId);
}

async function removeStored(key: string): Promise<void> {
  try {
    globalThis.localStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
  try {
    await Preferences.remove({ key });
  } catch {
    /* ignore */
  }
}

/** Restore a channel's persisted transcript, or null if none / unreadable. */
export async function loadTranscript(channelId: string): Promise<PersistedTimeline | null> {
  if (!channelId) return null;
  const key = keyFor(channelId);
  try {
    const { value } = await Preferences.get({ key });
    const raw = value ?? globalThis.localStorage?.getItem(key) ?? null;
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Envelope;
    if (!parsed || parsed.v !== VERSION || !parsed.data) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

/** Persist a channel's transcript (Preferences + localStorage mirror). Best-effort. */
export async function saveTranscript(channelId: string, data: PersistedTimeline): Promise<void> {
  if (!channelId) return;
  if (discarded.has(channelId)) return;
  const key = keyFor(channelId);
  const value = JSON.stringify({ v: VERSION, savedAt: Date.now(), data } satisfies Envelope);
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* quota / unavailable — ignore the mirror */
  }
  if (discarded.has(channelId)) {
    await removeStored(key);
    return;
  }
  try {
    await Preferences.set({ key, value });
  } catch {
    /* ignore: the localStorage mirror still covers a web refresh */
  }
  if (discarded.has(channelId)) await removeStored(key);
}

/** Drop a channel's persisted transcript (called when a session is removed). */
export async function clearTranscript(channelId: string): Promise<void> {
  if (!channelId) return;
  await removeStored(keyFor(channelId));
}

/**
 * Shrink a stored transcript to its most recent tail — keeps the chat and its recent context but
 * sheds the heavy history so a full session can be preserved instead of dropped when storage is
 * tight. `maxHistory: 0` drops paginated history entirely (it re-pulls from the laptop on demand).
 * Returns the number of UTF-16 code units freed (0 if nothing needed trimming). Best-effort.
 */
export async function compactTranscript(
  channelId: string,
  opts: { maxItems: number; maxHistory: number },
): Promise<number> {
  if (!channelId || discarded.has(channelId)) return 0;
  const key = keyFor(channelId);

  let beforeRaw: string | null = null;
  try {
    beforeRaw = globalThis.localStorage?.getItem(key) ?? null;
  } catch {
    beforeRaw = null;
  }
  let envelope: Envelope | null = null;
  if (beforeRaw) {
    try {
      envelope = JSON.parse(beforeRaw) as Envelope;
    } catch {
      envelope = null;
    }
  }
  if (!envelope || envelope.v !== VERSION || !envelope.data) {
    const loaded = await loadTranscript(channelId);
    if (!loaded) return 0;
    envelope = { v: VERSION, savedAt: Date.now(), data: loaded };
  }

  const data = envelope.data;
  const items = Array.isArray(data.items) ? data.items : [];
  const history = Array.isArray(data.history) ? data.history : [];
  const nextItems = items.length > opts.maxItems ? items.slice(-opts.maxItems) : items;
  const nextHistory =
    opts.maxHistory <= 0
      ? []
      : history.length > opts.maxHistory
        ? history.slice(-opts.maxHistory)
        : history;
  if (nextItems.length === items.length && nextHistory.length === history.length) return 0;

  const trimmed: PersistedTimeline = {
    ...data,
    items: nextItems,
    history: nextHistory,
    // We dropped older messages, so there's more behind the cursor again — let the UI offer to pull
    // it back from the laptop.
    historyHasMore: data.historyHasMore || nextHistory.length < history.length,
  };
  const value = JSON.stringify({ v: VERSION, savedAt: envelope.savedAt ?? Date.now(), data: trimmed } satisfies Envelope);
  const freed = (beforeRaw?.length ?? 0) - value.length;
  try {
    // Replacing an existing key with a strictly smaller value; remove-then-set so a store that
    // rejects the in-place write while at the cap still lands the smaller payload.
    globalThis.localStorage?.removeItem(key);
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* couldn't rewrite the smaller value — leave it for the caller to fully evict instead */
    return 0;
  }
  try {
    await Preferences.set({ key, value });
  } catch {
    /* ignore: the localStorage mirror still covers a web refresh */
  }
  return Math.max(0, freed);
}

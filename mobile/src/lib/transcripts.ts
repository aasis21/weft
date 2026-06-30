import { Preferences } from '@capacitor/preferences';
import type { PersistedTimeline } from './timeline';

// Local-first transcript store. The phone PERSISTS every transcript it renders and
// RESTORES it on refresh, so a reload shows the conversation instantly from the device
// without re-pulling from the laptop. Mirrors sessions.ts: Preferences is the source of
// truth, with a localStorage mirror so a browser refresh (web build) restores too.
const PREFIX = 'helm.transcript.v1.';
const VERSION = 1 as const;

interface Envelope {
  v: number;
  savedAt: number;
  data: PersistedTimeline;
}

function keyFor(channelId: string): string {
  return `${PREFIX}${channelId}`;
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
  const key = keyFor(channelId);
  const value = JSON.stringify({ v: VERSION, savedAt: Date.now(), data } satisfies Envelope);
  try {
    globalThis.localStorage?.setItem(key, value);
  } catch {
    /* quota / unavailable — ignore the mirror */
  }
  try {
    await Preferences.set({ key, value });
  } catch {
    /* ignore: the localStorage mirror still covers a web refresh */
  }
}

/** Drop a channel's persisted transcript (called when a session is removed). */
export async function clearTranscript(channelId: string): Promise<void> {
  if (!channelId) return;
  const key = keyFor(channelId);
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

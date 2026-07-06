import { Preferences } from '@capacitor/preferences';
import type { EventEnvelope } from '@aasis21/weft-shared';

// Per-session debug event log. The phone records every envelope it exchanges with the laptop — both
// inbound (Copilot → phone) and outbound (phone → Copilot) — so the session-detail debug panel can
// show the raw event chain, newest-first. Mirrors transcripts.ts: Preferences is the source of truth
// with a localStorage mirror so a browser refresh (web build) restores the log too.
const PREFIX = 'weft.eventlog.v1.';
const VERSION = 1 as const;

/** Keep at most this many events per session (a ring buffer; oldest fall off the front). */
export const EVENT_LOG_CAP = 200;

/** One captured wire event, flattened for display. */
export interface DebugEvent {
  id: string;
  /** 'in' = received from the laptop; 'out' = sent from this phone. */
  dir: 'in' | 'out';
  eventType: string;
  eventSubtype: string;
  /** Who sent it: "Copilot" (extension), "App"/"WebApp" (this phone), or a peer label. */
  senderName: string;
  ts: number;
  /** The (compacted) message payload — heavy blobs like image data are summarized out. */
  msg: unknown;
}

interface Stored {
  v: number;
  savedAt: number;
  events: DebugEvent[];
}

function keyFor(channelId: string): string {
  return `${PREFIX}${channelId}`;
}

/**
 * Shallow-copy a payload for storage/display, replacing anything heavy (base64 attachment data) with
 * a short placeholder and clipping very long strings, so the log stays small and readable and can't
 * blow the localStorage quota on a burst of image prompts.
 */
export function compactMsg(msg: unknown): unknown {
  if (msg == null || typeof msg !== 'object') return msg;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(msg as Record<string, unknown>)) {
    if (k === 'attachments' && Array.isArray(v)) {
      out[k] = v.map((a) =>
        a && typeof a === 'object' && 'data' in a
          ? { ...(a as Record<string, unknown>), data: `<${String((a as { data?: unknown }).data ?? '').length}b>` }
          : a,
      );
    } else if (typeof v === 'string' && v.length > 4000) {
      out[k] = `${v.slice(0, 4000)}… (+${v.length - 4000})`;
    } else {
      out[k] = v;
    }
  }
  return out;
}

/** Build a DebugEvent from an envelope. `senderFallback` names the sender when the envelope hasn't
 *  been stamped yet (outbound messages get their identity stamped on the wire, after we record). */
export function toDebugEvent(
  dir: 'in' | 'out',
  message: EventEnvelope,
  seq: number,
  senderFallback: string,
): DebugEvent {
  const ts = typeof message.ts === 'number' ? message.ts : Date.now();
  return {
    id: `${ts}.${dir}.${seq}`,
    dir,
    eventType: message.eventType,
    eventSubtype: message.eventSubtype,
    senderName: message.senderName ?? senderFallback,
    ts,
    msg: compactMsg(message.msg),
  };
}

/** Restore a channel's persisted event log (bounded), or [] if none / unreadable. */
export async function loadEventLog(channelId: string): Promise<DebugEvent[]> {
  if (!channelId) return [];
  const key = keyFor(channelId);
  try {
    const { value } = await Preferences.get({ key });
    const raw = value ?? globalThis.localStorage?.getItem(key) ?? null;
    if (!raw) return [];
    const parsed = JSON.parse(raw) as Stored;
    if (!parsed || parsed.v !== VERSION || !Array.isArray(parsed.events)) return [];
    return parsed.events.slice(-EVENT_LOG_CAP);
  } catch {
    return [];
  }
}

/** Persist a channel's event log (Preferences + localStorage mirror), bounded. Best-effort. */
export async function saveEventLog(channelId: string, events: DebugEvent[]): Promise<void> {
  if (!channelId) return;
  const key = keyFor(channelId);
  const value = JSON.stringify({
    v: VERSION,
    savedAt: Date.now(),
    events: events.slice(-EVENT_LOG_CAP),
  } satisfies Stored);
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

/** Drop a channel's persisted event log (called when a session is removed). */
export async function clearEventLog(channelId: string): Promise<void> {
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

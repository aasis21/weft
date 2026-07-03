// Message builders for tests.
//
// These are thin re-exports of the REAL @aasis21/helm-shared factories, so every message a test
// pushes tracks the live protocol schema (rename a field in shared and these tests break, exactly as
// intended). On top of the factories we add:
//   - `stamp()` to attach the identity fields (channelId/sessionId/senderId/senderName) that
//     SecureChannel would normally inject on the wire, and to pin `ts` for deterministic ordering.
//   - a `channelUp(channelId, sessionId, cwd?, title?)` wrapper that stamps the channel identity the
//     way the real channel would, so tests can assert reconcile-by-sessionId without a live channel.
//   - `historyItem()` / `historyPage()` conveniences for the backfill/catch-up scenarios.
export {
  EVENT_TYPE,
  SUBTYPE,
  MODES,
  mergeHistory,
  assistantMessage,
  assistantDelta,
  toolStart,
  toolComplete,
  logLine,
  activity,
  userMessage,
  prompt,
  approvalRequest,
  approvalDecision,
  approvalComplete,
  elicitationRequest,
  elicitationResponse,
  elicitationComplete,
  sessionMeta,
  channelDown,
  heartbeat,
  modeChange,
  interrupt,
  history,
  recentTurnsRequest,
  recentTurns,
  stateRequest,
  stateSnapshot,
  isValidEnvelope,
} from '@aasis21/helm-shared';

import { channelUp as realChannelUp, history, recentTurns as realRecentTurns } from '@aasis21/helm-shared';
import type { ChannelUp, EnvelopeBase, History, HistoryItem, RecentTurnItem, RecentTurns } from '@aasis21/helm-shared';

/** Identity/ordering fields a test may want to pin on an inbound envelope (as the wire would carry). */
export interface StampFields {
  channelId?: string;
  sessionId?: string;
  senderId?: string;
  senderName?: string;
  ts?: number;
}

/** Return a copy of `envelope` with the given identity/ordering fields set (as the wire would carry). */
export function stamp<T extends EnvelopeBase>(envelope: T, fields: StampFields): T {
  return { ...envelope, ...fields };
}

/**
 * Build a `channel_up` envelope with the channel identity stamped on, the way SecureChannel would
 * on a real send. Keeps the old (channelId, sessionId, cwd, title) call shape so scenarios can assert
 * reconcile-by-sessionId (which reads the envelope-level sessionId) without standing up a live channel.
 */
export function channelUp(channelId: string, sessionId?: string, cwd?: string, title?: string): ChannelUp {
  return stamp(realChannelUp(cwd, title), { channelId, sessionId });
}

/** Build a single backfill HistoryItem. */
export function historyItem(
  turnIndex: number,
  role: 'user' | 'assistant',
  text: string,
  ts = turnIndex,
): HistoryItem {
  return { turnIndex, role, text, ts };
}

/** Build a page of ascending history items (defaults: no more, latest/backward page). */
export function historyPage(
  items: HistoryItem[],
  opts: { nextCursor?: number | null; hasMore?: boolean; since?: number | null } = {},
): History {
  return history(items, opts.nextCursor ?? null, opts.hasMore ?? false, opts.since ?? null);
}

/** Build a single recent-turns message entry. */
export function recentTurnItem(
  role: 'user' | 'assistant',
  text: string,
  ts: number,
  id?: string,
): RecentTurnItem {
  return { role, text, ts, id: id ?? `${role}-${ts}` };
}

/** Build a recent-turns snapshot envelope (ascending message entries). */
export function recentTurnsSnapshot(items: RecentTurnItem[]): RecentTurns {
  return realRecentTurns(items);
}

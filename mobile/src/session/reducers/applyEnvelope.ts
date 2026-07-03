import { EVENT_TYPE, SUBTYPE, MODES, mergeHistory } from '@aasis21/helm-shared';
import type {
  ApprovalRequestMsg,
  AssistantDelta,
  AssistantMessage,
  ElicitationRequestMsg,
  EventEnvelope,
  HistoryItem,
  HistoryMsg,
  LogLine,
  LogLineMsg,
  PromptAttachment,
  RecentTurnsMsg,
  StateSnapshotMsg,
  ToolComplete,
  ToolStart,
  UserMessageEcho,
} from '@aasis21/helm-shared';
import type {
  AssistantItem,
  NoticeItem,
  Session,
  TimelineItem,
  ToolItem,
  UserItem,
  SessionMeta,
  DebugEvent,
} from '../model';

export type {
  ApprovalRequestMsg,
  ElicitationRequestMsg,
  HistoryItem,
  AssistantItem,
  NoticeItem,
  TimelineItem,
  ToolItem,
  UserItem,
  DebugEvent,
};

export const MAX_ITEMS = 240;
export const MAX_HISTORY = 500;
const RECENT_OVERLAP_SCAN = 120;
// #119: near-full text so two distinct long prompts that merely share an opening boilerplate/prefix
// aren't collapsed into one. Exact optimistic-echo dedup is handled by id above; this content key is
// only a secondary guard, so a generous window is safe.
const RECENT_DEDUPE_PREFIX = 4096;
const DEFAULT_MODE = MODES[0] as Session['connection']['mode'];

function cap(items: TimelineItem[]): TimelineItem[] {
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

/** Last path segment of a cwd, used as a display-title fallback until the CLI reports a real title. */
function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function omitKey(map: Record<string, string>, key: string): Record<string, string> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export function appendUser(session: Session, item: UserItem): void {
  session.transcript.items = cap([...session.transcript.items, item]);
}

export function makeUserItem(
  id: string,
  text: string,
  ts: number,
  attachments?: PromptAttachment[],
): UserItem {
  return {
    kind: 'user',
    id,
    text,
    ts,
    origin: 'phone',
    ...(attachments && attachments.length ? { attachments } : {}),
  };
}

export function setUserFailed(session: Session, id: string, failed: boolean): void {
  const index = session.transcript.items.findIndex((item) => item.kind === 'user' && item.id === id);
  if (index < 0) return;
  const item = session.transcript.items[index] as UserItem;
  if (Boolean(item.failed) === failed) return;
  if (failed) item.failed = true;
  else delete item.failed;
}

export function appendNotice(session: Session, level: LogLineMsg['level'], text: string, ts: number, id = `notice-${ts}`): void {
  session.transcript.items = cap([...session.transcript.items, { kind: 'notice', id, level, text, ts }]);
}

export function markHistoryLoading(session: Session, loading = true): void {
  session.history.loading = loading;
}

export function dismissApproval(session: Session, requestId: string): void {
  session.requests.approvals = session.requests.approvals.filter((a) => a.requestId !== requestId);
  session.requests.approvalErrors = omitKey(session.requests.approvalErrors, requestId);
}

export function dismissElicitation(session: Session, requestId: string): void {
  session.requests.elicitations = session.requests.elicitations.filter((e) => e.requestId !== requestId);
  session.requests.elicitationErrors = omitKey(session.requests.elicitationErrors, requestId);
}

export function restoreElicitation(session: Session, req: ElicitationRequestMsg, message: string): void {
  if (!session.requests.elicitations.some((e) => e.requestId === req.requestId)) {
    session.requests.elicitations.push(req);
  }
  session.requests.elicitationErrors = { ...session.requests.elicitationErrors, [req.requestId]: message };
}

export function restoreApproval(session: Session, req: ApprovalRequestMsg, message: string): void {
  if (!session.requests.approvals.some((a) => a.requestId === req.requestId)) {
    session.requests.approvals.push(req);
  }
  session.requests.approvalErrors = { ...session.requests.approvalErrors, [req.requestId]: message };
}

/**
 * Optimistic local reaction to the user tapping Stop (#77): drop the busy flag and settle any tool
 * still shown as "running" so the Stop affordance releases immediately even if the host is slow or
 * dead. A later authoritative ACTIVITY/HEARTBEAT(busy) or TOOL_COMPLETE overrides this.
 */
export function markInterrupted(session: Session, ts: number): void {
  session.connection.busy = false;
  for (const item of session.transcript.items) {
    if (item.kind === 'tool' && item.status === 'running') {
      item.status = 'error';
      item.finishedAt = ts;
    }
  }
}

export function applyEnvelope(session: Session, message: EventEnvelope): void {
  if (!(message.eventType === EVENT_TYPE.CONTROL && message.eventSubtype === SUBTYPE.CONTROL.CHANNEL_DOWN)) {
    session.connection.status = 'live';
    session.connection.error = undefined;
    if (session.connection.lastHeartbeat == null) session.connection.lastHeartbeat = message.ts;
  }

  switch (message.eventType) {
    case EVENT_TYPE.STREAM:
      switch (message.eventSubtype) {
        case SUBTYPE.STREAM.ASSISTANT_MESSAGE:
          upsertAssistant(session, message);
          return;
        case SUBTYPE.STREAM.ASSISTANT_DELTA:
          appendDelta(session, message);
          return;
        case SUBTYPE.STREAM.TOOL_START:
          startTool(session, message);
          return;
        case SUBTYPE.STREAM.TOOL_COMPLETE:
          completeTool(session, message);
          return;
        case SUBTYPE.STREAM.LOG:
          pushNotice(session, message);
          return;
        case SUBTYPE.STREAM.ACTIVITY:
          session.connection.busy = message.msg.busy;
          session.connection.busyFrom = message.ts;
          return;
        case SUBTYPE.STREAM.USER_MESSAGE:
          appendUserEcho(session, message);
          return;
        default:
          return;
      }
    case EVENT_TYPE.APPROVAL:
      if (message.eventSubtype === SUBTYPE.APPROVAL.REQUEST) {
        const req = message.msg;
        session.requests.approvals = [...session.requests.approvals.filter((a) => a.requestId !== req.requestId), req];
        session.requests.approvalErrors = omitKey(session.requests.approvalErrors, req.requestId);
      } else if (message.eventSubtype === SUBTYPE.APPROVAL.COMPLETE) {
        dismissApproval(session, message.msg.requestId);
      }
      return;
    case EVENT_TYPE.ELICITATION:
      if (message.eventSubtype === SUBTYPE.ELICITATION.REQUEST) {
        const req = message.msg;
        session.requests.elicitations = [...session.requests.elicitations.filter((e) => e.requestId !== req.requestId), req];
        session.requests.elicitationErrors = omitKey(session.requests.elicitationErrors, req.requestId);
      } else if (message.eventSubtype === SUBTYPE.ELICITATION.COMPLETE) {
        dismissElicitation(session, message.msg.requestId);
      }
      return;
    case EVENT_TYPE.CONTROL:
      switch (message.eventSubtype) {
        case SUBTYPE.CONTROL.HISTORY:
          mergeHistoryPage(session, message.msg);
          return;
        case SUBTYPE.CONTROL.RECENT_TURNS:
          applyRecentTurns(session, message.msg);
          return;
        case SUBTYPE.CONTROL.STATE_SNAPSHOT:
          applyStateSnapshot(session, message.msg, message.ts);
          return;
        case SUBTYPE.CONTROL.CHANNEL_UP:
          if (message.sessionId && message.sessionId !== 'unknown-session') session.meta.sessionId = message.sessionId;
          session.meta.cwd = message.msg.cwd ?? session.meta.cwd;
          if (!session.meta.renamed)
            session.meta.title = message.msg.title || basename(session.meta.cwd) || session.meta.title;
          session.connection.lastHeartbeat = message.ts;
          session.connection.ended = false;
          session.connection.endedReason = undefined;
          session.connection.busy = false;
          session.connection.busyFrom = message.ts;
          return;
        case SUBTYPE.CONTROL.SESSION_META:
          session.meta.cwd = message.msg.cwd ?? session.meta.cwd;
          if (!session.meta.renamed)
            session.meta.title = message.msg.title || basename(session.meta.cwd) || session.meta.title;
          return;
        case SUBTYPE.CONTROL.CHANNEL_DOWN: {
          const reason = message.msg.reason ?? 'Session ended.';
          session.connection.ended = true;
          session.connection.endedReason = reason;
          session.connection.status = 'ended';
          session.connection.busy = false;
          session.connection.busyFrom = message.ts;
          appendNotice(session, 'warning', reason, message.ts, `end-${message.ts}`);
          return;
        }
        case SUBTYPE.CONTROL.HEARTBEAT: {
          const beat = message.msg;
          if (typeof beat.busy === 'boolean' && !isStaleBusyHeartbeat(session, message.ts)) {
            session.connection.busy = beat.busy;
            session.connection.busyFrom = message.ts;
          }
          session.connection.lastHeartbeat = message.ts;
          session.connection.ended = false;
          session.history.latestTurnIndex = maxCursor(session.history.latestTurnIndex, beat.latestTurnIndex);
          return;
        }
        case SUBTYPE.CONTROL.MODE:
          session.connection.mode = message.msg.mode;
          delete session.connection.pendingMode;
          return;
        default:
          return;
      }
    default:
      return;
  }
}

function upsertAssistant(session: Session, message: AssistantMessage): void {
  const id = message.msg.messageId ?? `assistant-${message.ts}`;
  const index = session.transcript.items.findIndex((item) => item.id === id && item.kind === 'assistant');
  if (index === -1) {
    session.transcript.items = cap([...session.transcript.items, { kind: 'assistant', id, text: message.msg.content, ts: message.ts }]);
    return;
  }
  const item = session.transcript.items[index] as AssistantItem;
  item.text = message.msg.content;
  item.ts = message.ts;
}

function appendDelta(session: Session, message: AssistantDelta): void {
  const id = message.msg.messageId ?? `assistant-${message.ts}`;
  const index = session.transcript.items.findIndex((item) => item.id === id && item.kind === 'assistant');
  if (index === -1) {
    session.transcript.items = cap([...session.transcript.items, { kind: 'assistant', id, text: message.msg.content, ts: message.ts }]);
    return;
  }
  const item = session.transcript.items[index] as AssistantItem;
  item.text = `${item.text}${message.msg.content}`;
  item.ts = message.ts;
}

function startTool(session: Session, message: ToolStart): void {
  if (session.transcript.items.some((item) => item.kind === 'tool' && item.id === message.msg.toolCallId)) return;
  const item: ToolItem = {
    kind: 'tool',
    id: message.msg.toolCallId,
    name: message.msg.toolName,
    args: message.msg.args,
    status: 'running',
    startedAt: message.ts,
    ts: message.ts,
  };
  session.transcript.items = cap([...session.transcript.items, item]);
}

function completeTool(session: Session, message: ToolComplete): void {
  const index = session.transcript.items.findIndex((item) => item.kind === 'tool' && item.id === message.msg.toolCallId);
  if (index === -1) {
    const item: ToolItem = {
      kind: 'tool',
      id: message.msg.toolCallId,
      name: message.msg.toolName,
      status: message.msg.success ? 'success' : 'error',
      resultPreview: message.msg.resultPreview,
      startedAt: message.ts,
      finishedAt: message.ts,
      ts: message.ts,
    };
    session.transcript.items = cap([...session.transcript.items, item]);
    return;
  }
  const item = session.transcript.items[index] as ToolItem;
  item.status = message.msg.success ? 'success' : 'error';
  item.resultPreview = message.msg.resultPreview;
  item.finishedAt = message.ts;
}

function pushNotice(session: Session, message: LogLine): void {
  appendNotice(session, message.msg.level, message.msg.message, message.ts);
}

function appendUserEcho(session: Session, message: UserMessageEcho): void {
  const id = `umsg-${message.msg.id ?? message.ts}`;
  if (session.transcript.items.some((item) => item.id === id)) return;
  session.transcript.items = cap([
    ...session.transcript.items,
    { kind: 'user', id, text: message.msg.text, ts: message.ts, origin: message.msg.origin ?? 'terminal' },
  ]);
}

function applyRecentTurns(session: Session, message: RecentTurnsMsg): void {
  const incoming = normalizeRecentTurns(message.items ?? []);
  const clearLoading = () => {
    session.history.loading = false;
  };
  if (incoming.length === 0) {
    clearLoading();
    return;
  }

  function seedTurnKey(id: string, role: 'user' | 'assistant'): string | null {
    const match = new RegExp(`^seed-(.+)-${role}$`).exec(id);
    return match?.[1] ?? null;
  }

  function normalizeRecentTurns(items: RecentTurnsMsg['items']): RecentTurnsMsg['items'] {
    const seedAssistantTurns = new Set(
      items
        .filter((it) => it?.role === 'assistant' && typeof it.text === 'string' && it.text.length > 0)
        .map((it) => seedTurnKey(it.id, 'assistant'))
        .filter((key): key is string => Boolean(key)),
    );
    const byId = new Map<string, RecentTurnsMsg['items'][number]>();
    const normalized: RecentTurnsMsg['items'] = [];
    for (const it of items) {
      if ((it.role !== 'user' && it.role !== 'assistant') || !it.text) continue;
      const seedUserTurn = it.role === 'user' ? seedTurnKey(it.id, 'user') : null;
      if (seedUserTurn && !seedAssistantTurns.has(seedUserTurn)) continue;
      const existing = byId.get(it.id);
      if (existing) {
        if (existing.role === 'assistant' && it.role === 'assistant') {
          existing.text = `${existing.text}${it.text}`;
          existing.ts = it.ts;
        }
        continue;
      }
      const copy = { ...it };
      byId.set(copy.id, copy);
      normalized.push(copy);
    }
    return normalized;
  }

  const dedupeKey = (role: string, text: string) => `${role}\u0000${text.slice(0, RECENT_DEDUPE_PREFIX)}`;
  const existingIds = new Set(session.transcript.items.map((i) => i.id));
  const overlapKeys = new Set(
    session.transcript.items
      .slice(-RECENT_OVERLAP_SCAN)
      .filter((i): i is UserItem | AssistantItem => i.kind === 'user' || i.kind === 'assistant')
      .map((i) => dedupeKey(i.kind, i.text)),
  );

  const additions: TimelineItem[] = [];
  for (const it of incoming) {
    if ((it.role !== 'user' && it.role !== 'assistant') || !it.text) continue;
    if (existingIds.has(it.id) || overlapKeys.has(dedupeKey(it.role, it.text))) continue;
    existingIds.add(it.id);
    additions.push(
      it.role === 'user'
        ? { kind: 'user', id: it.id, text: it.text, ts: it.ts }
        : { kind: 'assistant', id: it.id, text: it.text, ts: it.ts },
    );
  }
  if (additions.length === 0) {
    clearLoading();
    return;
  }

  // #151: never rely on the extension sending pre-sorted data — enforce chronological order among
  // the additions (user before assistant within an equal timestamp).
  additions.sort((a, b) => a.ts - b.ts || itemRank(a) - itemRank(b));

  // #135: keep at most ONE "new while you were away" marker in the thread — drop any dividers left
  // by previous reconnects instead of accumulating a fresh one on every flaky-connection catch-up.
  let base = session.transcript.items;
  if (base.some(isRecentDivider)) {
    base = base.filter((i) => !isRecentDivider(i));
  }

  const hasPriorContent = base.some((i) => i.kind === 'user' || i.kind === 'assistant' || i.kind === 'tool');
  const newestExistingTs = base.reduce(
    (max, i) => (i.kind === 'notice' ? max : Math.max(max, i.ts)),
    Number.NEGATIVE_INFINITY,
  );
  // The common catch-up case: the backfilled turns are newer than everything already shown, so a
  // plain append is correct (and byte-for-byte the historical behavior).
  const appendCase = !hasPriorContent || additions[0].ts >= newestExistingTs;

  if (appendCase) {
    // #117: show a divider for ANY new content on an existing thread, including an assistant-only
    // backfill (a missing reply landing under an already-shown user message), not just new user turns.
    const userTurns = additions.filter((a) => a.kind === 'user').length;
    const prefix = hasPriorContent ? [recentDivider(userTurns, additions)] : [];
    session.transcript.items = cap([...base, ...prefix, ...additions]);
  } else {
    // #93: joining/reconnecting mid-turn — live fragments already sit in the thread but are
    // chronologically NEWER than this backfilled history. Merge by timestamp so the older history
    // lands above the in-progress turn instead of after it. No "new while away" divider here: this
    // is prior context, not activity that happened while the user was away.
    session.transcript.items = cap(
      [...base, ...additions].sort((a, b) => a.ts - b.ts || itemRank(a) - itemRank(b)),
    );
  }
  session.history.loading = false;
}

function itemRank(item: TimelineItem): number {
  // Stable secondary sort key for equal timestamps: user turn, then assistant, then tool/notice.
  if (item.kind === 'user') return 0;
  if (item.kind === 'assistant') return 1;
  return 2;
}

function isRecentDivider(item: TimelineItem): boolean {
  return item.kind === 'notice' && item.id.startsWith('recent-');
}

function recentDivider(userTurns: number, additions: TimelineItem[]): NoticeItem {
  const ts = additions[0].ts;
  const text =
    userTurns > 0
      ? `${userTurns} new while you were away`
      : additions.length === 1
        ? '1 new reply'
        : `${additions.length} new replies`;
  return { kind: 'notice', id: `recent-${ts}-${userTurns}-${additions.length}`, level: 'info', text, ts };
}

export function mergeHistoryPage(session: Session, message: HistoryMsg): void {
  const items = message.items ?? [];
  const merged = mergeHistory(session.history.items, items);
  session.history.items = merged.length > MAX_HISTORY ? merged.slice(merged.length - MAX_HISTORY) : merged;
  session.history.cursor = message.nextCursor ?? null;
  session.history.hasMore = Boolean(message.hasMore);
  session.history.loading = false;
  session.history.latestTurnIndex = maxCursor(session.history.latestTurnIndex, highestTurnIndex(items));
}

function maxCursor(a: number | null, b: number | null | undefined): number | null {
  const av = Number.isFinite(a) ? (a as number) : null;
  const bv = Number.isFinite(b) ? (b as number) : null;
  if (av == null) return bv;
  if (bv == null) return av;
  return Math.max(av, bv);
}

function highestTurnIndex(items: HistoryItem[]): number | null {
  let max: number | null = null;
  for (const it of items) {
    if (Number.isFinite(it.turnIndex) && (max == null || it.turnIndex > max)) max = it.turnIndex;
  }
  return max;
}

function applyStateSnapshot(session: Session, snap: StateSnapshotMsg, ts: number): void {
  // Only honor an explicit boolean (mirrors HEARTBEAT); a null/absent busy must never clear a live
  // turn mid-flight (#99).
  if (typeof snap.busy === 'boolean') {
    session.connection.busy = snap.busy;
    session.connection.busyFrom = ts;
  }
  if (snap.mode) {
    if (!session.connection.pendingMode || snap.mode === session.connection.pendingMode) {
      session.connection.mode = snap.mode;
      delete session.connection.pendingMode;
    }
  }
  // The snapshot is the extension's authoritative pending set (re-requested fresh on each attach),
  // so REPLACE rather than add-only merge — otherwise an approval the CLI auto-denied, or that timed
  // out during a socket gap, lingers forever as a zombie banner (#78). Decisions currently in flight
  // are stripped upstream (sessionRuntime.filterInFlight) so a just-answered card can't reappear (#79).
  session.requests.approvals = snap.approvals ?? [];
  session.requests.elicitations = snap.elicitations ?? [];
  session.connection.lastHeartbeat = ts;
  session.connection.ended = false;
  session.history.latestTurnIndex = maxCursor(session.history.latestTurnIndex, snap.latestTurnIndex);
}

function isStaleBusyHeartbeat(session: Session, ts: number): boolean {
  const busyFrom = session.connection.busyFrom;
  return Number.isFinite(busyFrom) && ts < (busyFrom as number);
}

export interface PersistedSession {
  id: string;
  meta: SessionMeta;
  unread: boolean;
  lastEventAt: number | null;
  transcript: { items: TimelineItem[] };
  history: Omit<Session['history'], 'loading'>;
  connection?: { mode?: Session['connection']['mode'] };
  debug: DebugEvent[];
}

export function toPersistedSession(session: Session): PersistedSession {
  return {
    id: session.id,
    meta: session.meta,
    unread: session.unread,
    lastEventAt: session.lastEventAt,
    transcript: {
      items: session.transcript.items.map((item) =>
        item.kind === 'user' && item.attachments ? { ...item, attachments: undefined } : item,
      ),
    },
    history: {
      items: session.history.items,
      cursor: session.history.cursor,
      hasMore: session.history.hasMore,
      latestTurnIndex: session.history.latestTurnIndex,
    },
    connection: { mode: session.connection.mode },
    debug: session.debug,
  };
}

export function restorePersistedSession(persisted: PersistedSession): Session {
  return {
    id: persisted.id,
    meta: { ...persisted.meta },
    unread: Boolean(persisted.unread),
    lastEventAt: persisted.lastEventAt ?? null,
    transcript: { items: Array.isArray(persisted.transcript?.items) ? persisted.transcript.items.slice(-MAX_ITEMS) : [] },
    history: {
      items: Array.isArray(persisted.history?.items) ? persisted.history.items.slice(-MAX_HISTORY) : [],
      cursor: persisted.history?.cursor ?? null,
      hasMore: Boolean(persisted.history?.hasMore),
      loading: false,
      latestTurnIndex: persisted.history?.latestTurnIndex ?? null,
    },
    connection: {
      status: 'idle',
      busy: false,
      busyFrom: null,
      mode: persisted.connection?.mode ?? DEFAULT_MODE,
      reconnecting: false,
      settling: false,
      lastHeartbeat: null,
      ended: false,
    },
    requests: { approvals: [], approvalErrors: {}, elicitations: [], elicitationErrors: {} },
    debug: Array.isArray(persisted.debug) ? persisted.debug : [],
  };
}

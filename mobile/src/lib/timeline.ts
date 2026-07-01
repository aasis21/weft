import { KIND, MODES, mergeHistory } from '@aasis21/helm-shared';
import type {
  ApprovalRequest,
  AssistantDelta,
  AssistantMessage,
  ActivityMessage,
  ElicitationRequest,
  ElicitationComplete,
  Heartbeat,
  History as HistoryMessage,
  HistoryItem,
  InnerMessage,
  LogLine,
  ModeChange,
  PromptAttachment,
  SessionMode,
  StateSnapshot,
  ToolComplete,
  ToolStart,
  UserMessageEcho,
} from '@aasis21/helm-shared';

/**
 * A single rendered row in the chat thread. Tool calls live *inline* in the
 * same ordered stream as assistant/user turns (VS Code / Copilot style) rather
 * than in a separate timeline panel.
 */
export type ToolStatus = 'running' | 'success' | 'error';

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  ts: number;
  failed?: boolean;
  /** Which device typed this prompt: 'phone' (this device) or 'terminal' (the laptop).
   *  Undefined for backfilled history (turns carry no device). */
  origin?: 'phone' | 'terminal';
  /** Images the phone user attached (base64), for optimistic render + retry. Stripped
   *  from persistence so the stored transcript stays small. */
  attachments?: PromptAttachment[];
}
export interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
  ts: number;
}
export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  args?: unknown;
  status: ToolStatus;
  resultPreview?: string;
  startedAt: number;
  finishedAt?: number;
  ts: number;
}
export interface NoticeItem {
  kind: 'notice';
  id: string;
  level: LogLine['level'];
  text: string;
  ts: number;
}

export type TimelineItem = UserItem | AssistantItem | ToolItem | NoticeItem;

export interface TimelineState {
  items: TimelineItem[];
  approvals: ApprovalRequest[];
  /** Transient per-request decision-send error (requestId -> message). Drives a retry
   *  affordance when a decision couldn't be relayed; reset on reconnect, never persisted. */
  approvalErrors: Record<string, string>;
  /** Pending `ask_user` elicitation forms awaiting an answer (ext -> phone). Transient,
   *  like approvals: cleared when answered/dismissed, reset on reconnect, never persisted. */
  elicitations: ElicitationRequest[];
  /** Transient per-request answer-send error (requestId -> message); mirrors approvalErrors. */
  elicitationErrors: Record<string, string>;
  /** True while a turn is in flight (the agent is generating/acting). Transient — driven
   *  by the extension's activity signal (assistant.message_start/idle); never persisted.
   *  Gates the composer's Stop control so it tracks the whole abortable turn, not just tools. */
  busy: boolean;
  mode: SessionMode;
  cwd: string | null;
  /** CLI chat summary ("title"); null until the extension reports one. */
  title: string | null;
  lastHeartbeat: number | null;
  sessionEnded: boolean;
  endedReason?: string;
  /** Backfilled pre-join turns, ascending by turn. Kept SEPARATE from live `items`
   *  (which are capped) so older history isn't evicted and ordering stays stable. */
  history: HistoryItem[];
  /** turn_index cursor for the next older page, or null when nothing older remains. */
  historyCursor: number | null;
  historyHasMore: boolean;
  /** True while a history page request is in flight (drives the "Loading…" affordance). */
  historyLoading: boolean;
  /** FORWARD cursor: the highest committed turn_index this phone has seen (via heartbeat, state
   *  snapshot, or any history page). Persisted so a refresh/resume can ask the extension for only
   *  the turns that landed while it was away (`historyRequest({ since })`). Null until first known. */
  latestTurnIndex: number | null;
}

const MAX_ITEMS = 240;
const MAX_HISTORY = 500;
// How many trailing live items a forward catch-up checks for an exact-text overlap with its oldest
// turns — enough to cover the ~1–2 turns that could have been seen live in the last beat before a drop.
const CATCHUP_OVERLAP_SCAN = 8;
const DEFAULT_MODE = MODES[0] as SessionMode;

export function emptyTimeline(): TimelineState {
  return {
    items: [],
    approvals: [],
    approvalErrors: {},
    elicitations: [],
    elicitationErrors: {},
    busy: false,
    mode: DEFAULT_MODE,
    cwd: null,
    title: null,
    lastHeartbeat: null,
    sessionEnded: false,
    history: [],
    historyCursor: null,
    historyHasMore: false,
    historyLoading: false,
    latestTurnIndex: null,
  };
}

function cap(items: TimelineItem[]): TimelineItem[] {
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

/** Append a locally-echoed user prompt so it shows instantly as a right bubble. */
export function appendUser(
  state: TimelineState,
  text: string,
  ts: number,
  attachments?: PromptAttachment[],
): { state: TimelineState; id: string } {
  const item: UserItem = {
    kind: 'user',
    id: `user-${ts}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    ts,
    origin: 'phone',
    ...(attachments && attachments.length ? { attachments } : {}),
  };
  return { state: { ...state, items: cap([...state.items, item]) }, id: item.id };
}

export function setUserFailed(state: TimelineState, id: string, failed: boolean): TimelineState {
  let changed = false;
  const items = state.items.map((item) => {
    if (item.kind !== 'user' || item.id !== id) return item;
    if (Boolean(item.failed) === failed) return item;
    changed = true;
    if (failed) return { ...item, failed: true };
    const next = { ...item };
    delete next.failed;
    return next;
  });
  return changed ? { ...state, items } : state;
}

export function appendNotice(
  state: TimelineState,
  level: LogLine['level'],
  text: string,
  ts: number,
): TimelineState {
  const item: NoticeItem = {
    kind: 'notice',
    id: `notice-${ts}-${Math.random().toString(36).slice(2, 6)}`,
    level,
    text,
    ts,
  };
  return { ...state, items: cap([...state.items, item]) };
}

/** Mark a history page request as in flight (drives the loading affordance). */
export function markHistoryLoading(state: TimelineState, loading = true): TimelineState {
  return { ...state, historyLoading: loading };
}

/** Fold one decrypted inner message into the timeline state. Pure. */
export function reduceTimeline(state: TimelineState, message: InnerMessage): TimelineState {
  switch (message.kind) {
    case KIND.ASSISTANT_MESSAGE:
      return upsertAssistant(state, message);
    case KIND.ASSISTANT_DELTA:
      return appendDelta(state, message);
    case KIND.TOOL_START:
      return startTool(state, message);
    case KIND.TOOL_COMPLETE:
      return completeTool(state, message);
    case KIND.LOG:
      return pushNotice(state, message);
    case KIND.ACTIVITY:
      return { ...state, busy: (message as ActivityMessage).busy };
    case KIND.USER_MESSAGE:
      return appendUserEcho(state, message as UserMessageEcho);
    case KIND.HISTORY: {
      // A FORWARD catch-up page (its `since` cursor is echoed back) carries the turns that landed
      // while we were away — append them to the transcript tail. A latest/backward page (no `since`)
      // is scrollback — merge it into `history[]` ABOVE the transcript.
      const page = message as HistoryMessage;
      return page.since != null ? applyForwardCatchup(state, page) : mergeHistoryPage(state, page);
    }
    case KIND.STATE_SNAPSHOT:
      return applyStateSnapshot(state, message as StateSnapshot);
    case KIND.APPROVAL_REQUEST: {
      const req = message as ApprovalRequest;
      return {
        ...state,
        approvals: [...state.approvals.filter((a) => a.requestId !== req.requestId), req],
        approvalErrors: omitKey(state.approvalErrors, req.requestId),
      };
    }
    case KIND.ELICITATION_REQUEST: {
      const req = message as ElicitationRequest;
      return {
        ...state,
        elicitations: [...state.elicitations.filter((e) => e.requestId !== req.requestId), req],
        elicitationErrors: omitKey(state.elicitationErrors, req.requestId),
      };
    }
    case KIND.ELICITATION_COMPLETE: {
      // Resolved here, at the terminal, or on another device — drop any open form for it.
      const { requestId } = message as ElicitationComplete;
      return dismissElicitation(state, requestId);
    }
    case KIND.SESSION_START:
      return {
        ...state,
        cwd: message.cwd ?? state.cwd,
        title: message.title || state.title,
        lastHeartbeat: Date.now(),
        sessionEnded: false,
        endedReason: undefined,
        busy: false,
      };
    case KIND.SESSION_META:
      return {
        ...state,
        title: message.title || state.title,
        cwd: message.cwd ?? state.cwd,
      };
    case KIND.SESSION_END: {
      const reason = message.reason ?? 'Session ended.';
      return {
        ...state,
        sessionEnded: true,
        endedReason: reason,
        busy: false,
        items: cap([
          ...state.items,
          { kind: 'notice', id: `end-${message.ts}`, level: 'warning', text: reason, ts: message.ts },
        ]),
      };
    }
    case KIND.HEARTBEAT: {
      const beat = message as Heartbeat;
      // Re-assert busy only when the extension actually knows it (boolean); a null/absent value
      // means "unknown" and must not clobber the live busy driven by assistant.message_start/idle.
      const busy = typeof beat.busy === 'boolean' ? beat.busy : state.busy;
      return {
        ...state,
        busy,
        lastHeartbeat: Date.now(),
        sessionEnded: false,
        // Advance the forward cursor so a later refresh/resume catches up from the right point.
        latestTurnIndex: maxCursor(state.latestTurnIndex, beat.latestTurnIndex),
      };
    }
    case KIND.MODE:
      return { ...state, mode: (message as ModeChange).mode };
    default:
      return state;
  }
}

/** Return a copy of `map` without `key` (or `map` itself when the key is absent). */
function omitKey(map: Record<string, string>, key: string): Record<string, string> {
  if (!(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export function dismissApproval(state: TimelineState, requestId: string): TimelineState {
  return {
    ...state,
    approvals: state.approvals.filter((a) => a.requestId !== requestId),
    approvalErrors: omitKey(state.approvalErrors, requestId),
  };
}

export function dismissElicitation(state: TimelineState, requestId: string): TimelineState {
  return {
    ...state,
    elicitations: state.elicitations.filter((e) => e.requestId !== requestId),
    elicitationErrors: omitKey(state.elicitationErrors, requestId),
  };
}

/**
 * Re-add a previously dismissed elicitation (its answer failed to send) with a transient error
 * so the form resurfaces with a retry. Pure; de-dupes by requestId. Mirrors restoreApproval.
 */
export function restoreElicitation(
  state: TimelineState,
  req: ElicitationRequest,
  message: string,
): TimelineState {
  const elicitations = state.elicitations.some((e) => e.requestId === req.requestId)
    ? state.elicitations
    : [...state.elicitations, req];
  return {
    ...state,
    elicitations,
    elicitationErrors: { ...state.elicitationErrors, [req.requestId]: message },
  };
}

/**
 * Re-add a previously dismissed approval (e.g. its decision failed to send) and record a
 * transient error so the banner can resurface with a retry. Pure; de-dupes by requestId.
 */
export function restoreApproval(
  state: TimelineState,
  req: ApprovalRequest,
  message: string,
): TimelineState {
  const approvals = state.approvals.some((a) => a.requestId === req.requestId)
    ? state.approvals
    : [...state.approvals, req];
  return {
    ...state,
    approvals,
    approvalErrors: { ...state.approvalErrors, [req.requestId]: message },
  };
}

function upsertAssistant(state: TimelineState, message: AssistantMessage): TimelineState {
  const id = message.messageId ?? `assistant-${message.ts}`;
  const index = state.items.findIndex((item) => item.id === id && item.kind === 'assistant');
  if (index === -1) {
    const item: AssistantItem = { kind: 'assistant', id, text: message.content, ts: message.ts };
    return { ...state, items: cap([...state.items, item]) };
  }
  return {
    ...state,
    items: state.items.map((item, i) =>
      i === index ? { ...(item as AssistantItem), text: message.content, ts: message.ts } : item,
    ),
  };
}

function appendDelta(state: TimelineState, message: AssistantDelta): TimelineState {
  const id = message.messageId ?? `assistant-${message.ts}`;
  const index = state.items.findIndex((item) => item.id === id && item.kind === 'assistant');
  if (index === -1) {
    const item: AssistantItem = { kind: 'assistant', id, text: message.content, ts: message.ts };
    return { ...state, items: cap([...state.items, item]) };
  }
  return {
    ...state,
    items: state.items.map((item, i) =>
      i === index
        ? { ...(item as AssistantItem), text: `${(item as AssistantItem).text}${message.content}`, ts: message.ts }
        : item,
    ),
  };
}

function startTool(state: TimelineState, message: ToolStart): TimelineState {
  if (state.items.some((item) => item.kind === 'tool' && item.id === message.toolCallId)) {
    return state;
  }
  const item: ToolItem = {
    kind: 'tool',
    id: message.toolCallId,
    name: message.toolName,
    args: message.args,
    status: 'running',
    startedAt: message.ts,
    ts: message.ts,
  };
  return { ...state, items: cap([...state.items, item]) };
}

function completeTool(state: TimelineState, message: ToolComplete): TimelineState {
  const index = state.items.findIndex((item) => item.kind === 'tool' && item.id === message.toolCallId);
  if (index === -1) {
    const item: ToolItem = {
      kind: 'tool',
      id: message.toolCallId,
      name: message.toolName,
      status: message.success ? 'success' : 'error',
      resultPreview: message.resultPreview,
      startedAt: message.ts,
      finishedAt: message.ts,
      ts: message.ts,
    };
    return { ...state, items: cap([...state.items, item]) };
  }
  return {
    ...state,
    items: state.items.map((item, i) =>
      i === index
        ? {
            ...(item as ToolItem),
            status: message.success ? 'success' : 'error',
            resultPreview: message.resultPreview,
            finishedAt: message.ts,
          }
        : item,
    ),
  };
}

function pushNotice(state: TimelineState, message: LogLine): TimelineState {
  return appendNotice(state, message.level, message.message, message.ts);
}

/**
 * Append a user prompt echoed from the laptop. Phone-typed prompts already appear via
 * `appendUser`, so the extension only broadcasts terminal-origin echoes; we still dedup
 * by the stable SDK event id so a re-delivery (e.g. reconnect) can't double-add it.
 */
function appendUserEcho(state: TimelineState, message: UserMessageEcho): TimelineState {
  const id = `umsg-${message.id ?? message.ts}`;
  if (state.items.some((item) => item.id === id)) return state;
  const item: UserItem = {
    kind: 'user',
    id,
    text: message.text,
    ts: message.ts,
    origin: message.origin ?? 'terminal',
  };
  return { ...state, items: cap([...state.items, item]) };
}

/** Merge a backfilled history page (ascending, deduped) and advance the cursor. */
function mergeHistoryPage(state: TimelineState, message: HistoryMessage): TimelineState {
  const items = message.items ?? [];
  const merged = mergeHistory(state.history, items);
  const history = merged.length > MAX_HISTORY ? merged.slice(merged.length - MAX_HISTORY) : merged;
  return {
    ...state,
    history,
    historyCursor: message.nextCursor ?? null,
    historyHasMore: Boolean(message.hasMore),
    historyLoading: false,
    // The first-join latest page seeds the forward cursor so a later resume knows where "now" is.
    latestTurnIndex: maxCursor(state.latestTurnIndex, highestTurnIndex(items)),
  };
}

/**
 * Apply a FORWARD catch-up page — the extension's answer to `historyRequest({ since })`, i.e. the
 * turns that committed while this phone was away/offline. Unlike backward scrollback (which fills
 * `history[]` ABOVE the transcript), these turns are NEWER than everything shown, so they're
 * converted to normal user/assistant items and appended at the BOTTOM, exactly where the live stream
 * resumes. A "N new while you were away" divider marks the boundary. Idempotent: re-applying the same
 * page is a no-op (dedup by a stable `turn-<i>-<role>` id), and a turn already seen live is dropped
 * by an exact (role,text) match so it never double-renders (live items carry no turn_index).
 */
function applyForwardCatchup(state: TimelineState, message: HistoryMessage): TimelineState {
  const incoming = message.items ?? [];
  const cursor = maxCursor(state.latestTurnIndex, highestTurnIndex(incoming));
  if (incoming.length === 0) return { ...state, latestTurnIndex: cursor };

  // A catch-up that continues a large multi-page gap appends right after earlier catch-up turns;
  // the very first page of a burst instead lands on the live tail, which is the ONLY place a turn
  // could have been seen live already (committed + streamed within the last beat before the drop).
  const lastId = state.items.length ? state.items[state.items.length - 1].id : '';
  const continuing = lastId.startsWith('turn-') || lastId.startsWith('catchup-');
  const existingIds = new Set(state.items.map((i) => i.id));
  // Overlap guard (first page only): drop a turn whose text exactly matches a recent LIVE bubble so
  // it never double-renders. Scoped to the tail — matching against the whole transcript would wrongly
  // swallow a genuinely new short turn ("yes"/"ok") that repeats an old one.
  const liveTail = continuing
    ? new Set<string>()
    : new Set(
        state.items
          .slice(-CATCHUP_OVERLAP_SCAN)
          .filter((i): i is UserItem | AssistantItem => i.kind === 'user' || i.kind === 'assistant')
          .map((i) => `${i.kind}\u0000${i.text}`),
      );
  const additions: TimelineItem[] = [];
  const turns = new Set<number>();
  for (const h of incoming) {
    const id = `turn-${h.turnIndex}-${h.role}`;
    if (existingIds.has(id) || liveTail.has(`${h.role}\u0000${h.text}`)) continue;
    additions.push(
      h.role === 'user'
        ? { kind: 'user', id, text: h.text, ts: h.ts }
        : { kind: 'assistant', id, text: h.text, ts: h.ts },
    );
    turns.add(h.turnIndex);
  }
  if (additions.length === 0) return { ...state, latestTurnIndex: cursor };

  // One divider per catch-up burst: skip it on continuation pages so a multi-page fill shows a
  // single boundary marker instead of one per page.
  const appended = continuing ? additions : [catchupDivider(cursor, turns.size, additions[0].ts), ...additions];
  return {
    ...state,
    items: cap([...state.items, ...appended]),
    latestTurnIndex: cursor,
  };
}

/** The "N new while you were away" boundary marker inserted before a forward catch-up batch. */
function catchupDivider(cursor: number | null, turnCount: number, ts: number): NoticeItem {
  return {
    kind: 'notice',
    id: `catchup-${cursor}-${turnCount}`,
    level: 'info',
    text: `${turnCount} new while you were away`,
    ts,
  };
}

/** The larger of two forward cursors, treating null/undefined/non-finite as "unknown" (-∞). */
function maxCursor(a: number | null, b: number | null | undefined): number | null {
  const av = Number.isFinite(a) ? (a as number) : null;
  const bv = Number.isFinite(b) ? (b as number) : null;
  if (av == null) return bv;
  if (bv == null) return av;
  return Math.max(av, bv);
}

/** The highest turn_index in a page of history items, or null when the page is empty. */
function highestTurnIndex(items: HistoryItem[]): number | null {
  let max: number | null = null;
  for (const it of items) {
    if (Number.isFinite(it.turnIndex) && (max == null || it.turnIndex > max)) max = it.turnIndex;
  }
  return max;
}

/**
 * Apply a connect-time state snapshot (the extension's answer to our stateRequest). The snapshot is
 * authoritative for "right now": whether a turn is in flight, the current mode, and the approval /
 * ask_user prompts still open at the terminal. We MERGE the pending prompts by requestId (never
 * dropping one we already show) so a phone that joins mid-turn or reconnects immediately reflects
 * the truth — a live Stop control, the real mode, and any prompt still waiting for an answer —
 * instead of a stale "Ready" with no pending prompts. A snapshot also counts as a heartbeat.
 */
function applyStateSnapshot(state: TimelineState, snap: StateSnapshot): TimelineState {
  return {
    ...state,
    busy: Boolean(snap.busy),
    mode: snap.mode ?? state.mode,
    approvals: mergePendingById(state.approvals, snap.approvals ?? []),
    elicitations: mergePendingById(state.elicitations, snap.elicitations ?? []),
    lastHeartbeat: Date.now(),
    sessionEnded: false,
    // The snapshot reports the store's highest committed turn — seed/advance the forward cursor.
    latestTurnIndex: maxCursor(state.latestTurnIndex, snap.latestTurnIndex),
  };
}

/**
 * Union two pending-prompt lists by requestId: keep every existing entry (and its order) and
 * append any from `incoming` not already present. Additive so an in-flight live prompt is never
 * clobbered by a slightly-later snapshot; a prompt answered while away is dropped later by its
 * own completion event.
 */
function mergePendingById<T extends { requestId: string }>(existing: T[], incoming: T[]): T[] {
  if (!incoming || incoming.length === 0) return existing;
  const seen = new Set(existing.map((p) => p.requestId));
  const additions = incoming.filter((p) => p && p.requestId && !seen.has(p.requestId));
  return additions.length ? [...existing, ...additions] : existing;
}

/** A serializable snapshot of the durable parts of a timeline (no transient/live fields). */
export interface PersistedTimeline {
  items: TimelineItem[];
  history: HistoryItem[];
  historyCursor: number | null;
  historyHasMore: boolean;
  mode: SessionMode;
  title: string | null;
  cwd: string | null;
  /** Forward cursor, persisted so a hard refresh can catch up from the last-seen turn. */
  latestTurnIndex: number | null;
}

/** Extract the durable subset of a timeline for local persistence. */
export function toPersisted(state: TimelineState): PersistedTimeline {
  return {
    items: state.items.map((item) =>
      item.kind === 'user' && item.attachments ? { ...item, attachments: undefined } : item,
    ),
    history: state.history,
    historyCursor: state.historyCursor,
    historyHasMore: state.historyHasMore,
    mode: state.mode,
    title: state.title,
    cwd: state.cwd,
    latestTurnIndex: state.latestTurnIndex,
  };
}

/**
 * Rebuild a timeline from a persisted snapshot. Live/transient fields (approvals,
 * heartbeat, ended flags) are reset — they belong to the fresh connection, not the
 * restored transcript.
 */
export function restoreTimeline(persisted: PersistedTimeline | null | undefined): TimelineState {
  const base = emptyTimeline();
  if (!persisted) return base;
  return {
    ...base,
    items: Array.isArray(persisted.items) ? persisted.items.slice(-MAX_ITEMS) : [],
    history: Array.isArray(persisted.history) ? persisted.history.slice(-MAX_HISTORY) : [],
    historyCursor: persisted.historyCursor ?? null,
    historyHasMore: Boolean(persisted.historyHasMore),
    mode: persisted.mode ?? base.mode,
    title: persisted.title ?? null,
    cwd: persisted.cwd ?? null,
    latestTurnIndex: persisted.latestTurnIndex ?? null,
  };
}

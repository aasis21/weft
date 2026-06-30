import { KIND, MODES, mergeHistory } from '@aasis21/helm-shared';
import type {
  ApprovalRequest,
  AssistantDelta,
  AssistantMessage,
  ActivityMessage,
  History as HistoryMessage,
  HistoryItem,
  InnerMessage,
  LogLine,
  ModeChange,
  SessionMode,
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
  /** Which device typed this prompt: 'phone' (this device) or 'terminal' (the laptop).
   *  Undefined for backfilled history (turns carry no device). */
  origin?: 'phone' | 'terminal';
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
}

const MAX_ITEMS = 240;
const MAX_HISTORY = 500;
const DEFAULT_MODE = MODES[0] as SessionMode;

export function emptyTimeline(): TimelineState {
  return {
    items: [],
    approvals: [],
    approvalErrors: {},
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
  };
}

function cap(items: TimelineItem[]): TimelineItem[] {
  return items.length > MAX_ITEMS ? items.slice(items.length - MAX_ITEMS) : items;
}

/** Append a locally-echoed user prompt so it shows instantly as a right bubble. */
export function appendUser(state: TimelineState, text: string, ts: number): TimelineState {
  const item: UserItem = {
    kind: 'user',
    id: `user-${ts}-${Math.random().toString(36).slice(2, 7)}`,
    text,
    ts,
    origin: 'phone',
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
    case KIND.HISTORY:
      return mergeHistoryPage(state, message as HistoryMessage);
    case KIND.APPROVAL_REQUEST: {
      const req = message as ApprovalRequest;
      return {
        ...state,
        approvals: [...state.approvals.filter((a) => a.requestId !== req.requestId), req],
        approvalErrors: omitKey(state.approvalErrors, req.requestId),
      };
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
    case KIND.HEARTBEAT:
      return { ...state, lastHeartbeat: Date.now(), sessionEnded: false };
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
  const item: NoticeItem = {
    kind: 'notice',
    id: `log-${message.ts}-${Math.random().toString(36).slice(2, 6)}`,
    level: message.level,
    text: message.message,
    ts: message.ts,
  };
  return { ...state, items: cap([...state.items, item]) };
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
  const merged = mergeHistory(state.history, message.items ?? []);
  const history = merged.length > MAX_HISTORY ? merged.slice(merged.length - MAX_HISTORY) : merged;
  return {
    ...state,
    history,
    historyCursor: message.nextCursor ?? null,
    historyHasMore: Boolean(message.hasMore),
    historyLoading: false,
  };
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
}

/** Extract the durable subset of a timeline for local persistence. */
export function toPersisted(state: TimelineState): PersistedTimeline {
  return {
    items: state.items,
    history: state.history,
    historyCursor: state.historyCursor,
    historyHasMore: state.historyHasMore,
    mode: state.mode,
    title: state.title,
    cwd: state.cwd,
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
  };
}

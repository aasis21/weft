import { createEntityAdapter, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { EVENT_TYPE, SUBTYPE } from '@aasis21/helm-shared';
import type { EventEnvelope, HistoryMsg } from '@aasis21/helm-shared';
import type {
  ApprovalRequestMsg,
  DebugEvent,
  ElicitationRequestMsg,
  NoticeItem,
  Session,
  SessionStatus,
  UserItem,
} from './model';
import {
  applyEnvelope,
  appendNotice,
  appendUser,
  dismissApproval,
  dismissElicitation,
  markInterrupted,
  mergeHistoryPage,
  restoreApproval,
  restoreElicitation,
  setUserFailed,
} from './reducers/applyEnvelope';

const EVENT_LOG_CAP = 200;

export const sessionsAdapter = createEntityAdapter<Session>();

export const sessionsInitialState = sessionsAdapter.getInitialState({
  activeId: null as string | null,
  ready: false,
});

export type SessionsState = typeof sessionsInitialState;

function isUnreadActivity(message: EventEnvelope): boolean {
  switch (message.eventType) {
    case EVENT_TYPE.STREAM:
      return message.eventSubtype !== SUBTYPE.STREAM.USER_MESSAGE;
    case EVENT_TYPE.APPROVAL:
      return message.eventSubtype === SUBTYPE.APPROVAL.REQUEST;
    case EVENT_TYPE.ELICITATION:
      return message.eventSubtype === SUBTYPE.ELICITATION.REQUEST;
    case EVENT_TYPE.CONTROL:
      return message.eventSubtype === SUBTYPE.CONTROL.CHANNEL_DOWN;
    default:
      return false;
  }
}

function mergeSessions(keep: Session, drop: Session, channelId: string): void {
  keep.meta = {
    ...keep.meta,
    addedAt: Math.min(keep.meta.addedAt, drop.meta.addedAt),
    channelId,
    sessionId: keep.meta.sessionId ?? drop.meta.sessionId,
    scannedAt: Math.max(keep.meta.scannedAt ?? 0, drop.meta.scannedAt ?? 0) || keep.meta.scannedAt || drop.meta.scannedAt,
  };
  if (!keep.meta.title && drop.meta.title) keep.meta.title = drop.meta.title;
  if (!keep.meta.cwd && drop.meta.cwd) keep.meta.cwd = drop.meta.cwd;
  if (keep.transcript.items.length === 0 && keep.history.items.length === 0) {
    keep.transcript = { items: drop.transcript.items };
    keep.history = { ...keep.history, ...drop.history, loading: keep.history.loading || drop.history.loading };
  }
  keep.unread = keep.unread || drop.unread;
  keep.unreadCount = (keep.unreadCount ?? 0) + (drop.unreadCount ?? 0);
  keep.lastEventAt = Math.max(keep.lastEventAt ?? 0, drop.lastEventAt ?? 0) || null;
  keep.debug = [...keep.debug, ...drop.debug].slice(-EVENT_LOG_CAP);
  if (drop.connection.status === 'live' || keep.connection.status !== 'live') keep.connection.status = drop.connection.status;
  keep.connection.busy = keep.connection.busy || drop.connection.busy;
  keep.connection.lastHeartbeat = Math.max(keep.connection.lastHeartbeat ?? 0, drop.connection.lastHeartbeat ?? 0) || null;
  keep.connection.mode = drop.connection.mode ?? keep.connection.mode;
  keep.connection.ended = keep.connection.ended && drop.connection.ended;
  keep.connection.endedReason = keep.connection.endedReason ?? drop.connection.endedReason;
  keep.connection.error = keep.connection.error ?? drop.connection.error;
  keep.requests.approvals = mergeByRequestId(keep.requests.approvals, drop.requests.approvals);
  keep.requests.elicitations = mergeByRequestId(keep.requests.elicitations, drop.requests.elicitations);
  keep.requests.approvalErrors = { ...drop.requests.approvalErrors, ...keep.requests.approvalErrors };
  keep.requests.elicitationErrors = { ...drop.requests.elicitationErrors, ...keep.requests.elicitationErrors };
}

function mergeByRequestId<T extends { requestId: string }>(a: T[], b: T[]): T[] {
  const seen = new Set(a.map((item) => item.requestId));
  return [...a, ...b.filter((item) => !seen.has(item.requestId))];
}

const sessionsSlice = createSlice({
  name: 'sessions',
  initialState: sessionsInitialState,
  reducers: {
    sessionAdded: sessionsAdapter.addOne,
    sessionRemoved(state, action: PayloadAction<string>) {
      sessionsAdapter.removeOne(state, action.payload);
      if (state.activeId === action.payload) state.activeId = null;
    },
    sessionActivated(state, action: PayloadAction<string>) {
      state.activeId = action.payload;
      const session = state.entities[action.payload];
      if (session) {
        session.unread = false;
        session.unreadCount = 0;
      }
    },
    sessionReconciled(state, action: PayloadAction<{ id: string; sessionId: string }>) {
      const incoming = state.entities[action.payload.id];
      if (!incoming) return;
      const sessionId = action.payload.sessionId;
      incoming.meta.sessionId = sessionId;
      if (!sessionId || sessionId === 'unknown-session') return;
      const duplicateId = state.ids.find((id) => id !== incoming.id && state.entities[id]?.meta.sessionId === sessionId) as string | undefined;
      if (!duplicateId) return;
      const duplicate = state.entities[duplicateId];
      if (!duplicate) return;
      mergeSessions(incoming, duplicate, incoming.meta.channelId);
      sessionsAdapter.removeOne(state, duplicate.id);
      if (state.activeId === duplicate.id) state.activeId = incoming.id;
    },
    envelopeReceived(state, action: PayloadAction<{ id: string; envelope: EventEnvelope }>) {
      const session = state.entities[action.payload.id];
      if (!session) return;
      applyEnvelope(session, action.payload.envelope);
      if (isUnreadActivity(action.payload.envelope)) {
        session.lastEventAt = action.payload.envelope.ts;
        if (action.payload.id !== state.activeId) {
          session.unread = true;
          session.unreadCount += 1;
        } else {
          session.unread = false;
          session.unreadCount = 0;
        }
      }
    },
    userPromptAppended(state, action: PayloadAction<{ id: string; item: UserItem }>) {
      const session = state.entities[action.payload.id];
      if (session) appendUser(session, action.payload.item);
    },
    noticeAppended(
      state,
      action: PayloadAction<{ id: string; level: NoticeItem['level']; text: string; ts: number }>,
    ) {
      const session = state.entities[action.payload.id];
      if (session) appendNotice(session, action.payload.level, action.payload.text, action.payload.ts);
    },
    promptFailed(state, action: PayloadAction<{ id: string; itemId: string; failed: boolean }>) {
      const session = state.entities[action.payload.id];
      if (session) setUserFailed(session, action.payload.itemId, action.payload.failed);
    },
    approvalDismissed(state, action: PayloadAction<{ id: string; requestId: string }>) {
      const session = state.entities[action.payload.id];
      if (session) dismissApproval(session, action.payload.requestId);
    },
    elicitationDismissed(state, action: PayloadAction<{ id: string; requestId: string }>) {
      const session = state.entities[action.payload.id];
      if (session) dismissElicitation(session, action.payload.requestId);
    },
    approvalErrorSet(state, action: PayloadAction<{ id: string; requestId: string; error: string }>) {
      const session = state.entities[action.payload.id];
      if (session) session.requests.approvalErrors[action.payload.requestId] = action.payload.error;
    },
    elicitationErrorSet(state, action: PayloadAction<{ id: string; requestId: string; error: string }>) {
      const session = state.entities[action.payload.id];
      if (session) session.requests.elicitationErrors[action.payload.requestId] = action.payload.error;
    },
    approvalRestored(state, action: PayloadAction<{ id: string; req: ApprovalRequestMsg; error?: string }>) {
      const session = state.entities[action.payload.id];
      if (session) restoreApproval(session, action.payload.req, action.payload.error ?? 'send failed');
    },
    elicitationRestored(state, action: PayloadAction<{ id: string; req: ElicitationRequestMsg; error?: string }>) {
      const session = state.entities[action.payload.id];
      if (session) restoreElicitation(session, action.payload.req, action.payload.error ?? 'send failed');
    },
    modeSet(state, action: PayloadAction<{ id: string; mode: Session['connection']['mode']; pending?: boolean }>) {
      const session = state.entities[action.payload.id];
      if (session) {
        session.connection.mode = action.payload.mode;
        if (action.payload.pending) session.connection.pendingMode = action.payload.mode;
        else delete session.connection.pendingMode;
      }
    },
    busySet(state, action: PayloadAction<{ id: string; busy: boolean; ts?: number }>) {
      const session = state.entities[action.payload.id];
      if (session) {
        session.connection.busy = action.payload.busy;
        session.connection.busyFrom = action.payload.ts ?? Date.now();
      }
    },
    interruptRequested(state, action: PayloadAction<{ id: string; ts: number }>) {
      const session = state.entities[action.payload.id];
      if (session) markInterrupted(session, action.payload.ts);
    },
    statusSet(state, action: PayloadAction<{ id: string; status: SessionStatus; error?: string }>) {
      const session = state.entities[action.payload.id];
      if (session) {
        session.connection.status = action.payload.status;
        session.connection.error = action.payload.error;
      }
    },
    endedSet(state, action: PayloadAction<{ id: string; reason?: string }>) {
      const session = state.entities[action.payload.id];
      if (session) {
        session.connection.ended = true;
        session.connection.endedReason = action.payload.reason;
        session.connection.status = 'ended';
        session.connection.busy = false;
      }
    },
    historyLoadingSet(state, action: PayloadAction<{ id: string; loading: boolean }>) {
      const session = state.entities[action.payload.id];
      if (session) session.history.loading = action.payload.loading;
    },
    reconnectingSet(state, action: PayloadAction<{ id: string; on: boolean }>) {
      const session = state.entities[action.payload.id];
      if (session) session.connection.reconnecting = action.payload.on;
    },
    settlingSet(state, action: PayloadAction<{ id: string; on: boolean }>) {
      const session = state.entities[action.payload.id];
      if (session) session.connection.settling = action.payload.on;
    },
    heartbeatSet(state, action: PayloadAction<{ id: string; ts: number | null }>) {
      const session = state.entities[action.payload.id];
      if (session) session.connection.lastHeartbeat = action.payload.ts;
    },
    unreadSet(state, action: PayloadAction<{ id: string; on: boolean }>) {
      const session = state.entities[action.payload.id];
      if (session) {
        session.unread = action.payload.on;
        if (!action.payload.on) session.unreadCount = 0;
        else if (session.unreadCount === 0) session.unreadCount = 1;
      }
    },
    lastEventAtSet(state, action: PayloadAction<{ id: string; ts: number | null }>) {
      const session = state.entities[action.payload.id];
      if (session) session.lastEventAt = action.payload.ts;
    },
    titleSet(state, action: PayloadAction<{ id: string; title: string }>) {
      const session = state.entities[action.payload.id];
      if (session) session.meta.title = action.payload.title;
    },
    cwdSet(state, action: PayloadAction<{ id: string; cwd: string | null }>) {
      const session = state.entities[action.payload.id];
      if (session) session.meta.cwd = action.payload.cwd;
    },
    metaScannedAtSet(state, action: PayloadAction<{ id: string; ts: number | undefined }>) {
      const session = state.entities[action.payload.id];
      if (session) session.meta.scannedAt = action.payload.ts;
    },
    debugAppended(state, action: PayloadAction<{ id: string; event: DebugEvent }>) {
      const session = state.entities[action.payload.id];
      if (session) session.debug = [...session.debug, action.payload.event].slice(-EVENT_LOG_CAP);
    },
    readySet(state, action: PayloadAction<boolean>) {
      state.ready = action.payload;
    },
    historyPageMerged(state, action: PayloadAction<{ id: string; page: HistoryMsg }>) {
      const session = state.entities[action.payload.id];
      if (session) mergeHistoryPage(session, action.payload.page);
    },
  },
});

export const {
  sessionAdded,
  sessionRemoved,
  sessionActivated,
  sessionReconciled,
  envelopeReceived,
  userPromptAppended,
  noticeAppended,
  promptFailed,
  approvalDismissed,
  elicitationDismissed,
  approvalErrorSet,
  elicitationErrorSet,
  approvalRestored,
  elicitationRestored,
  modeSet,
  busySet,
  interruptRequested,
  statusSet,
  endedSet,
  historyLoadingSet,
  reconnectingSet,
  settlingSet,
  heartbeatSet,
  unreadSet,
  lastEventAtSet,
  titleSet,
  cwdSet,
  metaScannedAtSet,
  debugAppended,
  readySet,
  historyPageMerged,
} = sessionsSlice.actions;

export const sessionsSelectors = sessionsAdapter.getSelectors();
export const sessionsReducer = sessionsSlice.reducer;
export default sessionsReducer;



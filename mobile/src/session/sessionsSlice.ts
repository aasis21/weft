import { createEntityAdapter, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import { EVENT_TYPE, SUBTYPE } from '@aasis21/helm-shared';
import type { EventEnvelope, HistoryMsg } from '@aasis21/helm-shared';
import type {
  ApprovalRequestMsg,
  DebugEvent,
  ElicitationRequestMsg,
  ListenerDeviceState,
  NoticeItem,
  ChannelHistoryEntry,
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
const DEVICE_EVENT_LOG_CAP = 100;

export const sessionsAdapter = createEntityAdapter<Session>();

export const sessionsInitialState = sessionsAdapter.getInitialState({
  activeId: null as string | null,
  ready: false,
  devices: [] as ListenerDeviceState[],
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
  // Archive the transport channels this durable session has rotated through, instead of discarding
  // the superseded channelId outright (#154). Carry both cards' prior history, then record the
  // dropped card's channel as ended (it's being folded in). De-dupe by channelId; never list the
  // surviving current channel as history.
  const archived = new Map<string, ChannelHistoryEntry>();
  for (const entry of [...(keep.meta.channelHistory ?? []), ...(drop.meta.channelHistory ?? [])]) {
    archived.set(entry.channelId, { ...entry, ...archived.get(entry.channelId) });
  }
  if (drop.meta.channelId && drop.meta.channelId !== channelId && !archived.has(drop.meta.channelId)) {
    archived.set(drop.meta.channelId, {
      channelId: drop.meta.channelId,
      startedAt: drop.meta.addedAt,
      endedAt: drop.lastEventAt ?? drop.meta.addedAt,
    });
  }
  if (keep.meta.channelId && keep.meta.channelId !== channelId && !archived.has(keep.meta.channelId)) {
    archived.set(keep.meta.channelId, {
      channelId: keep.meta.channelId,
      startedAt: keep.meta.addedAt,
      endedAt: keep.lastEventAt ?? keep.meta.addedAt,
    });
  }
  archived.delete(channelId);
  const channelHistory = [...archived.values()].sort((a, b) => a.startedAt - b.startedAt);

  keep.meta = {
    ...keep.meta,
    addedAt: Math.min(keep.meta.addedAt, drop.meta.addedAt),
    channelId,
    channelHistory: channelHistory.length > 0 ? channelHistory : undefined,
    sessionId: keep.meta.sessionId ?? drop.meta.sessionId,
    scannedAt: Math.max(keep.meta.scannedAt ?? 0, drop.meta.scannedAt ?? 0) || keep.meta.scannedAt || drop.meta.scannedAt,
  };
  if (!keep.meta.title && drop.meta.title) keep.meta.title = drop.meta.title;
  // Preserve a user-chosen name across a resume/reconcile merge: if the dropped card was renamed but
  // the keeper wasn't, adopt the user's title so a channel rotation never reverts the rename (#37).
  if (drop.meta.renamed && !keep.meta.renamed) {
    keep.meta.title = drop.meta.title;
    keep.meta.renamed = true;
  }
  if (!keep.meta.cwd && drop.meta.cwd) keep.meta.cwd = drop.meta.cwd;
  if (keep.transcript.items.length === 0 && keep.history.items.length === 0) {
    keep.transcript = { items: drop.transcript.items };
    // Seeding the keeper with the stale card's content must also clear historyLoading: otherwise the
    // keeper keeps a `loading:true` left over from its own attach-time syncHistory, and because it is
    // now seeded (non-empty) a later syncHistory won't re-arm the fail-safe — the skeleton sticks
    // after a `copilot --resume` reconciliation (#132).
    keep.history = { ...keep.history, ...drop.history, loading: false };
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
  // Only carry an error forward if the merged session actually lands in a failed/ended state. A live
  // (or connecting/idle) keeper must never inherit the dead channel's stale "couldn't reach" error —
  // that produced a green "Live" header sitting above an offline banner (#185).
  keep.connection.error =
    keep.connection.status === 'error' || keep.connection.status === 'ended'
      ? (keep.connection.error ?? drop.connection.error)
      : undefined;
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
    devicesHydrated(state, action: PayloadAction<ListenerDeviceState[]>) {
      state.devices = action.payload;
    },
    deviceUpserted(state, action: PayloadAction<ListenerDeviceState>) {
      const incoming = action.payload;
      const existing = state.devices.find((d) => d.channelId === incoming.channelId);
      const merged: ListenerDeviceState = {
        ...existing,
        ...incoming,
        projects: incoming.projects ?? existing?.projects ?? [],
        projectsLoading: incoming.projectsLoading ?? existing?.projectsLoading ?? false,
        connected: incoming.connected ?? existing?.connected ?? false,
        events: incoming.events ?? existing?.events ?? [],
      };
      state.devices = [
        ...state.devices.filter((d) => d.channelId !== incoming.channelId),
        merged,
      ];
    },
    deviceRemoved(state, action: PayloadAction<string>) {
      state.devices = state.devices.filter((d) => d.channelId !== action.payload);
      if (state.devices.length > 0 && !state.devices.some((d) => d.isDefault)) {
        state.devices[0].isDefault = true;
      }
    },
    deviceDefaultSet(state, action: PayloadAction<string>) {
      for (const device of state.devices) device.isDefault = device.channelId === action.payload;
    },
    deviceProjectsLoadingSet(state, action: PayloadAction<{ channelId: string; loading: boolean; error?: string }>) {
      const device = state.devices.find((d) => d.channelId === action.payload.channelId);
      if (device) {
        device.projectsLoading = action.payload.loading;
        device.error = action.payload.error;
      }
    },
    deviceProjectsReceived(
      state,
      action: PayloadAction<{ channelId: string; projects: ListenerDeviceState['projects']; deviceName?: string | null }>,
    ) {
      const device = state.devices.find((d) => d.channelId === action.payload.channelId);
      if (device) {
        device.projects = action.payload.projects;
        device.projectsLoading = false;
        device.connected = true;
        device.error = undefined;
        device.lastSeenAt = Date.now();
        if (action.payload.deviceName) device.name = action.payload.deviceName;
      }
    },
    // Folds a stale duplicate device (same physical laptop, an OLDER ephemeral channelId from a
    // prior `helm-cli start` run) into the surviving `channelId` entry. See devices.ts
    // reconcileDeviceId — this reducer mirrors that persisted merge into redux state.
    deviceReconciled(
      state,
      action: PayloadAction<{
        channelId: string;
        removedChannelIds: string[];
        merged: Partial<ListenerDeviceState>;
      }>,
    ) {
      const { channelId, removedChannelIds, merged } = action.payload;
      if (removedChannelIds.length > 0) {
        state.devices = state.devices.filter((d) => !removedChannelIds.includes(d.channelId));
      }
      const device = state.devices.find((d) => d.channelId === channelId);
      if (device) Object.assign(device, merged);
      if (state.devices.length > 0 && !state.devices.some((d) => d.isDefault)) {
        state.devices[0].isDefault = true;
      }
    },
    deviceErrorSet(state, action: PayloadAction<{ channelId: string; error?: string; connected?: boolean }>) {
      const device = state.devices.find((d) => d.channelId === action.payload.channelId);
      if (device) {
        device.error = action.payload.error;
        if (action.payload.connected !== undefined) device.connected = action.payload.connected;
        if (action.payload.connected) device.lastSeenAt = Date.now();
        if (action.payload.error) device.projectsLoading = false;
      }
    },
    deviceLastProjectSet(state, action: PayloadAction<{ channelId: string; projectName: string }>) {
      const device = state.devices.find((d) => d.channelId === action.payload.channelId);
      if (device) device.lastProjectName = action.payload.projectName;
    },
    // Raw wire events over the device (listener) channel — mirrors `debugAppended` for sessions but
    // scoped to ListenerDeviceState.events and its own (smaller) cap, since these aren't persisted.
    deviceEventAppended(state, action: PayloadAction<{ channelId: string; event: DebugEvent }>) {
      const device = state.devices.find((d) => d.channelId === action.payload.channelId);
      if (device) device.events = [...device.events, action.payload.event].slice(-DEVICE_EVENT_LOG_CAP);
    },
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
        if (action.payload.status === 'live' || action.payload.status === 'connecting') {
          session.connection.cold = false;
        }
      }
    },
    coldSet(state, action: PayloadAction<{ id: string; on: boolean }>) {
      const session = state.entities[action.payload.id];
      if (session) session.connection.cold = action.payload.on;
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
    titleSet(state, action: PayloadAction<{ id: string; title: string; renamed?: boolean }>) {
      const session = state.entities[action.payload.id];
      if (session) {
        session.meta.title = action.payload.title;
        if (action.payload.renamed !== undefined) session.meta.renamed = action.payload.renamed;
      }
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
  devicesHydrated,
  deviceUpserted,
  deviceRemoved,
  deviceDefaultSet,
  deviceProjectsLoadingSet,
  deviceProjectsReceived,
  deviceReconciled,
  deviceErrorSet,
  deviceLastProjectSet,
  deviceEventAppended,
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
  coldSet,
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


import { createSelector } from '@reduxjs/toolkit';
import type { ManagerSnapshot, SessionView } from './view';
import type { TimelineState } from '@/lib/timeline';
import type { Session } from './model';
import { sessionsAdapter, type SessionsState } from './sessionsSlice';

export interface SessionsRootState {
  sessions: SessionsState;
}

type MaybeRootState = SessionsState | SessionsRootState;

function selectSessionsState(state: MaybeRootState): SessionsState {
  return 'sessions' in state ? state.sessions : state;
}

const adapterSelectors = sessionsAdapter.getSelectors(selectSessionsState);

export const selectAllSessions = adapterSelectors.selectAll;
export const selectSessionById = adapterSelectors.selectById;
export const selectActiveId = (state: MaybeRootState): string | null => selectSessionsState(state).activeId;
export const selectReady = (state: MaybeRootState): boolean => selectSessionsState(state).ready;
export const selectDevices = (state: MaybeRootState) => selectSessionsState(state).devices;

export const selectActiveSession = createSelector(
  [selectAllSessions, selectActiveId],
  (sessions, activeId) => sessions.find((session) => session.id === activeId),
);

export const selectTranscript = (id: string) =>
  createSelector([(state: MaybeRootState) => selectSessionById(state, id)], (session) => session?.transcript.items ?? []);
export const selectConnection = (id: string) =>
  createSelector([(state: MaybeRootState) => selectSessionById(state, id)], (session) => session?.connection);
export const selectRequests = (id: string) =>
  createSelector([(state: MaybeRootState) => selectSessionById(state, id)], (session) => session?.requests);
export const selectHistory = (id: string) =>
  createSelector([(state: MaybeRootState) => selectSessionById(state, id)], (session) => session?.history);

export function toTimelineState(session: Session): TimelineState {
  return {
    items: session.transcript.items,
    approvals: session.requests.approvals,
    approvalErrors: session.requests.approvalErrors,
    elicitations: session.requests.elicitations,
    elicitationErrors: session.requests.elicitationErrors,
    busy: session.connection.busy,
    busyFrom: session.connection.busyFrom,
    mode: session.connection.mode,
    pendingMode: session.connection.pendingMode,
    cwd: session.meta.cwd,
    title: session.meta.title || null,
    lastHeartbeat: session.connection.lastHeartbeat,
    sessionEnded: session.connection.ended,
    endedReason: session.connection.endedReason,
    history: session.history.items,
    historyCursor: session.history.cursor,
    historyHasMore: session.history.hasMore,
    historyLoading: session.history.loading,
    latestTurnIndex: session.history.latestTurnIndex,
  };
}

export function toSessionView(session: Session): SessionView {
  return {
    meta: { ...session.meta },
    status: session.connection.status,
    timeline: toTimelineState(session),
    ...(session.unread ? { unread: true } : {}),
    ...(session.unreadCount ? { unreadCount: session.unreadCount } : {}),
    ...(session.lastEventAt ? { lastEventAt: session.lastEventAt } : {}),
    ...(session.connection.settling ? { settling: true } : {}),
    ...(session.connection.cold ? { cold: true } : {}),
    events: session.debug,
    error: session.connection.error,
    ...(session.connection.spawning ? { spawning: session.connection.spawning } : {}),
  };
}

export const selectManagerSnapshot = createSelector(
  [selectReady, selectActiveId, selectAllSessions, selectDevices],
  (ready, activeId, sessions, devices): ManagerSnapshot => {
    const views = sessions.map(toSessionView);
    const active = activeId ? sessions.find((session) => session.id === activeId) : undefined;
    return { ready, activeId: active?.meta.channelId ?? null, sessions: views, devices: [...devices] };
  },
);

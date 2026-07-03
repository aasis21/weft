import {
  EVENT_TYPE,
  SUBTYPE,
  approvalDecision,
  elicitationResponse,
  recentTurnsRequest,
  interrupt,
  modeChange,
  PAIR_KIND,
  parsePairingPayload,
  prompt,
  projectListRequest,
  stateRequest,
  spawnSession as spawnSessionMessage,
  forgetDevice as forgetDeviceMessage,
  voiceMode,
  RECENT_TURNS_DEFAULT,
} from '@aasis21/helm-shared';
import type {
  EventEnvelope,
  PairingPayload,
  ProjectListMsg,
  PromptAttachment,
  SessionMode,
  SpawnMode,
  SpawnPairingMsg,
  SpawnResultMsg,
  StateSnapshotMsg,
} from '@aasis21/helm-shared';
import { connectSession, pairSession, pairWithPublicKey, getSenderName } from '@/lib/helmClient';
import type { HelmClient } from '@/lib/helmClient';
import {
  loadLastActiveSessionId,
  loadSessions,
  patchSession,
  removeSession,
  setLastActiveSessionId,
  upsertSession,
} from '@/lib/sessions';
import {
  loadDevices,
  patchDevice,
  removeDevice,
  setDefaultDevice as persistDefaultDevice,
  upsertDevice,
  type RegisteredDevice,
} from '@/lib/devices';
import { creativeName } from '@/lib/sessionNames';
import type { StoredSession } from '@/lib/sessions';
import type { StoredPairing } from '@/lib/storage';
import {
  allowTranscriptWrites,
  clearTranscript,
  discardTranscriptWrites,
  loadTranscript,
  saveTranscript,
} from '@/lib/transcripts';
import { clearEventLog, loadEventLog, saveEventLog, toDebugEvent } from '@/lib/eventLog';
import { restoreTimeline, toPersisted } from '@/lib/timeline';
import type { TimelineState } from '@/lib/timeline';
import { startDemoSession } from '@/lib/demoSimulator';
import type { DemoSession } from '@/lib/demoSimulator';
import {
  ensureNotificationPermission,
  notifyApprovalRequest,
  notifyElicitationRequest,
  notifySessionEnded,
} from '@/lib/notifications';
import { App } from '@capacitor/app';

import { makeStore, type AppStore, type RuntimeDeps } from '@/app/store';
import type { TransportRegistry } from '@/services/transport/registry';
import { emptySession, type ListenerDeviceState, type Session, type SessionMeta } from '@/session/model';
import {
  approvalDismissed,
  approvalRestored,
  busySet,
  coldSet,
  debugAppended,
  deviceDefaultSet,
  deviceErrorSet,
  deviceLastProjectSet,
  deviceProjectsLoadingSet,
  deviceProjectsReceived,
  deviceRemoved,
  devicesHydrated,
  deviceUpserted,
  elicitationDismissed,
  elicitationRestored,
  endedSet,
  envelopeReceived,
  heartbeatSet,
  historyLoadingSet,
  interruptRequested,
  lastEventAtSet,
  metaScannedAtSet,
  modeSet,
  noticeAppended,
  promptFailed,
  readySet,
  sessionActivated,
  sessionAdded,
  sessionReconciled,
  sessionRemoved,
  settlingSet,
  statusSet,
  titleSet,
  unreadSet,
  userPromptAppended,
} from '@/session/sessionsSlice';
import { makeUserItem } from '@/session/reducers/applyEnvelope';
import { optimistic } from '@/session/intents/optimistic';
import { selectAllSessions, selectManagerSnapshot, toTimelineState } from '@/session/selectors';

// --- liveness / persistence constants (identical to the pre-refactor god-object) -----------------
const IDLE_AFTER_MS = 20_000;
const OFFLINE_AFTER_MS = 30_000;
const HOST_CONFIRM_MS = 30_000;
const INITIAL_HISTORY_GRACE_MS = 700;
const RESUME_DEBOUNCE_MS = 500;
const MAX_WARM_SESSIONS = 10;
const META_PERSIST_THROTTLE_MS = 1_500;
const PERSIST_THROTTLE_MS = 800;
const HISTORY_REQUEST_TIMEOUT_MS = 8_000;
const SPAWN_TIMEOUT_MS = 30_000;

type ManagerSnapshot = ReturnType<typeof selectManagerSnapshot>;

interface SpawnRequestOptions {
  projectName: string;
  mode: SpawnMode;
  name?: string;
}

interface PendingSpawn {
  requestId: string;
  tempId: string;
  deviceId: string;
  projectName: string;
  name?: string;
  timer: ReturnType<typeof setTimeout>;
}

function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function titleFor(channelId: string, cwd: string | null, stored: string | null): string {
  return stored || basename(cwd) || creativeName(channelId);
}

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

function errMessage(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** The real CLI title an inbound message carries (channel_up / session_meta), or undefined otherwise.
 *  Only a genuine title is persisted; the cwd-basename fallback is display-only. */
function reportedTitle(message: EventEnvelope): string | undefined {
  if (message.eventType !== EVENT_TYPE.CONTROL) return undefined;
  if (
    message.eventSubtype === SUBTYPE.CONTROL.CHANNEL_UP ||
    message.eventSubtype === SUBTYPE.CONTROL.SESSION_META
  ) {
    const title = (message.msg as { title?: string }).title;
    return title || undefined;
  }
  return undefined;
}

/**
 * The I/O EDGE and the `manager` facade in one object. It owns the sockets (through the transport
 * registry) and the per-channel controllers (timers + subscriptions), runs the honest-liveness FSM,
 * the warm-pool LRU, the watchdog and the resume triggers, and reflects every observable change into
 * the RTK `sessions` store. Its public surface is byte-for-byte the pre-refactor `SessionManager`, so
 * the UI (and the scenario harness) can drive it unchanged: `subscribe` = store subscription,
 * `getSnapshot` = the `selectManagerSnapshot` reprojection.
 */
export class SessionRuntime {
  private readonly store: AppStore;
  private readonly registry: TransportRegistry;
  private readonly clock: () => number;
  private readonly controllers = new Map<string, ChannelController>();
  private readonly listenerControllers = new Map<string, ChannelController>();
  private readonly pendingSpawns = new Map<string, PendingSpawn>();
  private warmLru: string[] = [];
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private initStarted = false;
  private eventSeq = 0;
  private resumeCleanups: Array<() => void> = [];
  private lastResumeAt = 0;
  // requestIds of approvals/elicitations whose decision send is in flight. Guards a double-tap from
  // dispatching twice (#88) and lets onMessage strip an already-answered card from a racing state
  // snapshot before the send settles (#79).
  private readonly inFlightDecisions = new Set<string>();

  constructor(store?: AppStore) {
    this.store = store ?? makeStore();
    const deps: RuntimeDeps = this.store.deps;
    this.registry = deps.registry;
    this.clock = deps.clock;
  }

  // --- facade (useSyncExternalStore) ---------------------------------------------------------------
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener);
  getSnapshot = (): ManagerSnapshot => selectManagerSnapshot(this.store.getState());

  private activeId(): string | null {
    return this.store.getState().sessions.activeId;
  }

  private session(id: string): Session | undefined {
    return this.store.getState().sessions.entities[id];
  }

  private ensureController(id: string, opts: { ephemeral?: boolean } = {}): ChannelController {
    let ctrl = this.controllers.get(id);
    if (!ctrl) {
      ctrl = new ChannelController(id, opts);
      this.controllers.set(id, ctrl);
    }
    return ctrl;
  }

  private device(channelId: string): ListenerDeviceState | undefined {
    return this.store.getState().sessions.devices.find((d) => d.channelId === channelId);
  }

  private listenerController(channelId: string): ChannelController | undefined {
    return this.listenerControllers.get(channelId);
  }

  // --- lifecycle -----------------------------------------------------------------------------------
  async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    void ensureNotificationPermission();
    this.startWatchdog();
    this.installResumeTriggers();

    let stored: StoredSession[] = [];
    let devices: RegisteredDevice[] = [];
    let lastActiveId: string | null = null;
    try {
      [stored, lastActiveId, devices] = await Promise.all([loadSessions(), loadLastActiveSessionId(), loadDevices()]);
    } catch {
      stored = [];
      devices = [];
      lastActiveId = null;
    }

    this.store.dispatch(
      devicesHydrated(
        devices.map((device) => ({
          ...device,
          projects: [],
          projectsLoading: false,
          connected: false,
        })),
      ),
    );

    const restored = await Promise.all(
      stored.map(async (s) => ({
        channelId: s.pairing.channelId,
        persisted: await loadTranscript(s.pairing.channelId).catch(() => null),
        events: await loadEventLog(s.pairing.channelId).catch(() => []),
      })),
    );
    const persistedById = new Map(restored.map((r) => [r.channelId, r.persisted]));
    const eventsById = new Map(restored.map((r) => [r.channelId, r.events]));

    const recencyOf = (s: StoredSession): number =>
      Math.max(s.lastEventAt ?? 0, s.lastSeenAt ?? 0, s.addedAt ?? 0);
    const warmIds = new Set(
      [...stored]
        .sort((a, b) => recencyOf(b) - recencyOf(a))
        .slice(0, MAX_WARM_SESSIONS)
        .map((s) => s.pairing.channelId),
    );

    let activeId: string | null = null;
    if (stored.length > 0) {
      const lastActiveExists = lastActiveId
        ? stored.some((s) => s.pairing.channelId === lastActiveId)
        : false;
      const first = lastActiveExists ? null : [...stored].sort((a, b) => recencyOf(b) - recencyOf(a))[0];
      activeId = lastActiveExists ? lastActiveId : (first?.pairing.channelId ?? stored[0].pairing.channelId);
      if (activeId) warmIds.add(activeId);
    }

    for (const s of stored) {
      const channelId = s.pairing.channelId;
      allowTranscriptWrites(channelId);
      const timeline = restoreTimeline(persistedById.get(channelId) ?? null);
      const session = this.buildRestoredSession(
        s,
        timeline,
        eventsById.get(channelId) ?? [],
        warmIds.has(channelId) ? 'connecting' : 'idle',
      );
      this.store.dispatch(sessionAdded(session));
      this.controllers.set(channelId, new ChannelController(channelId));
    }
    if (activeId) this.store.dispatch(sessionActivated(activeId));
    this.store.dispatch(readySet(true));

    await Promise.all(
      stored
        .filter((s) => warmIds.has(s.pairing.channelId))
        .map(async (s) => {
          const channelId = s.pairing.channelId;
          const ctrl = this.ensureController(channelId);
          if (ctrl.reconnecting) return;
          ctrl.reconnecting = true;
          try {
            const client = await connectSession(s.pairing);
            this.attach(channelId, client);
          } catch (err) {
            this.store.dispatch(
              statusSet({ id: channelId, status: 'error', error: errMessage(err, 'Failed to reconnect.') }),
            );
          } finally {
            if (this.controllers.get(channelId) === ctrl) ctrl.reconnecting = false;
          }
        }),
    );
  }

  /** Rebuild a store `Session` from a restored transcript + stored metadata (mirrors restoreTimeline:
   *  live/transient fields — busy, heartbeat, approvals — start fresh; the persisted subset carries). */
  private buildRestoredSession(
    stored: StoredSession,
    timeline: TimelineState,
    events: Session['debug'],
    status: Session['connection']['status'],
  ): Session {
    const channelId = stored.pairing.channelId;
    const cwd = timeline.cwd ?? stored.cwd;
    const meta: SessionMeta = {
      channelId,
      sessionId: stored.sessionId ?? undefined,
      // A renamed session pins the user's stored title; otherwise prefer the freshest CLI title from
      // the restored transcript, falling back to the stored title / cwd / creative name.
      title: stored.renamed
        ? stored.title || titleFor(channelId, cwd, null)
        : titleFor(channelId, cwd, timeline.title ?? stored.title),
      renamed: stored.renamed ?? false,
      cwd,
      kind: 'live',
      addedAt: stored.addedAt,
      scannedAt: stored.pairing.savedAt ?? stored.addedAt,
    };
    const session = emptySession(channelId, meta);
    session.unread = stored.unread ?? false;
    session.unreadCount = stored.unreadCount ?? (stored.unread ? 1 : 0);
    session.lastEventAt = stored.lastEventAt ?? null;
    session.transcript.items = timeline.items;
    session.history = {
      items: timeline.history,
      cursor: timeline.historyCursor,
      hasMore: timeline.historyHasMore,
      loading: false,
      latestTurnIndex: timeline.latestTurnIndex,
    };
    session.connection.mode = timeline.mode;
    session.connection.status = status;
    session.debug = events;
    return session;
  }

  // --- connecting / attaching ----------------------------------------------------------------------
  private attach(channelId: string, client: HelmClient): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl || !this.session(channelId)) {
      void client.close().catch(() => {});
      return;
    }
    const previous = ctrl.client;
    ctrl.detach();
    ctrl.client = client;
    this.registry.adopt(channelId, client);
    if (previous && previous !== client) void previous.close().catch(() => {});

    const stopEvents = client.subscribe((message) => this.onMessage(channelId, client, message));
    const stopStatus = client.onStatus((status) => this.handleTransportStatus(channelId, client, status));
    ctrl.unsubscribe = () => {
      stopEvents();
      stopStatus();
    };

    if (ctrl.ephemeral) {
      this.store.dispatch(statusSet({ id: channelId, status: 'live', error: undefined }));
    } else {
      this.touchWarm(channelId);
      this.beginHostConfirm(channelId, client);
    }
    this.requestState(channelId);
    this.syncHistory(channelId, client);
  }

  /** Enter unconfirmed 'connecting' and arm the liveness deadline. The single honest-Live guard. */
  private beginHostConfirm(channelId: string, client: HelmClient): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl || ctrl.ephemeral || ctrl.client !== client) return;
    const session = this.session(channelId);
    if (!session || session.connection.status === 'ended') return;
    this.store.dispatch(statusSet({ id: channelId, status: 'connecting', error: undefined }));
    ctrl.connectingSince = this.clock();
    this.clearSettle(channelId);
    ctrl.arm(
      'confirm',
      () => {
        const c = this.controllers.get(channelId);
        if (!c || c.client !== client) return;
        c.clear('confirm');
        const s = this.session(channelId);
        if (!s || s.connection.status !== 'connecting') return;
        this.store.dispatch(
          statusSet({
            id: channelId,
            status: 'error',
            error: 'Copilot terminal offline — reopen it on your laptop and scan the new QR.',
          }),
        );
        if (s.connection.busy) this.store.dispatch(busySet({ id: channelId, busy: false }));
      },
      HOST_CONFIRM_MS,
    );
  }

  /** Settle the confirmation gate on the FIRST genuine inbound signal (status→live is done by the
   *  reducer; here we clear the deadline and manage the bounded initial-skeleton grace). */
  private confirmHost(channelId: string, wasLive: boolean): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl) return;
    ctrl.clear('confirm');
    ctrl.connectingSince = null;
    if (wasLive) return;
    const s = this.session(channelId);
    if (!s) return;
    const emptyAndLoading =
      s.transcript.items.length === 0 && s.history.items.length === 0 && s.history.loading;
    if (emptyAndLoading) this.beginSettle(channelId);
    else this.clearSettle(channelId);
  }

  private beginSettle(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl) return;
    const s = this.session(channelId);
    if (s && !s.connection.settling) this.store.dispatch(settlingSet({ id: channelId, on: true }));
    ctrl.arm(
      'settle',
      () => {
        ctrl.clear('settle');
        const cur = this.session(channelId);
        if (cur && cur.connection.settling) this.store.dispatch(settlingSet({ id: channelId, on: false }));
      },
      INITIAL_HISTORY_GRACE_MS,
    );
  }

  private clearSettle(channelId: string): void {
    this.controllers.get(channelId)?.clear('settle');
    const s = this.session(channelId);
    if (s && s.connection.settling) this.store.dispatch(settlingSet({ id: channelId, on: false }));
  }

  private handleTransportStatus(
    channelId: string,
    client: HelmClient,
    status: 'connected' | 'disconnected',
  ): void {
    const ctrl = this.controllers.get(channelId);
    const session = this.session(channelId);
    if (!ctrl || !session || ctrl.client !== client || ctrl.ephemeral || session.connection.status === 'ended') {
      return;
    }
    if (status === 'disconnected') {
      if (session.connection.status === 'live' || session.connection.status === 'idle') {
        this.store.dispatch(
          statusSet({ id: channelId, status: 'error', error: 'Connection lost — reconnect to resume.' }),
        );
        if (session.connection.busy) this.store.dispatch(busySet({ id: channelId, busy: false }));
      }
      return;
    }
    if (session.connection.status === 'error') {
      this.beginHostConfirm(channelId, client);
      this.requestState(channelId);
      this.syncHistory(channelId, client);
    }
  }

  private requestState(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl || ctrl.ephemeral || !ctrl.client) return;
    void this.send(channelId, stateRequest()).catch(() => {
      // A failed state request must never break the connection; live events still flow.
    });
  }

  private syncHistory(channelId: string, _client: HelmClient): void {
    const ctrl = this.controllers.get(channelId);
    const session = this.session(channelId);
    if (!ctrl || !session || ctrl.ephemeral) return;
    const hasContent = session.history.items.length > 0 || session.transcript.items.length > 0;
    if (!hasContent) {
      this.store.dispatch(historyLoadingSet({ id: channelId, loading: true }));
      this.armHistoryTimeout(channelId);
    }
    void this.send(channelId, recentTurnsRequest(RECENT_TURNS_DEFAULT)).catch(() => {
      this.store.dispatch(historyLoadingSet({ id: channelId, loading: false }));
      this.clearHistoryTimeout(channelId);
    });
  }

  private armHistoryTimeout(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl) return;
    ctrl.arm(
      'history',
      () => {
        ctrl.clear('history');
        const s = this.session(channelId);
        if (s && s.history.loading) this.store.dispatch(historyLoadingSet({ id: channelId, loading: false }));
      },
      HISTORY_REQUEST_TIMEOUT_MS,
    );
  }

  private clearHistoryTimeout(channelId: string): void {
    this.controllers.get(channelId)?.clear('history');
  }

  // --- inbound -------------------------------------------------------------------------------------
  /**
   * Strip approvals/elicitations the user has already answered (decision send still in flight) from
   * an authoritative STATE_SNAPSHOT, so a snapshot the extension emitted before it observed our
   * decision can't resurrect a dismissed card (#79). Non-snapshot envelopes pass through untouched.
   */
  private filterInFlight(message: EventEnvelope): EventEnvelope {
    if (
      this.inFlightDecisions.size === 0 ||
      message.eventType !== EVENT_TYPE.CONTROL ||
      message.eventSubtype !== SUBTYPE.CONTROL.STATE_SNAPSHOT
    ) {
      return message;
    }
    const snap = message.msg as StateSnapshotMsg;
    return {
      ...message,
      msg: {
        ...snap,
        approvals: (snap.approvals ?? []).filter((a) => !this.inFlightDecisions.has(a.requestId)),
        elicitations: (snap.elicitations ?? []).filter(
          (e) => !this.inFlightDecisions.has(e.requestId),
        ),
      },
    };
  }

  private onMessage(channelId: string, client: HelmClient, message: EventEnvelope): void {
    const ctrl = this.controllers.get(channelId);
    const before = this.session(channelId);
    if (!ctrl || !before) return;
    // Ignore a message that decrypted after its channel was superseded (reconnect) or cooled to cold:
    // acting on it could set a stale card back to 'live' with no live connection.
    if (ctrl.client !== client) return;

    const wasLive = before.connection.status === 'live';
    const prevCwd = before.meta.cwd;
    const prevSessionId = before.meta.sessionId;
    const prevTitle = before.meta.title;

    this.recordEvent(channelId, 'in', message);
    this.store.dispatch(envelopeReceived({ id: channelId, envelope: this.filterInFlight(message) }));

    if (isUnreadActivity(message)) this.markActivity(channelId);

    const isControl = message.eventType === EVENT_TYPE.CONTROL;
    const sub = message.eventSubtype;

    if (isControl && sub === SUBTYPE.CONTROL.HISTORY) {
      this.clearHistoryTimeout(channelId);
      this.clearSettle(channelId);
    }
    if (isControl && sub === SUBTYPE.CONTROL.RECENT_TURNS) {
      this.clearHistoryTimeout(channelId);
      this.clearSettle(channelId);
    }

    if (isControl && sub === SUBTYPE.CONTROL.CHANNEL_DOWN) {
      ctrl.clear('confirm');
      ctrl.connectingSince = null;
      this.clearSettle(channelId);
      void notifySessionEnded(this.session(channelId)?.connection.endedReason);
    } else {
      this.confirmHost(channelId, wasLive);
    }

    if (isControl && sub === SUBTYPE.CONTROL.CHANNEL_UP) {
      const sid = message.sessionId;
      if (sid && sid !== 'unknown-session') this.reconcileBySessionId(channelId, sid);
    }

    // Persist any changed durable metadata as ONE coalesced patch. Separate un-awaited patchSession
    // calls each do a read-modify-write of the whole session list, so concurrent ones clobber each
    // other; a single patch (only the keys that actually changed) is race-free. Title persists only
    // the genuine CLI title, never the cwd-basename fallback.
    if (!ctrl.ephemeral) {
      const cur = this.session(channelId);
      if (cur) {
        const patch: Partial<StoredSession> = {};
        if (isControl && sub === SUBTYPE.CONTROL.CHANNEL_UP) {
          const sid = message.sessionId;
          if (sid && sid !== 'unknown-session' && sid !== prevSessionId) patch.sessionId = sid;
        }
        if (cur.meta.cwd && cur.meta.cwd !== prevCwd) patch.cwd = cur.meta.cwd;
        const title = reportedTitle(message);
        if (title && cur.meta.title !== prevTitle) patch.title = title;
        if (Object.keys(patch).length > 0) void patchSession(channelId, patch);
      }
    }

    if (message.eventType === EVENT_TYPE.APPROVAL && sub === SUBTYPE.APPROVAL.REQUEST) {
      void notifyApprovalRequest(message.msg);
    }
    if (message.eventType === EVENT_TYPE.ELICITATION && sub === SUBTYPE.ELICITATION.REQUEST) {
      void notifyElicitationRequest(message.msg);
    }

    this.schedulePersist(channelId);
  }

  /** Collapse a stale duplicate card that reports a sessionId we already track under another channel
   *  (a `copilot --resume` rotated the channelId). State merge is the reducer's job; here we tear down
   *  the merged duplicate's socket, timers, and stored state. */
  private reconcileBySessionId(keepId: string, sessionId: string): void {
    const duplicate = selectAllSessions(this.store.getState()).find(
      (s) => s.id !== keepId && s.meta.sessionId === sessionId && !this.controllers.get(s.id)?.ephemeral,
    );
    this.store.dispatch(sessionReconciled({ id: keepId, sessionId }));
    if (!duplicate) return;
    this.controllers.get(duplicate.id)?.dispose();
    this.controllers.delete(duplicate.id);
    this.registry.dispose(duplicate.id);
    this.warmLru = this.warmLru.filter((id) => id !== duplicate.id);
    discardTranscriptWrites(duplicate.id);
    void removeSession(duplicate.id);
    void clearTranscript(duplicate.id);
    void clearEventLog(duplicate.id);
  }

  // --- warm pool -----------------------------------------------------------------------------------
  private markActivity(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl || ctrl.ephemeral) return;
    this.store.dispatch(lastEventAtSet({ id: channelId, ts: this.clock() }));
    this.touchWarm(channelId);
    this.scheduleMetaPersist(channelId);
  }

  private touchWarm(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl || ctrl.ephemeral) return;
    const session = this.session(channelId);
    if (!session || session.connection.status === 'ended') return;
    const i = this.warmLru.indexOf(channelId);
    if (i >= 0) this.warmLru.splice(i, 1);
    this.warmLru.push(channelId);
    this.evictBeyondWarmLimit();
  }

  private evictBeyondWarmLimit(): void {
    const activeId = this.activeId();
    while (this.warmLru.length > MAX_WARM_SESSIONS) {
      const victimIndex = this.warmLru.findIndex((id) => id !== activeId);
      if (victimIndex < 0) break;
      const [victimId] = this.warmLru.splice(victimIndex, 1);
      this.coolDown(victimId);
    }
  }

  /** Drop a session's live subscription/socket while keeping its card, transcript, and unread. */
  private coolDown(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    const session = this.session(channelId);
    if (!ctrl || !session || ctrl.ephemeral) return;
    ctrl.dispose();
    this.controllers.delete(channelId);
    this.registry.dispose(channelId);
    if (session.connection.status !== 'ended') {
      this.store.dispatch(statusSet({ id: channelId, status: 'idle', error: undefined }));
      this.store.dispatch(coldSet({ id: channelId, on: true }));
    }
    if (session.connection.busy) this.store.dispatch(busySet({ id: channelId, busy: false }));
  }

  private ensureConnected(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    const session = this.session(channelId);
    if (!session || session.connection.status === 'ended') return;
    if (ctrl?.ephemeral) return;
    if (session.connection.status === 'live' || session.connection.status === 'connecting') return;
    void this.reconnect(channelId);
  }

  // --- adding sessions -----------------------------------------------------------------------------
  private async openPairedSession(
    client: HelmClient,
    pairing: StoredPairing,
    opts: { title?: string | null; cwd?: string | null; activate?: boolean; scannedAt?: number; renamed?: boolean } = {},
  ): Promise<string> {
    const channelId = pairing.channelId;
    allowTranscriptWrites(channelId);
    const existing = this.session(channelId);
    const existingCtrl = this.controllers.get(channelId);
    if (existing && !existingCtrl?.ephemeral) {
      // Rescanning a channel we already track: refresh the pairing + rebind a fresh client, KEEP the
      // transcript. attach() then forward-catches-up rather than pulling from scratch.
      const prior = (await loadSessions()).find((s) => s.pairing.channelId === channelId);
      await upsertSession({
        pairing,
        sessionId: prior?.sessionId ?? existing.meta.sessionId ?? null,
        title: prior?.title ?? null,
        cwd: prior?.cwd ?? null,
        addedAt: prior?.addedAt ?? existing.meta.addedAt,
        lastSeenAt: this.clock(),
      });
      const ctrl = this.ensureController(channelId);
      try {
        await ctrl.client?.close();
      } catch {
        // The old socket may already be gone; the fresh client supersedes it either way.
      }
      ctrl.client = null;
      this.registry.dispose(channelId);
      this.store.dispatch(metaScannedAtSet({ id: channelId, ts: pairing.savedAt ?? this.clock() }));
      if (opts.activate !== false) this.store.dispatch(sessionActivated(channelId));
      this.attach(channelId, client);
      return channelId;
    }

    const now = this.clock();
    await upsertSession({
      pairing,
      title: opts.title ?? null,
      cwd: opts.cwd ?? null,
      addedAt: now,
      lastSeenAt: now,
      renamed: opts.renamed,
    });
    const meta: SessionMeta = {
      channelId,
      title: titleFor(channelId, opts.cwd ?? null, opts.title ?? null),
      renamed: opts.renamed ?? false,
      cwd: opts.cwd ?? null,
      kind: 'live',
      addedAt: now,
      scannedAt: opts.scannedAt ?? pairing.savedAt ?? now,
    };
    const session = emptySession(channelId, meta);
    session.connection.status = 'connecting';
    this.store.dispatch(sessionAdded(session));
    this.controllers.set(channelId, new ChannelController(channelId));
    if (opts.activate !== false) this.store.dispatch(sessionActivated(channelId));
    this.attach(channelId, client);
    return channelId;
  }

  async addByQr(raw: string): Promise<string> {
    let parsed: ReturnType<typeof parsePairingPayload> | null = null;
    try {
      parsed = parsePairingPayload(raw);
    } catch {
      // The test harness historically uses plain channel ids as QR strings; pairSession remains the
      // single authoritative parser on the real path and will surface invalid production payloads.
    }
    if (parsed?.kind === PAIR_KIND.LISTENER) return this.registerListenerFromQr(raw);
    const { client, pairing } = await pairSession(raw);
    return this.openPairedSession(client, pairing);
  }

  async addDemo(): Promise<string> {
    let demo: DemoSession;
    try {
      demo = await startDemoSession();
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to start demo.');
    }
    const channelId = demo.channelId;
    allowTranscriptWrites(channelId);
    const meta: SessionMeta = {
      channelId,
      title: 'Demo session',
      cwd: '/home/user/my-project',
      kind: 'demo',
      addedAt: this.clock(),
    };
    const session = emptySession(channelId, meta);
    session.connection.status = 'connecting';
    this.store.dispatch(sessionAdded(session));
    const ctrl = new ChannelController(channelId, { ephemeral: true });
    ctrl.stopDemo = demo.stop;
    ctrl.client = demo.client;
    this.controllers.set(channelId, ctrl);
    this.registry.adopt(channelId, demo.client);
    this.store.dispatch(sessionActivated(channelId));
    this.attach(channelId, demo.client);
    return channelId;
  }

  // --- listener devices / phone-launched sessions -------------------------------------------------
  async registerListenerFromQr(raw: string): Promise<string> {
    const parsed = parsePairingPayload(raw);
    if (parsed.kind !== PAIR_KIND.LISTENER) throw new Error('This QR is not a listener device.');
    const { client, pairing } = await pairSession(raw);
    const now = this.clock();
    const prior = this.device(pairing.channelId);
    const stored: RegisteredDevice = {
      channelId: pairing.channelId,
      pub: pairing.peerPublicKeyB64,
      name: prior?.name,
      savedAt: now,
      isDefault: prior?.isDefault ?? this.store.getState().sessions.devices.length === 0,
      lastProjectName: prior?.lastProjectName,
    };
    await upsertDevice(stored);
    this.store.dispatch(
      deviceUpserted({
        ...stored,
        projects: prior?.projects ?? [],
        projectsLoading: true,
        connected: true,
      }),
    );
    this.attachListener(pairing.channelId, client);
    return `listener:${pairing.channelId}`;
  }

  listDevices(): ManagerSnapshot['devices'] {
    return this.getSnapshot().devices;
  }

  async connectDevice(channelId: string): Promise<void> {
    const device = this.device(channelId);
    if (!device) return;
    const current = this.listenerController(channelId);
    if (current?.client) return;
    this.store.dispatch(deviceProjectsLoadingSet({ channelId, loading: true }));
    try {
      const { client } = await pairWithPublicKey({ channelId, publicKeyB64: device.pub });
      this.attachListener(channelId, client);
    } catch (err) {
      this.store.dispatch(
        deviceErrorSet({ channelId, error: errMessage(err, 'Could not reach this listener device.'), connected: false }),
      );
    }
  }

  async refreshProjects(channelId: string): Promise<void> {
    await this.connectDevice(channelId);
    const ctrl = this.listenerController(channelId);
    if (!ctrl?.client) return;
    this.store.dispatch(deviceProjectsLoadingSet({ channelId, loading: true }));
    try {
      await ctrl.client.send(projectListRequest());
    } catch (err) {
      this.store.dispatch(
        deviceErrorSet({ channelId, error: errMessage(err, 'Could not request projects.'), connected: false }),
      );
    }
  }

  async spawnSession(channelId: string, opts: SpawnRequestOptions): Promise<string> {
    const device = this.device(channelId);
    if (!device) throw new Error('Choose a registered listener device first.');
    const requestId = `spawn-${this.clock()}-${Math.random().toString(36).slice(2, 8)}`;
    const tempId = `initializing-${requestId}`;
    const displayName = opts.name?.trim() || opts.projectName;
    const meta: SessionMeta = {
      channelId: tempId,
      title: displayName,
      cwd: null,
      kind: 'spawning',
      addedAt: this.clock(),
    };
    const session = emptySession(tempId, meta);
    session.connection.status = 'initializing';
    session.connection.spawning = {
      requestId,
      deviceId: channelId,
      deviceName: device.name,
      projectName: opts.projectName,
    };
    this.store.dispatch(sessionAdded(session));
    this.store.dispatch(sessionActivated(tempId));

    const pending: PendingSpawn = {
      requestId,
      tempId,
      deviceId: channelId,
      projectName: opts.projectName,
      name: opts.name?.trim() || undefined,
      timer: setTimeout(() => {
        this.failSpawn(requestId, 'Timed out waiting for the laptop to start the session.');
      }, SPAWN_TIMEOUT_MS),
    };
    this.pendingSpawns.set(requestId, pending);

    try {
      await this.connectDevice(channelId);
      const ctrl = this.listenerController(channelId);
      if (!ctrl?.client) throw new Error('Listener device is not connected.');
      await ctrl.client.send(spawnSessionMessage(requestId, opts.projectName, opts.mode, opts.name?.trim() || null));
      this.store.dispatch(deviceLastProjectSet({ channelId, projectName: opts.projectName }));
      void patchDevice(channelId, { lastProjectName: opts.projectName });
    } catch (err) {
      this.failSpawn(requestId, errMessage(err, 'Could not start the session.'));
    }

    return tempId;
  }

  async forgetDevice(channelId: string): Promise<void> {
    const ctrl = this.listenerController(channelId);
    if (ctrl?.client) {
      await ctrl.client.send(forgetDeviceMessage()).catch(() => {});
    }
    ctrl?.dispose();
    this.listenerControllers.delete(channelId);
    for (const pending of [...this.pendingSpawns.values()]) {
      if (pending.deviceId === channelId) this.failSpawn(pending.requestId, 'Listener device was forgotten.');
    }
    await removeDevice(channelId);
    this.store.dispatch(deviceRemoved(channelId));
  }

  async setDefaultDevice(channelId: string): Promise<void> {
    await persistDefaultDevice(channelId);
    this.store.dispatch(deviceDefaultSet(channelId));
  }

  private attachListener(channelId: string, client: HelmClient): void {
    let ctrl = this.listenerControllers.get(channelId);
    if (!ctrl) {
      ctrl = new ChannelController(channelId, { ephemeral: true });
      this.listenerControllers.set(channelId, ctrl);
    }
    const previous = ctrl.client;
    ctrl.detach();
    ctrl.client = client;
    if (previous && previous !== client) void previous.close().catch(() => {});
    const stopEvents = client.subscribe((message) => this.onListenerMessage(channelId, client, message));
    const stopStatus = client.onStatus((status) => {
      this.store.dispatch(deviceErrorSet({ channelId, connected: status === 'connected' }));
    });
    ctrl.unsubscribe = () => {
      stopEvents();
      stopStatus();
    };
    this.store.dispatch(deviceErrorSet({ channelId, error: undefined, connected: true }));
    void this.refreshProjects(channelId);
  }

  private onListenerMessage(channelId: string, client: HelmClient, message: EventEnvelope): void {
    const ctrl = this.listenerController(channelId);
    if (!ctrl || ctrl.client !== client || message.eventType !== EVENT_TYPE.CONTROL) return;
    if (message.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST) {
      const msg = message.msg as ProjectListMsg;
      this.store.dispatch(deviceProjectsReceived({ channelId, projects: msg.projects ?? [], deviceName: msg.deviceName }));
      if (msg.deviceName) void patchDevice(channelId, { name: msg.deviceName });
      return;
    }
    if (message.eventSubtype === SUBTYPE.CONTROL.SPAWN_PAIRING) {
      void this.handleSpawnPairing(message.msg as SpawnPairingMsg);
      return;
    }
    if (message.eventSubtype === SUBTYPE.CONTROL.SPAWN_RESULT) {
      const msg = message.msg as SpawnResultMsg;
      if (!msg.ok) this.failSpawn(msg.requestId, msg.error || 'The laptop could not start the session.');
    }
  }

  private async handleSpawnPairing(msg: SpawnPairingMsg): Promise<void> {
    const pending = this.pendingSpawns.get(msg.requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSpawns.delete(msg.requestId);
    try {
      const payload = msg.payload as PairingPayload;
      const { client, pairing } = await pairSession(payload);
      const title = msg.name || pending.name || msg.projectName || pending.projectName;
      const oldActive = this.activeId();
      await this.openPairedSession(client, pairing, { title, activate: true, renamed: Boolean(msg.name || pending.name) });
      this.store.dispatch(sessionRemoved(pending.tempId));
      if (oldActive === pending.tempId) this.store.dispatch(sessionActivated(pairing.channelId));
    } catch (err) {
      this.pendingSpawns.set(msg.requestId, { ...pending, timer: setTimeout(() => this.failSpawn(msg.requestId, 'Timed out waiting for the laptop to start the session.'), SPAWN_TIMEOUT_MS) });
      this.failSpawn(msg.requestId, errMessage(err, 'Received the new session, but could not pair to it.'));
    }
  }

  private failSpawn(requestId: string, error: string): void {
    const pending = this.pendingSpawns.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pendingSpawns.delete(requestId);
    const session = this.session(pending.tempId);
    if (!session) return;
    this.store.dispatch(statusSet({ id: pending.tempId, status: 'error', error }));
  }

  // --- session controls ----------------------------------------------------------------------------
  /** Rename a session to a user-chosen title (#37). Persists both the title and a `renamed` flag so
   *  the CLI-reported title never overrides it after a reload/resume. A blank name clears the rename
   *  and reverts to the CLI/cwd/creative-name default on the next update. */
  renameSession(channelId: string, rawTitle: string): void {
    const session = this.session(channelId);
    if (!session) return;
    const ctrl = this.controllers.get(channelId);
    const title = rawTitle.trim();
    if (!title) {
      const fallback = titleFor(channelId, session.meta.cwd, null);
      this.store.dispatch(titleSet({ id: channelId, title: fallback, renamed: false }));
      if (!ctrl?.ephemeral) void patchSession(channelId, { title: null, renamed: false });
      return;
    }
    this.store.dispatch(titleSet({ id: channelId, title, renamed: true }));
    if (!ctrl?.ephemeral) void patchSession(channelId, { title, renamed: true });
  }

  setActive(channelId: string): void {
    const session = this.session(channelId);
    if (!session) return;
    const ctrl = this.controllers.get(channelId);
    if (this.activeId() === channelId) {
      if (session.unread) {
        this.store.dispatch(unreadSet({ id: channelId, on: false }));
        if (!ctrl?.ephemeral) void patchSession(channelId, { unread: false, unreadCount: 0 });
      }
      return;
    }
    this.store.dispatch(sessionActivated(channelId));
    this.touchWarm(channelId);
    this.ensureConnected(channelId);
    if (!ctrl?.ephemeral) {
      const lastSeenAt = this.clock();
      void (async () => {
        await setLastActiveSessionId(channelId);
        await patchSession(channelId, { lastSeenAt, unread: false, unreadCount: 0 });
      })();
    }
  }

  async remove(channelId: string): Promise<void> {
    const session = this.session(channelId);
    if (!session) return;
    for (const pending of [...this.pendingSpawns.values()]) {
      if (pending.tempId === channelId) {
        clearTimeout(pending.timer);
        this.pendingSpawns.delete(pending.requestId);
      }
    }
    const ctrl = this.controllers.get(channelId);
    const wasActive = this.activeId() === channelId;
    discardTranscriptWrites(channelId);
    if (ctrl) {
      ctrl.dispose();
      this.controllers.delete(channelId);
    }
    this.registry.dispose(channelId);
    this.warmLru = this.warmLru.filter((id) => id !== channelId);
    if (!ctrl?.ephemeral) {
      await removeSession(channelId);
      await clearTranscript(channelId);
      await clearEventLog(channelId);
    }
    this.store.dispatch(sessionRemoved(channelId));
    if (wasActive) {
      const nextId = (this.store.getState().sessions.ids[0] as string | undefined) ?? null;
      if (nextId) {
        this.store.dispatch(sessionActivated(nextId));
        this.ensureConnected(nextId);
      }
    }
  }

  async reconnect(channelId: string): Promise<void> {
    const session = this.session(channelId);
    if (!session) return;
    const ctrl = this.ensureController(channelId);
    if (ctrl.ephemeral || ctrl.reconnecting) return;
    ctrl.reconnecting = true;
    this.store.dispatch(statusSet({ id: channelId, status: 'connecting', error: undefined }));
    try {
      const stored = (await loadSessions()).find((s) => s.pairing.channelId === channelId);
      if (!stored) {
        this.store.dispatch(
          statusSet({ id: channelId, status: 'error', error: 'This session is no longer saved on this device.' }),
        );
        return;
      }
      const client = await connectSession(stored.pairing);
      this.attach(channelId, client);
    } catch (err) {
      this.store.dispatch(
        statusSet({ id: channelId, status: 'error', error: errMessage(err, 'Failed to reconnect.') }),
      );
    } finally {
      ctrl.reconnecting = false;
    }
  }

  // --- user actions --------------------------------------------------------------------------------
  async sendPrompt(channelId: string, text: string, attachments?: PromptAttachment[]): Promise<void> {
    const session = this.session(channelId);
    if (!session) return;
    const ts = this.clock();
    const item = makeUserItem(`user-${ts}-${Math.random().toString(36).slice(2, 7)}`, text, ts, attachments);
    this.store.dispatch(userPromptAppended({ id: channelId, item }));
    // Flip the composer to its "Copilot working" / Stop state immediately instead of waiting for the
    // host's ACTIVITY(true) echo, so a sent prompt gives instant feedback (#85). The host's own
    // ACTIVITY(false) at end-of-turn (or the send-failure branch below) clears it.
    this.store.dispatch(busySet({ id: channelId, busy: true, ts }));
    this.schedulePersist(channelId);
    this.markActivity(channelId);
    try {
      await this.deliverPrompt(channelId, text, attachments);
    } catch {
      if (!this.session(channelId)) return;
      this.store.dispatch(busySet({ id: channelId, busy: false, ts: this.clock() }));
      this.store.dispatch(promptFailed({ id: channelId, itemId: item.id, failed: true }));
      this.schedulePersist(channelId);
    }
  }

  async retryPrompt(channelId: string, itemId: string): Promise<void> {
    const session = this.session(channelId);
    if (!session) return;
    const item = session.transcript.items.find((i) => i.kind === 'user' && i.id === itemId);
    if (!item || item.kind !== 'user') return;
    this.store.dispatch(promptFailed({ id: channelId, itemId, failed: false }));
    this.schedulePersist(channelId);
    try {
      await this.deliverPrompt(channelId, item.text, item.attachments);
    } catch {
      if (!this.session(channelId)) return;
      this.store.dispatch(promptFailed({ id: channelId, itemId, failed: true }));
      this.schedulePersist(channelId);
    }
  }

  private async deliverPrompt(channelId: string, text: string, attachments?: PromptAttachment[]): Promise<void> {
    await this.send(channelId, prompt(text, attachments));
  }

  async sendApproval(channelId: string, requestId: string, optionId: string): Promise<void> {
    const session = this.session(channelId);
    if (!session) return;
    // Ignore a second tap while the first decision is still sending (#88); tracking the requestId
    // also lets a racing state snapshot drop the already-dismissed card (#79).
    if (this.inFlightDecisions.has(requestId)) return;
    const pending = session.requests.approvals.find((a) => a.requestId === requestId);
    this.inFlightDecisions.add(requestId);
    try {
      await this.store.dispatch(
        optimistic({
          apply: approvalDismissed({ id: channelId, requestId }),
          send: () => this.send(channelId, approvalDecision(requestId, optionId)),
          rollback: (err) =>
            pending
              ? approvalRestored({
                  id: channelId,
                  req: pending,
                  error: errMessage(err, 'Could not send your decision — tap again to retry.'),
                })
              : undefined,
        }),
      );
    } finally {
      this.inFlightDecisions.delete(requestId);
    }
  }

  async sendElicitation(
    channelId: string,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ): Promise<void> {
    const session = this.session(channelId);
    if (!session) return;
    // Ignore a second submit while the first answer is still sending (#88); tracking the requestId
    // also lets a racing state snapshot drop the already-dismissed card (#79).
    if (this.inFlightDecisions.has(requestId)) return;
    const pending = session.requests.elicitations.find((e) => e.requestId === requestId);
    this.inFlightDecisions.add(requestId);
    try {
      await this.store.dispatch(
        optimistic({
          apply: elicitationDismissed({ id: channelId, requestId }),
          send: () => this.send(channelId, elicitationResponse(requestId, action, content)),
          rollback: (err) =>
            pending
              ? elicitationRestored({
                  id: channelId,
                  req: pending,
                  error: errMessage(err, 'Could not send your answer — try again.'),
                })
              : undefined,
        }),
      );
    } finally {
      this.inFlightDecisions.delete(requestId);
    }
  }

  async sendInterrupt(channelId: string): Promise<void> {
    const session = this.session(channelId);
    if (!session) return;
    // Release the Stop affordance immediately and settle any still-"running" tool so the button
    // can't wedge on a slow/dead host (#77). The host's own ACTIVITY(false)/TOOL_COMPLETE remains
    // authoritative and overrides this if the turn is genuinely still in flight.
    this.store.dispatch(interruptRequested({ id: channelId, ts: this.clock() }));
    try {
      await this.send(channelId, interrupt());
    } catch (err) {
      const latest = this.session(channelId);
      if (latest) {
        this.store.dispatch(
          statusSet({
            id: channelId,
            status: latest.connection.status,
            error: errMessage(err, 'Couldn’t send Stop — tap to retry.'),
          }),
        );
      }
    }
  }

  async sendMode(channelId: string, mode: SessionMode): Promise<void> {
    const session = this.session(channelId);
    if (!session) return;
    const prev = session.connection.mode;
    this.store.dispatch(modeSet({ id: channelId, mode, pending: true }));
    try {
      await this.send(channelId, modeChange(mode));
    } catch {
      this.store.dispatch(modeSet({ id: channelId, mode: prev }));
      this.store.dispatch(
        noticeAppended({
          id: channelId,
          level: 'warning',
          text: `Couldn't switch to ${mode} — still in ${prev}.`,
          ts: this.clock(),
        }),
      );
      this.schedulePersist(channelId);
    }
  }

  async setVoiceMode(active: boolean, channelId = this.activeId()): Promise<void> {
    if (!channelId) return;
    const session = this.session(channelId);
    const ctrl = this.controllers.get(channelId);
    if (!session || session.meta.kind !== 'live' || session.connection.status !== 'live' || !ctrl?.client) {
      return;
    }
    try {
      await this.send(channelId, voiceMode(active));
    } catch {
      // Voice mode is an advisory hint for the extension; never block or surface UI errors for it.
    }
  }

  // --- outbound funnel + persistence ---------------------------------------------------------------
  private async send(channelId: string, message: EventEnvelope): Promise<void> {
    const client = this.registry.get(channelId);
    if (!client) throw new Error('No active connection.');
    this.recordEvent(channelId, 'out', message);
    await client.send(message);
  }

  private recordEvent(channelId: string, dir: 'in' | 'out', message: EventEnvelope): void {
    // Heartbeats fire ~every 2.5s and would evict the substantive event chain (prompts, approvals,
    // tool_start/complete, elicitations) from the bounded ring within minutes (#67). Liveness is
    // already surfaced via connection.lastHeartbeat, so keep them out of the persisted debug log.
    if (
      message.eventType === EVENT_TYPE.CONTROL &&
      message.eventSubtype === SUBTYPE.CONTROL.HEARTBEAT
    ) {
      return;
    }
    const fallback = dir === 'out' ? getSenderName() : 'Copilot';
    const event = toDebugEvent(dir, message, (this.eventSeq += 1), fallback);
    this.store.dispatch(debugAppended({ id: channelId, event }));
    this.scheduleEventPersist(channelId);
  }

  private schedulePersist(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl || ctrl.ephemeral || ctrl.has('save')) return;
    ctrl.arm(
      'save',
      () => {
        ctrl.clear('save');
        const s = this.session(channelId);
        if (s) void saveTranscript(channelId, toPersisted(toTimelineState(s)));
      },
      PERSIST_THROTTLE_MS,
    );
  }

  private scheduleMetaPersist(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl || ctrl.ephemeral || ctrl.has('meta')) return;
    ctrl.arm(
      'meta',
      () => {
        ctrl.clear('meta');
        const s = this.session(channelId);
        if (s) void patchSession(channelId, { lastEventAt: s.lastEventAt ?? null, unread: s.unread ?? false, unreadCount: s.unreadCount ?? 0 });
      },
      META_PERSIST_THROTTLE_MS,
    );
  }

  private scheduleEventPersist(channelId: string): void {
    const ctrl = this.controllers.get(channelId);
    if (!ctrl || ctrl.ephemeral || ctrl.has('eventSave')) return;
    ctrl.arm(
      'eventSave',
      () => {
        ctrl.clear('eventSave');
        const s = this.session(channelId);
        if (s) void saveEventLog(channelId, s.debug);
      },
      PERSIST_THROTTLE_MS,
    );
  }

  // --- watchdog + resume ---------------------------------------------------------------------------
  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = setInterval(() => {
      const now = this.clock();
      for (const session of selectAllSessions(this.store.getState())) {
        const ctrl = this.controllers.get(session.id);
        if (!ctrl || ctrl.ephemeral) continue;
        const status = session.connection.status;
        if (status === 'connecting') {
          if (ctrl.connectingSince == null) {
            ctrl.connectingSince = now;
          } else if (now - ctrl.connectingSince > HOST_CONFIRM_MS) {
            this.store.dispatch(
              statusSet({
                id: session.id,
                status: 'error',
                error: 'Couldn’t reach your session — the terminal may be closed. Tap Reconnect to try again.',
              }),
            );
            if (session.connection.busy) this.store.dispatch(busySet({ id: session.id, busy: false }));
            ctrl.connectingSince = null;
            ctrl.reconnecting = false;
            this.clearSettle(session.id);
          }
          continue;
        }
        ctrl.connectingSince = null;
        if (status !== 'live' && status !== 'idle') continue;
        if (!ctrl.client) continue;
        const beat = session.connection.lastHeartbeat;
        if (beat && now - beat > OFFLINE_AFTER_MS) {
          this.store.dispatch(
            statusSet({ id: session.id, status: 'error', error: 'Connection lost — reconnect to resume.' }),
          );
          if (session.connection.busy) this.store.dispatch(busySet({ id: session.id, busy: false }));
        } else if (status === 'live' && beat && now - beat > IDLE_AFTER_MS) {
          this.store.dispatch(statusSet({ id: session.id, status: 'idle', error: undefined }));
          if (session.connection.busy) this.store.dispatch(busySet({ id: session.id, busy: false }));
        }
      }
    }, 1_000);
  }

  private handleResume = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = this.clock();
    // Foregrounding fires visibilitychange AND Capacitor appStateChange (and sometimes `online`)
    // back-to-back; a short leading-edge debounce collapses the overlapping triggers into one pass
    // so each warm session issues at most one state+history sync (#75).
    if (now - this.lastResumeAt < RESUME_DEBOUNCE_MS) return;
    this.lastResumeAt = now;
    for (const channelId of [...this.warmLru]) {
      const ctrl = this.controllers.get(channelId);
      const session = this.session(channelId);
      if (!ctrl || !session || ctrl.ephemeral) continue;
      // A session still inside its 30s confirmation window (just created a client) must not be torn
      // down and reconnected — that closes the fresh client, drops a pending host reply, and resets
      // the clock (#125). Let the confirm gate / watchdog resolve it.
      if (session.connection.status === 'connecting') continue;
      const beat = session.connection.lastHeartbeat;
      const stale = beat != null && now - beat > IDLE_AFTER_MS;
      const revive = !ctrl.client || session.connection.status === 'error' || stale;
      if (revive && session.connection.status !== 'ended') {
        void this.reconnect(channelId);
      } else {
        this.requestState(channelId);
        if (ctrl.client) this.syncHistory(channelId, ctrl.client);
      }
    }
  };

  private installResumeTriggers(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.handleResume);
    this.resumeCleanups.push(() => window.removeEventListener('online', this.handleResume));
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleResume);
      this.resumeCleanups.push(() => document.removeEventListener('visibilitychange', this.handleResume));
    }
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) this.handleResume();
    })
      .then((handle) => {
        this.resumeCleanups.push(() => handle.remove());
      })
      .catch(() => {
        // No Capacitor App bridge here — the visibility/online triggers already cover the web path.
      });
  }

  /** Tear down every socket, timer, and listener. Called when the app (or a test harness) shuts down. */
  dispose(): void {
    if (this.watchdog !== null) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
    for (const cleanup of this.resumeCleanups) {
      try {
        cleanup();
      } catch {
        /* ignore */
      }
    }
    this.resumeCleanups = [];
    for (const ctrl of this.controllers.values()) ctrl.dispose();
    this.controllers.clear();
    for (const ctrl of this.listenerControllers.values()) ctrl.dispose();
    this.listenerControllers.clear();
    for (const pending of this.pendingSpawns.values()) clearTimeout(pending.timer);
    this.pendingSpawns.clear();
    this.registry.disposeAll();
  }
}

export function createSessionRuntime(store?: AppStore): SessionRuntime {
  return new SessionRuntime(store);
}

import { ChannelController } from './channelController';

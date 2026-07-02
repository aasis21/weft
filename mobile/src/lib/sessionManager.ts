import { EVENT_TYPE, SUBTYPE, approvalDecision, elicitationResponse, historyRequest, recentTurnsRequest, interrupt, modeChange, prompt, stateRequest, HISTORY_PAGE_DEFAULT, RECENT_TURNS_DEFAULT } from '@aasis21/helm-shared';
import type { EventEnvelope, PromptAttachment, SessionMode } from '@aasis21/helm-shared';
import { connectSession, pairSession, getSenderName } from './helmClient';
import type { HelmClient } from './helmClient';
import {
  appendNotice,
  appendUser,
  dismissApproval,
  dismissElicitation,
  emptyTimeline,
  markHistoryLoading,
  reduceTimeline,
  restoreApproval,
  restoreElicitation,
  restoreTimeline,
  setUserFailed,
  toPersisted,
} from './timeline';
import type { TimelineState } from './timeline';
import { loadSessions, patchSession, removeSession, upsertSession } from './sessions';
import type { StoredSession } from './sessions';
import { clearTranscript, loadTranscript, saveTranscript } from './transcripts';
import { clearEventLog, loadEventLog, saveEventLog, toDebugEvent, EVENT_LOG_CAP } from './eventLog';
import type { DebugEvent } from './eventLog';
import { startDemoSession } from './demoSimulator';
import type { DemoSession } from './demoSimulator';
import {
  ensureNotificationPermission,
  notifyApprovalRequest,
  notifyElicitationRequest,
  notifySessionEnded,
} from './notifications';
import { App } from '@capacitor/app';

export type SessionStatus = 'connecting' | 'live' | 'idle' | 'ended' | 'error';

export interface SessionMeta {
  channelId: string;
  /** The Copilot CLI session this card mirrors (announced via channel_up). The card is deduped by
   *  this durable id, so a resume that rotates the channelId keeps the same card. */
  sessionId?: string;
  title: string;
  cwd: string | null;
  kind: 'live' | 'demo';
  addedAt: number;
  /** When this session's QR was last scanned (pairing.savedAt). Drives a STABLE sidebar order that
   *  does not reshuffle on incoming events/heartbeats; a re-scan bumps it to the top. */
  scannedAt?: number;
}

/** Immutable, React-facing view of one joined session. */
export interface SessionView {
  meta: SessionMeta;
  status: SessionStatus;
  timeline: TimelineState;
  unread?: boolean;
  /** Last real host activity (ms). Drives the sidebar's newest-first ordering; survives reload. */
  lastEventAt?: number;
  /** True during the brief, bounded post-Live grace while the first history page is still arriving —
   *  the UI shows the connecting skeleton instead of flashing the empty-welcome. */
  settling?: boolean;
  /** Raw wire events exchanged with the laptop (both directions), oldest-first — the debug panel
   *  renders them newest-first. Persisted per session and restored on reload. */
  events: DebugEvent[];
  error?: string;
}

export interface ManagerSnapshot {
  ready: boolean;
  activeId: string | null;
  sessions: SessionView[];
}

interface Runtime {
  meta: SessionMeta;
  status: SessionStatus;
  timeline: TimelineState;
  client: HelmClient | null;
  ephemeral: boolean;
  unread?: boolean;
  error?: string;
  /** Deadline timer that fires if no genuine host signal confirms liveness within HOST_CONFIRM_MS. */
  confirmTimer?: number;
  /** True while a reconnect is in flight, so concurrent triggers (resume + button) don't race. */
  reconnecting?: boolean;
  /** Coalesced timer for persisting lastEventAt / unread. */
  metaTimer?: number;
  /** Last real host activity (ms); recency for the warm-pool LRU + sidebar sort. */
  lastEventAt?: number;
  /** Bounded grace after first going Live during which the initial history skeleton is held. */
  settling?: boolean;
  settleTimer?: number;
  /** Fail-safe deadline that clears historyLoading if the recent-turns/history reply is lost, so a
   *  single dropped answer can't spin the loader forever (bug: no-response-received). */
  historyTimer?: number;
  /** When the current 'connecting' attempt began. The confirm deadline only arms AFTER connect
   *  resolves, so a hung connect (killed terminal) would spin forever; the watchdog stamps this and
   *  fails the attempt past HOST_CONFIRM_MS. */
  connectingSince?: number;
  unsubscribe?: () => void;
  stopDemo?: () => Promise<void>;
  saveTimer?: number;
  /** Raw wire events (both directions), oldest-first; a bounded ring capped at EVENT_LOG_CAP. */
  events?: DebugEvent[];
  /** Coalesced timer for persisting the debug event log. */
  eventSaveTimer?: number;
}

// A healthy session heartbeats on a fixed interval (the extension beats every 15s —
// see DEFAULT_HEARTBEAT_MS in extension/src/relay.mjs). Only flag a session "Quiet"
// once a beat has been missed with slack, so a live session never flickers Live->Quiet.
const IDLE_AFTER_MS = 20_000;
const OFFLINE_AFTER_MS = 30_000;
// "Live" requires a genuine two-way signal from the laptop within this window. On every (re)connect
// we arm this deadline; if no real host message (event / heartbeat / state snapshot) arrives, the
// host is treated as offline. Joining the relay channel or a socket 'connected' NEVER counts as
// liveness — the relay outlives a killed terminal, so a channel join proves nothing about the host.
const HOST_CONFIRM_MS = 30_000;
// After a session first goes Live, hold the initial history skeleton for at most this long instead of
// flashing the empty-welcome. The wait is bounded by THIS timer, never by the history reply, so a slow
// or lost page can't spin the loader forever (a dead host is caught by HOST_CONFIRM_MS separately).
const INITIAL_HISTORY_GRACE_MS = 700;
// Keep at most this many sessions "warm" (a live subscription on the single shared socket), evicted
// least-recently-active first. The rest stay "cold": their card + transcript are kept and they
// reconnect on demand when opened. Bounds server fan-out for the handful of terminals a user runs.
const MAX_WARM_SESSIONS = 10;
// Coalesce session-metadata writes (lastEventAt / unread) so an activity burst doesn't hammer storage.
const META_PERSIST_THROTTLE_MS = 1_500;
// Coalesce transcript writes so a burst of stream deltas doesn't hammer storage.
const PERSIST_THROTTLE_MS = 800;
// Fail-safe: if a recent-turns/history reply is lost (superseded channel after reconnect, transport
// drop, decrypt miss, extension busy/teardown), clear the loading affordance after this long so the
// UI never spins forever. The next connect re-requests and self-heals.
const HISTORY_REQUEST_TIMEOUT_MS = 8_000;

function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function titleFor(channelId: string, cwd: string | null, stored: string | null): string {
  return stored || basename(cwd) || `Session ${channelId.slice(0, 6)}`;
}

function isUnreadActivity(message: EventEnvelope): boolean {
  switch (message.eventType) {
    case EVENT_TYPE.STREAM:
      // Any streamed host activity except a bare terminal-typed echo counts as "new".
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

export class SessionManager {
  private runtimes = new Map<string, Runtime>();
  private order: string[] = [];
  private activeId: string | null = null;
  private ready = false;
  private listeners = new Set<() => void>();
  private snapshot: ManagerSnapshot = { ready: false, activeId: null, sessions: [] };
  private initStarted = false;
  private watchdog: number | null = null;
  // Warm sessions (a live subscription on the shared socket), most-recently-active LAST. Bounded by
  // MAX_WARM_SESSIONS; the active session is never evicted.
  private warmLru: string[] = [];
  // Monotonic sequence for unique debug-event ids within this run.
  private eventSeq = 0;

  // --- useSyncExternalStore wiring -------------------------------------
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ManagerSnapshot => this.snapshot;

  private emit(): void {
    this.snapshot = {
      ready: this.ready,
      activeId: this.activeId,
      sessions: this.order
        .map((id) => this.runtimes.get(id))
        .filter((r): r is Runtime => !!r)
        .map((r) => ({
          meta: { ...r.meta },
          status: r.status,
          timeline: r.timeline,
          ...(r.unread ? { unread: true } : {}),
          ...(r.lastEventAt ? { lastEventAt: r.lastEventAt } : {}),
          ...(r.settling ? { settling: true } : {}),
          events: r.events ?? [],
          error: r.error,
        })),
    };
    for (const listener of this.listeners) listener();
  }

  // --- lifecycle -------------------------------------------------------
  async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    void ensureNotificationPermission();
    this.startWatchdog();
    this.installResumeTriggers();
    let stored: StoredSession[] = [];
    try {
      stored = await loadSessions();
    } catch {
      stored = [];
    }
    // LOCAL-FIRST: restore each session's transcript from the device so a refresh shows
    // the conversation instantly — before (and even without) a successful reconnect.
    const restored = await Promise.all(
      stored.map(async (s) => ({
        channelId: s.pairing.channelId,
        persisted: await loadTranscript(s.pairing.channelId).catch(() => null),
        events: await loadEventLog(s.pairing.channelId).catch(() => []),
      })),
    );
    const persistedById = new Map(restored.map((r) => [r.channelId, r.persisted]));
    const eventsById = new Map(restored.map((r) => [r.channelId, r.events]));

    // Warm only the most-recently-active sessions on the single shared socket; the rest stay cold
    // (card + transcript kept) and reconnect the moment they're opened. Recency prefers real activity
    // (lastEventAt), then when the card was last opened, then when it was added.
    const recencyOf = (s: StoredSession): number =>
      Math.max(s.lastEventAt ?? 0, s.lastSeenAt ?? 0, s.addedAt ?? 0);
    const warmIds = new Set(
      [...stored]
        .sort((a, b) => recencyOf(b) - recencyOf(a))
        .slice(0, MAX_WARM_SESSIONS)
        .map((s) => s.pairing.channelId),
    );

    for (const s of stored) {
      const channelId = s.pairing.channelId;
      const persisted = persistedById.get(channelId) ?? null;
      const timeline = restoreTimeline(persisted);
      const meta: SessionMeta = {
        channelId,
        sessionId: s.sessionId ?? undefined,
        title: titleFor(channelId, timeline.cwd ?? s.cwd, timeline.title ?? s.title),
        cwd: timeline.cwd ?? s.cwd,
        kind: 'live',
        addedAt: s.addedAt,
        scannedAt: s.pairing.savedAt ?? s.addedAt,
      };
      // Cold sessions rest at 'idle' with no client (the watchdog and resume both skip them); a warm
      // session starts 'connecting' and its liveness must be confirmed by a genuine host signal.
      this.runtimes.set(channelId, {
        meta,
        status: warmIds.has(channelId) ? 'connecting' : 'idle',
        timeline,
        client: null,
        ephemeral: false,
        unread: s.unread ?? false,
        lastEventAt: s.lastEventAt ?? undefined,
        events: eventsById.get(channelId) ?? [],
      });
      if (!this.order.includes(channelId)) this.order.push(channelId);
    }
    // Default to the most-recently-active session so the one we open first is always warm.
    if (!this.activeId && stored.length > 0) {
      const first = [...stored].sort((a, b) => recencyOf(b) - recencyOf(a))[0];
      this.activeId = first?.pairing.channelId ?? this.order[0];
      if (this.activeId) warmIds.add(this.activeId);
    }
    this.ready = true;
    this.emit();

    // Connect only the warm sessions concurrently (one shared socket, N cheap subscriptions).
    await Promise.all(
      stored
        .filter((s) => warmIds.has(s.pairing.channelId))
        .map(async (s) => {
          const channelId = s.pairing.channelId;
          try {
            const client = await connectSession(s.pairing);
            this.attach(channelId, client);
          } catch (err) {
            const runtime = this.runtimes.get(channelId);
            if (runtime) {
              runtime.status = 'error';
              runtime.error = err instanceof Error ? err.message : 'Failed to reconnect.';
              this.emit();
            }
          }
        }),
    );
  }

  private attach(channelId: string, client: HelmClient): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) {
      void client.close();
      return;
    }
    const previous = runtime.client;
    runtime.unsubscribe?.();
    runtime.client = client;
    runtime.error = undefined;
    // Drop the superseded channel so a reconnect doesn't leak a subscription on the shared socket.
    if (previous && previous !== client) void previous.close();
    const stopEvents = client.subscribe((message) => this.onMessage(channelId, client, message));
    const stopStatus = client.onStatus((status) =>
      this.handleTransportStatus(channelId, client, status),
    );
    runtime.unsubscribe = () => {
      stopEvents();
      stopStatus();
    };
    // Demo runs on an in-process simulator, so it's live the instant it's wired. A real session is
    // only "Live" once the laptop actually answers — joining the relay proves nothing (the channel
    // outlives a killed terminal). Hold at 'connecting' and arm the confirmation deadline; the
    // stateRequest below makes the extension reply immediately when it's alive.
    if (runtime.ephemeral) {
      runtime.status = 'live';
      this.emit();
    } else {
      this.touchWarm(channelId);
      this.beginHostConfirm(channelId, client);
    }
    // Ask for the current session state (busy/mode + any pending prompts) so a fresh, mid-turn,
    // or reconnecting join reflects the truth immediately instead of waiting for the next event.
    // This is also the two-way probe: its stateSnapshot reply confirms the host is alive.
    this.requestState(channelId);
    // One self-healing history sync for every path (first join, reconnect, rescan, resume): pull the
    // latest page when the thread is empty, otherwise catch up on the turns missed while away.
    this.syncHistory(channelId, client);
  }

  /**
   * Enter the unconfirmed 'connecting' state and arm the liveness deadline. If no genuine host
   * signal (event / heartbeat / state snapshot) arrives within HOST_CONFIRM_MS, the host is offline:
   * we surface an actionable error and clear any stuck "working". This is the single guard that keeps
   * "Live" honest on EVERY path — first join, reconnect, socket-recovery, resume, cold→warm.
   */
  private beginHostConfirm(channelId: string, client: HelmClient): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral || runtime.client !== client) return;
    runtime.status = 'connecting';
    runtime.error = undefined;
    runtime.connectingSince = Date.now();
    this.clearSettle(runtime);
    if (runtime.confirmTimer != null) window.clearTimeout(runtime.confirmTimer);
    runtime.confirmTimer = window.setTimeout(() => {
      const r = this.runtimes.get(channelId);
      // Ignore a fired timer whose connection has since been superseded or already confirmed/ended.
      if (!r || r.client !== client || r.confirmTimer == null) return;
      r.confirmTimer = undefined;
      if (r.status !== 'connecting') return;
      r.status = 'error';
      r.error = 'Copilot terminal offline — reopen it on your laptop and scan the new QR.';
      if (r.timeline.busy) r.timeline = { ...r.timeline, busy: false };
      this.emit();
    }, HOST_CONFIRM_MS);
    this.emit();
  }

  /** Confirm the host is alive on the FIRST genuine inbound signal: clear the deadline and go Live. */
  private confirmHost(runtime: Runtime): void {
    const wasLive = runtime.status === 'live';
    if (runtime.confirmTimer != null) {
      window.clearTimeout(runtime.confirmTimer);
      runtime.confirmTimer = undefined;
    }
    runtime.connectingSince = undefined;
    if (!wasLive) runtime.status = 'live';
    if (runtime.error) runtime.error = undefined;
    if (runtime.timeline.lastHeartbeat == null) {
      runtime.timeline = { ...runtime.timeline, lastHeartbeat: Date.now() };
    }
    // The instant we FIRST hear the laptop, the session is ready to use. If its thread is empty and the
    // first history page is still in flight, hold the skeleton for a short BOUNDED grace instead of
    // flashing the empty-welcome; the initial page (onMessage) or the timer clears it, whichever first.
    if (!wasLive) {
      const t = runtime.timeline;
      const emptyAndLoading = t.items.length === 0 && t.history.length === 0 && t.historyLoading;
      if (emptyAndLoading) this.beginSettle(runtime);
      else this.clearSettle(runtime);
    }
  }

  /** Arm the bounded post-Live grace: keep the initial skeleton for at most INITIAL_HISTORY_GRACE_MS. */
  private beginSettle(runtime: Runtime): void {
    if (runtime.settleTimer != null) window.clearTimeout(runtime.settleTimer);
    runtime.settling = true;
    const channelId = runtime.meta.channelId;
    runtime.settleTimer = window.setTimeout(() => {
      const r = this.runtimes.get(channelId);
      if (!r) return;
      r.settleTimer = undefined;
      if (r.settling) {
        r.settling = false;
        this.emit();
      }
    }, INITIAL_HISTORY_GRACE_MS);
  }

  /** Cancel the grace and drop the initial skeleton (first page arrived, or the session was torn down). */
  private clearSettle(runtime: Runtime): void {
    if (runtime.settleTimer != null) {
      window.clearTimeout(runtime.settleTimer);
      runtime.settleTimer = undefined;
    }
    runtime.settling = false;
  }

  /**
   * React to live socket-state changes the transport reports (distinct from the heartbeat
   * watchdog). A silent drop flips the session to Offline immediately — issue #44, where a
   * dropped WebSocket otherwise lingered as "Quiet" for up to 45s. A socket rejoin does NOT mean the
   * host is back (the relay reconnects independently of the laptop), so we re-arm the confirmation
   * gate and re-probe instead of assuming Live. `client` is captured so a late event from a
   * superseded connection is ignored.
   */
  private handleTransportStatus(
    channelId: string,
    client: HelmClient,
    status: 'connected' | 'disconnected',
  ): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.client !== client || runtime.ephemeral || runtime.status === 'ended') {
      return;
    }
    if (status === 'disconnected') {
      if (runtime.status === 'live' || runtime.status === 'idle') {
        runtime.status = 'error';
        runtime.error = 'Connection lost — reconnect to resume.';
        // A dead socket can't be actively working; drop a stuck Stop control.
        if (runtime.timeline.busy) runtime.timeline = { ...runtime.timeline, busy: false };
        this.emit();
      }
      return;
    }
    // A socket RECOVERY (after a drop → 'error') re-joined the relay, but that's not proof the laptop
    // is alive. Re-arm the confirmation gate and re-probe; the stateSnapshot reply flips us to Live.
    // The first connect is handled by attach(), so a 'connected' while still 'connecting' is skipped.
    if (runtime.status === 'error') {
      this.beginHostConfirm(channelId, client);
      this.requestState(channelId);
    }
  }

  /**
   * Pull a connect-time state snapshot: the extension's authoritative busy/mode plus any approval
   * or ask_user prompts still open at the terminal. Best-effort — an older extension build that
   * doesn't answer just leaves us on live events, exactly as before.
   */
  private requestState(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral || !runtime.client) return;
    void this.dispatch(channelId, runtime.client, stateRequest()).catch(() => {
      // A failed state request must never break the connection; live events still flow.
    });
  }

  /**
   * One self-healing history sync, shared by every connect path (first join, reconnect, rescan,
   * refresh, resume). It asks the extension for its in-memory RECENT-TURNS snapshot — the last ~50
   * turns it knows, with the FULL assistant text the CLI store drops for long/multi-tool turns.
   *
   * The snapshot is self-contained and idempotent, so ONE request covers every path: the reducer
   * dedups whatever the transcript already shows (by id + content) and appends only genuinely-new
   * turns at the tail behind a "N new while you were away" divider. An empty thread arms the loading
   * affordance (with a bounded fail-safe so a lost reply can't spin forever); a thread that already
   * has turns just merges silently. DB `historyRequest` is now used ONLY for "Load earlier" scrollback.
   */
  private syncHistory(channelId: string, client: HelmClient): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    const timeline = runtime.timeline;
    const hasContent = timeline.history.length > 0 || timeline.items.length > 0;
    if (!hasContent) {
      runtime.timeline = markHistoryLoading(runtime.timeline, true);
      this.armHistoryTimeout(channelId);
      this.emit();
    }
    void this.dispatch(channelId, client, recentTurnsRequest(RECENT_TURNS_DEFAULT)).catch(() => {
      const r = this.runtimes.get(channelId);
      if (r) {
        r.timeline = markHistoryLoading(r.timeline, false);
        this.clearHistoryTimeout(r);
        this.emit();
      }
    });
  }

  /** Arm the fail-safe that clears a stuck historyLoading if the recent-turns reply never lands. */
  private armHistoryTimeout(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    if (runtime.historyTimer != null) window.clearTimeout(runtime.historyTimer);
    runtime.historyTimer = window.setTimeout(() => {
      const r = this.runtimes.get(channelId);
      if (!r) return;
      r.historyTimer = undefined;
      if (r.timeline.historyLoading) {
        r.timeline = markHistoryLoading(r.timeline, false);
        this.emit();
      }
    }, HISTORY_REQUEST_TIMEOUT_MS);
  }

  /** Cancel the history fail-safe (reply arrived, or the session was torn down). */
  private clearHistoryTimeout(runtime: Runtime): void {
    if (runtime.historyTimer != null) {
      window.clearTimeout(runtime.historyTimer);
      runtime.historyTimer = undefined;
    }
  }

  private onMessage(channelId: string, client: HelmClient, message: EventEnvelope): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    // Ignore a message that decrypted after its channel was superseded (reconnect) or cooled to cold
    // (client=null): acting on it could set a stale card back to 'live' with no live connection.
    if (runtime.client !== client) return;
    // Capture the raw inbound event for the debug panel before we reduce/route it.
    this.recordEvent(channelId, 'in', message);
    runtime.timeline = reduceTimeline(runtime.timeline, message);
    if (isUnreadActivity(message)) {
      runtime.unread = channelId !== this.activeId;
      // Real host activity (not a bare heartbeat) is what "recently active" means: bump the sort/LRU
      // recency and persist it (coalesced) so ordering + unread survive reload and cold eviction.
      this.markActivity(channelId);
    }

    if (message.eventType === EVENT_TYPE.CONTROL && message.eventSubtype === SUBTYPE.CONTROL.HISTORY) {
      // Backward scrollback page ("Load earlier"), empty or not: settle the thread, drop the grace.
      this.clearSettle(runtime);
    }

    // The recent-turns snapshot (the primary connect-time backfill) settles the thread and clears the
    // loading fail-safe, whether or not it added anything — the reply landed.
    if (message.eventType === EVENT_TYPE.CONTROL && message.eventSubtype === SUBTYPE.CONTROL.RECENT_TURNS) {
      this.clearHistoryTimeout(runtime);
      this.clearSettle(runtime);
    }

    if (message.eventType === EVENT_TYPE.CONTROL && message.eventSubtype === SUBTYPE.CONTROL.CHANNEL_DOWN) {
      runtime.status = 'ended';
      if (runtime.confirmTimer != null) {
        window.clearTimeout(runtime.confirmTimer);
        runtime.confirmTimer = undefined;
      }
      this.clearSettle(runtime);
      void notifySessionEnded(runtime.timeline.endedReason);
    } else {
      // ANY inbound message is genuinely from the laptop (broadcast self:false), so it proves the
      // host is alive: confirm liveness and satisfy the confirmation gate.
      this.confirmHost(runtime);
    }

    // A channel announces which Copilot session it serves. Key the card by that durable sessionId so
    // a `copilot --resume` (which rotates the channelId) collapses onto the same card instead of
    // forking a new one.
    if (message.eventType === EVENT_TYPE.CONTROL && message.eventSubtype === SUBTYPE.CONTROL.CHANNEL_UP) {
      const sid = message.sessionId;
      if (sid && sid !== 'unknown-session') {
        if (runtime.meta.sessionId !== sid) {
          runtime.meta.sessionId = sid;
          if (!runtime.ephemeral) void patchSession(channelId, { sessionId: sid });
        }
        this.reconcileBySessionId(channelId, sid);
      }
    }

    if (runtime.timeline.cwd && runtime.timeline.cwd !== runtime.meta.cwd) {
      runtime.meta.cwd = runtime.timeline.cwd;
      if (!runtime.ephemeral) void patchSession(channelId, { cwd: runtime.timeline.cwd });
    }

    // The real CLI chat title (summary) wins; until it arrives we fall back to the cwd
    // basename. Persist only the genuine title. Demo (ephemeral) keeps its canned title.
    if (!runtime.ephemeral) {
      const nextTitle = titleFor(channelId, runtime.meta.cwd, runtime.timeline.title);
      if (nextTitle !== runtime.meta.title) {
        runtime.meta.title = nextTitle;
        if (runtime.timeline.title) void patchSession(channelId, { title: runtime.timeline.title });
      }
    }

    if (message.eventType === EVENT_TYPE.APPROVAL && message.eventSubtype === SUBTYPE.APPROVAL.REQUEST) {
      void notifyApprovalRequest(message.msg);
    }
    if (message.eventType === EVENT_TYPE.ELICITATION && message.eventSubtype === SUBTYPE.ELICITATION.REQUEST) {
      void notifyElicitationRequest(message.msg);
    }

    // LOCAL-FIRST: persist the transcript so a refresh restores it without a pull.
    this.schedulePersist(channelId);

    this.emit();
  }

  /** Coalesced, best-effort persist of a session's transcript to the local store. */
  private schedulePersist(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral || runtime.saveTimer != null) return;
    runtime.saveTimer = window.setTimeout(() => {
      const r = this.runtimes.get(channelId);
      if (!r) return;
      r.saveTimer = undefined;
      void saveTranscript(channelId, toPersisted(r.timeline));
    }, PERSIST_THROTTLE_MS);
  }

  /**
   * Append one wire event to a session's debug log (a bounded ring, oldest fall off the front) and
   * schedule a coalesced persist. Captured for BOTH directions so the debug panel shows the full
   * event chain; the caller is responsible for emitting so React re-renders.
   */
  private recordEvent(channelId: string, dir: 'in' | 'out', message: EventEnvelope): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    const fallback = dir === 'out' ? getSenderName() : 'Copilot';
    const event = toDebugEvent(dir, message, (this.eventSeq += 1), fallback);
    const next = runtime.events ? [...runtime.events, event] : [event];
    runtime.events = next.length > EVENT_LOG_CAP ? next.slice(next.length - EVENT_LOG_CAP) : next;
    this.scheduleEventPersist(channelId);
  }

  /** Coalesced, best-effort persist of a session's debug event log. Skips demo (ephemeral) sessions. */
  private scheduleEventPersist(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral || runtime.eventSaveTimer != null) return;
    runtime.eventSaveTimer = window.setTimeout(() => {
      const r = this.runtimes.get(channelId);
      if (!r) return;
      r.eventSaveTimer = undefined;
      void saveEventLog(channelId, r.events ?? []);
    }, PERSIST_THROTTLE_MS);
  }

  /**
   * The single outbound funnel: record the envelope to the session's debug log (so every phone→laptop
   * message shows in the panel), then hand it to the transport. Returns the send promise unchanged so
   * existing `.catch()` recovery on every call site keeps working.
   */
  private dispatch(channelId: string, client: HelmClient, message: EventEnvelope): Promise<void> {
    this.recordEvent(channelId, 'out', message);
    this.emit();
    return client.send(message);
  }

  /** Coalesced persist of the durable presence fields (lastEventAt + unread) into the session list. */
  private scheduleMetaPersist(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral || runtime.metaTimer != null) return;
    runtime.metaTimer = window.setTimeout(() => {
      const r = this.runtimes.get(channelId);
      if (!r) return;
      r.metaTimer = undefined;
      void patchSession(channelId, {
        lastEventAt: r.lastEventAt ?? null,
        unread: r.unread ?? false,
      });
    }, META_PERSIST_THROTTLE_MS);
  }

  /** Record real activity on a session: advance its recency (sort + warm-pool LRU) and persist it. */
  private markActivity(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    runtime.lastEventAt = Date.now();
    this.touchWarm(channelId);
    this.scheduleMetaPersist(channelId);
  }

  /** Promote a session to most-recently-used in the warm pool, then evict any beyond the cap. */
  private touchWarm(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    const i = this.warmLru.indexOf(channelId);
    if (i >= 0) this.warmLru.splice(i, 1);
    this.warmLru.push(channelId);
    this.evictBeyondWarmLimit();
  }

  /** Cool down the least-recently-active warm sessions past the cap. The active session is spared. */
  private evictBeyondWarmLimit(): void {
    while (this.warmLru.length > MAX_WARM_SESSIONS) {
      const victimIndex = this.warmLru.findIndex((id) => id !== this.activeId);
      if (victimIndex < 0) break;
      const [victimId] = this.warmLru.splice(victimIndex, 1);
      this.coolDown(victimId);
    }
  }

  /** Drop a session's live subscription/socket while keeping its card, transcript, and unread. A
   *  cold session receives no events until it's opened again, which reconnects it via ensureConnected. */
  private coolDown(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    runtime.unsubscribe?.();
    runtime.unsubscribe = undefined;
    if (runtime.confirmTimer != null) {
      window.clearTimeout(runtime.confirmTimer);
      runtime.confirmTimer = undefined;
    }
    this.clearSettle(runtime);
    runtime.connectingSince = undefined;
    void runtime.client?.close();
    runtime.client = null;
    if (runtime.status !== 'ended') runtime.status = 'idle';
    runtime.error = undefined;
    // A cold session isn't connected, so it can't be working.
    if (runtime.timeline.busy) runtime.timeline = { ...runtime.timeline, busy: false };
    this.emit();
  }

  /** Warm a session on demand (e.g. when it's opened): (re)connect unless it's already live or
   *  actively connecting. Covers cold (evicted → 'idle', no client), quiet ('idle'), and dropped
   *  ('error') sessions so opening one always drives it back toward Live. */
  private ensureConnected(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral || runtime.status === 'ended') return;
    if (runtime.status === 'live' || runtime.status === 'connecting') return;
    void this.reconnect(channelId);
  }

  /** Collapse a stale duplicate card when a channel reports a sessionId we already track under a
   *  different channelId (e.g. `copilot --resume` rotated the channelId). The live channel keeps its
   *  card; the stale one is torn down. Continuity: seed the (empty) live timeline from the stale one,
   *  then the self-healing history sync forward-catches-up. */
  private reconcileBySessionId(keepId: string, sessionId: string): void {
    const keep = this.runtimes.get(keepId);
    if (!keep) return;
    for (const [staleId, stale] of this.runtimes) {
      if (staleId === keepId || stale.ephemeral) continue;
      if (stale.meta.sessionId !== sessionId) continue;

      // Keep the earliest addedAt so the merged card holds its place in the list.
      keep.meta.addedAt = Math.min(keep.meta.addedAt, stale.meta.addedAt);
      if (!keep.timeline.title && stale.meta.title) keep.meta.title = stale.meta.title;
      // Seed the transcript for instant continuity when the live channel is still empty (a fresh
      // resume); the history sync then forward-catches-up. If it already has content, leave it.
      if (keep.timeline.items.length === 0 && keep.timeline.history.length === 0) {
        keep.timeline = {
          ...keep.timeline,
          items: stale.timeline.items,
          history: stale.timeline.history,
          historyCursor: stale.timeline.historyCursor,
          historyHasMore: stale.timeline.historyHasMore,
          latestTurnIndex: keep.timeline.latestTurnIndex ?? stale.timeline.latestTurnIndex,
        };
      }
      keep.unread = keep.unread || stale.unread;

      // Tear down the stale channel + its card + its stored/transcript state.
      stale.unsubscribe?.();
      void stale.client?.close();
      if (stale.saveTimer != null) window.clearTimeout(stale.saveTimer);
      if (stale.metaTimer != null) window.clearTimeout(stale.metaTimer);
      if (stale.confirmTimer != null) window.clearTimeout(stale.confirmTimer);
      if (stale.settleTimer != null) window.clearTimeout(stale.settleTimer);
      if (stale.eventSaveTimer != null) window.clearTimeout(stale.eventSaveTimer);
      this.runtimes.delete(staleId);
      this.order = this.order.filter((id) => id !== staleId);
      this.warmLru = this.warmLru.filter((id) => id !== staleId);
      if (this.activeId === staleId) this.activeId = keepId;
      void removeSession(staleId);
      void clearTranscript(staleId);
      void clearEventLog(staleId);
    }
  }

  // --- adding sessions -------------------------------------------------
  async addByQr(raw: string): Promise<string> {
    const { client, pairing } = await pairSession(raw);
    const channelId = pairing.channelId;
    const existing = this.runtimes.get(channelId);
    if (existing && !existing.ephemeral) {
      // Rescanning a session we already track (same channelId): refresh the pairing and rebind a
      // fresh client while KEEPING the existing transcript. Overwriting the runtime would orphan the
      // old client (a leaked socket that keeps delivering into the same timeline) and wipe history.
      const prior = (await loadSessions()).find((s) => s.pairing.channelId === channelId);
      await upsertSession({
        pairing,
        sessionId: prior?.sessionId ?? existing.meta.sessionId ?? null,
        title: prior?.title ?? null,
        cwd: prior?.cwd ?? null,
        addedAt: prior?.addedAt ?? existing.meta.addedAt,
        lastSeenAt: Date.now(),
      });
      try {
        await existing.client?.close();
      } catch {
        // The old socket may already be gone; the fresh client supersedes it either way.
      }
      existing.client = null;
      // A re-scan is a fresh QR pairing: bump the scan time so the card jumps to the top of the sidebar.
      existing.meta.scannedAt = pairing.savedAt ?? Date.now();
      if (!this.order.includes(channelId)) this.order.push(channelId);
      this.activeId = channelId;
      // attach() rewires the transport and runs syncHistory: with a transcript already present this
      // forward-catches-up the turns missed since the last cursor instead of pulling from scratch.
      this.attach(channelId, client);
      return channelId;
    }
    const stored: StoredSession = {
      pairing,
      title: null,
      cwd: null,
      addedAt: Date.now(),
      lastSeenAt: Date.now(),
    };
    await upsertSession(stored);
    const meta: SessionMeta = {
      channelId,
      title: titleFor(channelId, null, null),
      cwd: null,
      kind: 'live',
      addedAt: stored.addedAt,
      scannedAt: pairing.savedAt ?? stored.addedAt,
    };
    this.runtimes.set(channelId, {
      meta,
      status: 'connecting',
      timeline: emptyTimeline(),
      client: null,
      ephemeral: false,
    });
    if (!this.order.includes(channelId)) this.order.push(channelId);
    this.activeId = channelId;
    this.attach(channelId, client);
    return channelId;
  }

  async addDemo(): Promise<string> {
    let demo: DemoSession;
    try {
      demo = await startDemoSession();
    } catch (err) {
      throw err instanceof Error ? err : new Error('Failed to start demo.');
    }
    const channelId = demo.channelId;
    const meta: SessionMeta = {
      channelId,
      title: 'Demo session',
      cwd: 'C:\\Users\\akash\\helm',
      kind: 'demo',
      addedAt: Date.now(),
    };
    this.runtimes.set(channelId, {
      meta,
      status: 'connecting',
      timeline: emptyTimeline(),
      client: demo.client,
      ephemeral: true,
      stopDemo: demo.stop,
    });
    if (!this.order.includes(channelId)) this.order.push(channelId);
    this.activeId = channelId;
    this.attach(channelId, demo.client);
    return channelId;
  }

  // --- session controls ------------------------------------------------
  setActive(channelId: string): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    if (this.activeId === channelId) {
      if (runtime.unread) {
        runtime.unread = false;
        if (!runtime.ephemeral) void patchSession(channelId, { unread: false });
        this.emit();
      }
      return;
    }
    this.activeId = channelId;
    runtime.unread = false;
    // Opening a session makes it most-recently-used and warms it if it had been cooled down.
    this.touchWarm(channelId);
    this.ensureConnected(channelId);
    if (!runtime.ephemeral) void patchSession(channelId, { lastSeenAt: Date.now(), unread: false });
    this.emit();
  }

  async remove(channelId: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    runtime.unsubscribe?.();
    if (runtime.saveTimer != null) {
      window.clearTimeout(runtime.saveTimer);
      runtime.saveTimer = undefined;
    }
    if (runtime.metaTimer != null) {
      window.clearTimeout(runtime.metaTimer);
      runtime.metaTimer = undefined;
    }
    if (runtime.confirmTimer != null) {
      window.clearTimeout(runtime.confirmTimer);
      runtime.confirmTimer = undefined;
    }
    if (runtime.settleTimer != null) {
      window.clearTimeout(runtime.settleTimer);
      runtime.settleTimer = undefined;
    }
    if (runtime.eventSaveTimer != null) {
      window.clearTimeout(runtime.eventSaveTimer);
      runtime.eventSaveTimer = undefined;
    }
    try {
      await runtime.stopDemo?.();
      await runtime.client?.close();
    } catch {
      /* ignore */
    }
    if (!runtime.ephemeral) {
      await removeSession(channelId);
      await clearTranscript(channelId);
      await clearEventLog(channelId);
    }
    this.runtimes.delete(channelId);
    this.order = this.order.filter((id) => id !== channelId);
    this.warmLru = this.warmLru.filter((id) => id !== channelId);
    if (this.activeId === channelId) {
      this.activeId = this.order[0] ?? null;
      if (this.activeId) {
        const active = this.runtimes.get(this.activeId);
        if (active) active.unread = false;
        // The newly-focused session must be connected.
        this.ensureConnected(this.activeId);
      }
    }
    this.emit();
  }

  async reconnect(channelId: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    // A single reconnect at a time: foregrounding can fire visibilitychange AND appStateChange, and
    // the Reconnect button can overlap resume — without this they'd race two sockets onto one card.
    if (runtime.reconnecting) return;
    runtime.reconnecting = true;
    runtime.status = 'connecting';
    runtime.error = undefined;
    this.emit();
    try {
      const stored = (await loadSessions()).find((s) => s.pairing.channelId === channelId);
      if (!stored) {
        runtime.status = 'error';
        runtime.error = 'This session is no longer saved on this device.';
        this.emit();
        return;
      }
      const client = await connectSession(stored.pairing);
      this.attach(channelId, client);
    } catch (err) {
      runtime.status = 'error';
      runtime.error = err instanceof Error ? err.message : 'Failed to reconnect.';
      this.emit();
    } finally {
      runtime.reconnecting = false;
    }
  }

  async sendPrompt(channelId: string, text: string, attachments?: PromptAttachment[]): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    const appended = appendUser(runtime.timeline, text, Date.now(), attachments);
    runtime.timeline = appended.state;
    this.schedulePersist(channelId);
    // Sending keeps the session most-recently-active (recency for sort + warm-pool LRU).
    this.markActivity(channelId);
    this.emit();
    try {
      await this.deliverPrompt(channelId, text, attachments);
    } catch {
      const r = this.runtimes.get(channelId);
      if (!r) return;
      r.timeline = setUserFailed(r.timeline, appended.id, true);
      this.schedulePersist(channelId);
      this.emit();
    }
  }

  async retryPrompt(channelId: string, itemId: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    const item = runtime.timeline.items.find((i) => i.kind === 'user' && i.id === itemId);
    if (!item || item.kind !== 'user') return;
    runtime.timeline = setUserFailed(runtime.timeline, itemId, false);
    this.schedulePersist(channelId);
    this.emit();
    try {
      await this.deliverPrompt(channelId, item.text, item.attachments);
    } catch {
      const r = this.runtimes.get(channelId);
      if (!r) return;
      r.timeline = setUserFailed(r.timeline, itemId, true);
      this.schedulePersist(channelId);
      this.emit();
    }
  }

  private async deliverPrompt(channelId: string, text: string, attachments?: PromptAttachment[]): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime?.client) throw new Error('No active connection.');
    await this.dispatch(channelId, runtime.client, prompt(text, attachments));
  }

  /**
   * Scrollback: pull the next older page of history on demand (phase 2 "Load earlier").
   * No-op for demo sessions, while a page is already loading, or when nothing older remains.
   */
  async loadEarlierHistory(channelId: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    if (runtime.timeline.historyLoading || !runtime.timeline.historyHasMore) return;
    const cursor = runtime.timeline.historyCursor;
    runtime.timeline = markHistoryLoading(runtime.timeline, true);
    this.emit();
    try {
      if (!runtime.client) throw new Error('No active connection.');
      await this.dispatch(channelId, runtime.client, historyRequest(cursor, HISTORY_PAGE_DEFAULT));
    } catch {
      runtime.timeline = markHistoryLoading(runtime.timeline, false);
      this.emit();
    }
  }

  async sendApproval(channelId: string, requestId: string, optionId: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    const pending = runtime.timeline.approvals.find((a) => a.requestId === requestId);
    runtime.timeline = dismissApproval(runtime.timeline, requestId);
    this.emit();
    try {
      if (!runtime.client) throw new Error('No active connection.');
      await this.dispatch(channelId, runtime.client, approvalDecision(requestId, optionId));
    } catch (err) {
      // The decision never reached the laptop: restore the banner with a retry so the
      // user isn't left believing they answered while the agent stays blocked.
      if (pending) {
        runtime.timeline = restoreApproval(
          runtime.timeline,
          pending,
          err instanceof Error ? err.message : 'Could not send your decision — tap again to retry.',
        );
        this.emit();
      }
    }
  }

  /**
   * Answer an `ask_user` elicitation form. `action` is 'accept' (with `content`), 'decline', or
   * 'cancel'. Mirrors sendApproval: dismiss optimistically, restore with a retry if the send
   * fails so the user isn't left believing they answered while the agent stays blocked.
   */
  async sendElicitation(
    channelId: string,
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    const pending = runtime.timeline.elicitations.find((e) => e.requestId === requestId);
    runtime.timeline = dismissElicitation(runtime.timeline, requestId);
    this.emit();
    try {
      if (!runtime.client) throw new Error('No active connection.');
      await this.dispatch(channelId, runtime.client, elicitationResponse(requestId, action, content));
    } catch (err) {
      if (pending) {
        runtime.timeline = restoreElicitation(
          runtime.timeline,
          pending,
          err instanceof Error ? err.message : 'Could not send your answer — try again.',
        );
        this.emit();
      }
    }
  }

  /** Best-effort "stop generating": ask the extension to cancel the in-flight turn. */
  async sendInterrupt(channelId: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    try {
      if (runtime.client) await this.dispatch(channelId, runtime.client, interrupt());
    } catch {
      // A failed interrupt send must never crash the UI; the user can retry.
    }
  }

  async sendMode(channelId: string, mode: SessionMode): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    const prev = runtime.timeline.mode;
    runtime.timeline = { ...runtime.timeline, mode };
    this.emit();
    try {
      if (!runtime.client) throw new Error('No active connection.');
      await this.dispatch(channelId, runtime.client, modeChange(mode));
    } catch {
      runtime.timeline = appendNotice(
        { ...runtime.timeline, mode: prev },
        'warning',
        `Couldn't switch to ${mode} — still in ${prev}.`,
        Date.now(),
      );
      this.schedulePersist(channelId);
      this.emit();
    }
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const runtime of this.runtimes.values()) {
        if (runtime.ephemeral) continue;
        // A connect that never completes (e.g. the laptop's session was killed and its channel never
        // finishes joining) would otherwise sit on 'connecting' forever: the confirm deadline is armed
        // only AFTER connectSession resolves. Stamp when connecting began and fail it past the liveness
        // window. Placed ABOVE the cold-session skip below, since a hung connect has no client yet.
        if (runtime.status === 'connecting') {
          if (runtime.connectingSince == null) {
            runtime.connectingSince = now;
          } else if (now - runtime.connectingSince > HOST_CONFIRM_MS) {
            runtime.status = 'error';
            runtime.error = 'Couldn’t reach your session — the terminal may be closed. Tap Reconnect to try again.';
            if (runtime.timeline.busy) runtime.timeline = { ...runtime.timeline, busy: false };
            runtime.connectingSince = undefined;
            // If a hung connect left the in-flight guard set, clear it so Reconnect isn't a no-op.
            // (connectSession is now timeout-bounded, so this is belt-and-suspenders.)
            runtime.reconnecting = false;
            this.clearSettle(runtime);
            changed = true;
          }
          continue;
        }
        runtime.connectingSince = undefined;
        if (runtime.status !== 'live' && runtime.status !== 'idle') continue;
        // Cold (evicted) sessions hold no live client and get no heartbeats — the watchdog must not
        // demote them to Offline; they reconnect when opened.
        if (!runtime.client) continue;
        const beat = runtime.timeline.lastHeartbeat;
        if (beat && now - beat > OFFLINE_AFTER_MS) {
          runtime.status = 'error';
          runtime.error = 'Connection lost — reconnect to resume.';
          // A dead link can't be actively working; drop a stuck Stop control. Real busy is
          // re-derived from the state snapshot / live events once we reconnect.
          if (runtime.timeline.busy) runtime.timeline = { ...runtime.timeline, busy: false };
          changed = true;
        } else if (runtime.status === 'live' && beat && now - beat > IDLE_AFTER_MS) {
          runtime.status = 'idle';
          // The extension heartbeats on a timer independent of agent work, so a beat this stale
          // means the transport — not a long turn — went quiet; unstick a lingering "Working…".
          if (runtime.timeline.busy) runtime.timeline = { ...runtime.timeline, busy: false };
          changed = true;
        }
      }
      if (changed) this.emit();
    }, 1_000);
  }

  /**
   * Revive connections when the app returns to the foreground or the network comes back. A
   * backgrounded mobile webview usually has its realtime socket silently dropped, so on resume we
   * reconnect every dead/stale WARM session and refresh the live state of the healthy ones — the
   * phone should never come back to a session frozen on stale data. Cold (evicted) sessions are left
   * alone; they reconnect when opened, so resume stays cheap regardless of how many sessions exist.
   */
  private handleResume = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    // Snapshot: reconnect() → attach() → touchWarm() mutates warmLru while we iterate.
    for (const channelId of [...this.warmLru]) {
      const runtime = this.runtimes.get(channelId);
      if (!runtime || runtime.ephemeral) continue;
      const beat = runtime.timeline.lastHeartbeat;
      const stale = beat != null && now - beat > IDLE_AFTER_MS;
      const revive = !runtime.client || runtime.status === 'error' || stale;
      if (revive && runtime.status !== 'ended') {
        void this.reconnect(channelId);
      } else {
        // Healthy link: refresh the authoritative state and catch up on any turns that slipped in
        // while backgrounded. syncHistory reads the pre-resume cursor, so a current session just gets
        // an empty forward page (no-op); it only backfills when something was actually missed.
        this.requestState(channelId);
        if (runtime.client) this.syncHistory(channelId, runtime.client);
      }
    }
  };

  /** Wire foreground/online events so a returning user's sessions re-sync automatically. */
  private installResumeTriggers(): void {
    if (typeof window === 'undefined') return;
    window.addEventListener('online', this.handleResume);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this.handleResume);
    }
    // Native (Android/iOS) foregrounding doesn't reliably emit visibilitychange in the webview, so
    // also listen to Capacitor's App state. On the web the plugin maps this onto visibility, and
    // handleResume is idempotent, so a duplicate trigger is harmless. Guarded so a missing native
    // bridge can never break startup.
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) this.handleResume();
    }).catch(() => {
      // No Capacitor App bridge here — the visibility/online triggers already cover the web path.
    });
  }
}

export const sessionManager = new SessionManager();

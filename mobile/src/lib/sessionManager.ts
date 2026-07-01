import { KIND, approvalDecision, elicitationResponse, historyRequest, interrupt, modeChange, prompt, stateRequest, HISTORY_PAGE_DEFAULT } from '@aasis21/helm-shared';
import type { ChannelUp, History as HistoryMessage, InnerMessage, PromptAttachment, SessionMode } from '@aasis21/helm-shared';
import { connectSession, pairSession } from './helmClient';
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
import { startDemoSession } from './demoSimulator';
import type { DemoSession } from './demoSimulator';
import {
  ensureNotificationPermission,
  notifyApprovalRequest,
  notifyElicitationRequest,
  notifySessionEnded,
} from './notifications';

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
}

/** Immutable, React-facing view of one joined session. */
export interface SessionView {
  meta: SessionMeta;
  status: SessionStatus;
  timeline: TimelineState;
  unread?: boolean;
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
  /** Forward catch-up pages fetched since the last (re)connect — bounds a huge gap (see D5). */
  catchupPages?: number;
  unread?: boolean;
  error?: string;
  unsubscribe?: () => void;
  stopDemo?: () => Promise<void>;
  saveTimer?: number;
}

// A healthy session heartbeats on a fixed interval (the extension beats every 15s —
// see DEFAULT_HEARTBEAT_MS in extension/src/relay.mjs). Only flag a session "Quiet"
// once a beat has been missed with slack, so a live session never flickers Live->Quiet.
const IDLE_AFTER_MS = 20_000;
const OFFLINE_AFTER_MS = 45_000;
// Coalesce transcript writes so a burst of stream deltas doesn't hammer storage.
const PERSIST_THROTTLE_MS = 800;
// Cap the forward catch-up after a long absence so one reconnect can't flood the transcript with a
// huge gap in a single burst; the older middle stays reachable via "Load earlier" scrollback.
const MAX_CATCHUP_PAGES = 4;

function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function titleFor(channelId: string, cwd: string | null, stored: string | null): string {
  return stored || basename(cwd) || `Session ${channelId.slice(0, 6)}`;
}

function isUnreadActivity(message: InnerMessage): boolean {
  switch (message.kind) {
    case KIND.ASSISTANT_MESSAGE:
    case KIND.ASSISTANT_DELTA:
    case KIND.TOOL_START:
    case KIND.TOOL_COMPLETE:
    case KIND.LOG:
    case KIND.ACTIVITY:
    case KIND.APPROVAL_REQUEST:
    case KIND.ELICITATION_REQUEST:
    case KIND.CHANNEL_DOWN:
      return true;
    default:
      return false;
  }
}

class SessionManager {
  private runtimes = new Map<string, Runtime>();
  private order: string[] = [];
  private activeId: string | null = null;
  private ready = false;
  private listeners = new Set<() => void>();
  private snapshot: ManagerSnapshot = { ready: false, activeId: null, sessions: [] };
  private initStarted = false;
  private watchdog: number | null = null;

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
      })),
    );
    const persistedById = new Map(restored.map((r) => [r.channelId, r.persisted]));
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
      };
      this.runtimes.set(channelId, {
        meta,
        status: 'connecting',
        timeline,
        client: null,
        ephemeral: false,
      });
      if (!this.order.includes(channelId)) this.order.push(channelId);
    }
    if (!this.activeId && this.order.length > 0) this.activeId = this.order[0];
    this.ready = true;
    this.emit();

    // Connect each stored session concurrently.
    await Promise.all(
      stored.map(async (s) => {
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
    runtime.unsubscribe?.();
    runtime.client = client;
    runtime.status = 'live';
    runtime.error = undefined;
    const stopEvents = client.subscribe((message) => this.onMessage(channelId, message));
    const stopStatus = client.onStatus((status) =>
      this.handleTransportStatus(channelId, client, status),
    );
    runtime.unsubscribe = () => {
      stopEvents();
      stopStatus();
    };
    this.emit();
    // Ask for the current session state (busy/mode + any pending prompts) so a fresh, mid-turn,
    // or reconnecting join reflects the truth immediately instead of waiting for the next event.
    this.requestState(channelId);
    // One self-healing history sync for every path (first join, reconnect, rescan, resume): pull the
    // latest page when the thread is empty, otherwise catch up on the turns missed while away.
    this.syncHistory(channelId, client);
  }

  /**
   * React to live socket-state changes the transport reports (distinct from the heartbeat
   * watchdog). A silent drop flips the session to Offline immediately — issue #44, where a
   * dropped WebSocket otherwise lingered as "Quiet" for up to 45s — and a rejoin restores Live
   * and re-pulls the authoritative state. `client` is captured so a late event from a superseded
   * connection is ignored.
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
    // 'connected' only matters as a RECOVERY here — attach() already handles the first connect,
    // so acting on it while live would fire a redundant state request on every join.
    if (runtime.status === 'error' || runtime.status === 'connecting') {
      runtime.status = 'live';
      runtime.error = undefined;
      this.emit();
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
    void runtime.client.send(stateRequest()).catch(() => {
      // A failed state request must never break the connection; live events still flow.
    });
  }

  /**
   * One self-healing history sync, shared by every connect path (first join, reconnect, rescan,
   * refresh, resume). It is driven by what the transcript already CONTAINS, not by a one-shot flag,
   * so a failed pull simply heals on the next connect instead of leaving a permanent hole:
   *
   *   - empty thread            → pull the latest page (initial backfill of pre-join turns)
   *   - has turns + a cursor    → forward catch-up of everything committed while we were away
   *   - has turns, but no cursor → nothing to do; the state snapshot + live events cover it
   *
   * The forward page is appended to the transcript tail behind a "N new while you were away" divider
   * by the reducer, so a phone that went offline/backgrounded/hard-refreshed returns with no gap.
   */
  private syncHistory(channelId: string, client: HelmClient): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    const timeline = runtime.timeline;
    const hasContent = timeline.history.length > 0 || timeline.items.length > 0;
    if (!hasContent) {
      runtime.timeline = markHistoryLoading(runtime.timeline, true);
      this.emit();
      void client.send(historyRequest(null, HISTORY_PAGE_DEFAULT)).catch(() => {
        const r = this.runtimes.get(channelId);
        if (r) {
          r.timeline = markHistoryLoading(r.timeline, false);
          this.emit();
        }
      });
      return;
    }
    const since = timeline.latestTurnIndex;
    if (since == null) return;
    runtime.catchupPages = 0;
    void client.send(historyRequest(null, HISTORY_PAGE_DEFAULT, since)).catch(() => {
      // A failed catch-up must never break the connection; forward live events still flow.
    });
  }

  /**
   * Continue a bounded forward catch-up: if a catch-up page reports more missed turns, pull the next
   * one (up to MAX_CATCHUP_PAGES) so a moderate absence fills in completely and in order. A very
   * large gap stops at the cap with a notice, leaving the older middle to "Load earlier" scrollback,
   * so one reconnect can't flood the transcript in a single burst.
   */
  private maybeContinueCatchup(channelId: string, page: HistoryMessage): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral || !runtime.client) return;
    if (!page.hasMore || page.nextCursor == null) return;
    const loaded = (runtime.catchupPages ?? 0) + 1;
    runtime.catchupPages = loaded;
    if (loaded >= MAX_CATCHUP_PAGES) {
      runtime.timeline = appendNotice(
        runtime.timeline,
        'info',
        'A lot happened while you were away — scroll up to load the rest.',
        Date.now(),
      );
      this.schedulePersist(channelId);
      this.emit();
      return;
    }
    void runtime.client
      .send(historyRequest(null, HISTORY_PAGE_DEFAULT, page.nextCursor))
      .catch(() => {
        // Best-effort: a dropped continuation just leaves the remaining gap to manual scrollback.
      });
  }

  private onMessage(channelId: string, message: InnerMessage): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    runtime.timeline = reduceTimeline(runtime.timeline, message);
    if (isUnreadActivity(message)) {
      runtime.unread = channelId !== this.activeId;
    }

    // A forward catch-up page may report more missed turns — page through the gap (bounded).
    if (message.kind === KIND.HISTORY && (message as HistoryMessage).since != null) {
      this.maybeContinueCatchup(channelId, message as HistoryMessage);
    }

    if (message.kind === KIND.CHANNEL_DOWN) {
      runtime.status = 'ended';
      void notifySessionEnded(runtime.timeline.endedReason);
    } else {
      if (runtime.status !== 'live') runtime.status = 'live';
      if (runtime.error) runtime.error = undefined;
    }

    // A channel announces which Copilot session it serves. Key the card by that durable sessionId so
    // a `copilot --resume` (which rotates the channelId) collapses onto the same card instead of
    // forking a new one.
    if (message.kind === KIND.CHANNEL_UP) {
      const sid = (message as ChannelUp).sessionId;
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

    if (message.kind === KIND.APPROVAL_REQUEST) {
      void notifyApprovalRequest(message);
    }
    if (message.kind === KIND.ELICITATION_REQUEST) {
      void notifyElicitationRequest(message);
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
      this.runtimes.delete(staleId);
      this.order = this.order.filter((id) => id !== staleId);
      if (this.activeId === staleId) this.activeId = keepId;
      void removeSession(staleId);
      void clearTranscript(staleId);
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
        this.emit();
      }
      return;
    }
    this.activeId = channelId;
    runtime.unread = false;
    if (!runtime.ephemeral) void patchSession(channelId, { lastSeenAt: Date.now() });
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
    try {
      await runtime.stopDemo?.();
      await runtime.client?.close();
    } catch {
      /* ignore */
    }
    if (!runtime.ephemeral) {
      await removeSession(channelId);
      await clearTranscript(channelId);
    }
    this.runtimes.delete(channelId);
    this.order = this.order.filter((id) => id !== channelId);
    if (this.activeId === channelId) {
      this.activeId = this.order[0] ?? null;
      if (this.activeId) {
        const active = this.runtimes.get(this.activeId);
        if (active) active.unread = false;
      }
    }
    this.emit();
  }

  async reconnect(channelId: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    const stored = (await loadSessions()).find((s) => s.pairing.channelId === channelId);
    if (!stored) return;
    runtime.status = 'connecting';
    runtime.error = undefined;
    this.emit();
    try {
      const client = await connectSession(stored.pairing);
      this.attach(channelId, client);
    } catch (err) {
      runtime.status = 'error';
      runtime.error = err instanceof Error ? err.message : 'Failed to reconnect.';
      this.emit();
    }
  }

  async sendPrompt(channelId: string, text: string, attachments?: PromptAttachment[]): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    const appended = appendUser(runtime.timeline, text, Date.now(), attachments);
    runtime.timeline = appended.state;
    this.schedulePersist(channelId);
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
    await runtime.client.send(prompt(text, attachments));
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
      await runtime.client?.send(historyRequest(cursor, HISTORY_PAGE_DEFAULT));
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
      await runtime.client?.send(approvalDecision(requestId, optionId));
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
      await runtime.client?.send(elicitationResponse(requestId, action, content));
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
      await runtime.client?.send(interrupt());
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
      await runtime.client.send(modeChange(mode));
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
        if (runtime.ephemeral || (runtime.status !== 'live' && runtime.status !== 'idle')) continue;
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
   * reconnect every dead/stale session and refresh the live state of the healthy ones — the phone
   * should never come back to a session frozen on stale data. Covers ALL sessions, not just the
   * active one, so background sessions are current the moment you switch to them.
   */
  private handleResume = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    const now = Date.now();
    for (const [channelId, runtime] of this.runtimes) {
      if (runtime.ephemeral) continue;
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
  }
}

export const sessionManager = new SessionManager();

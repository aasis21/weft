import { KIND, approvalDecision, historyRequest, modeChange, prompt, HISTORY_PAGE_DEFAULT } from '@aasis21/helm-shared';
import type { InnerMessage, SessionMode } from '@aasis21/helm-shared';
import { connectSession, pairSession } from './helmClient';
import type { HelmClient } from './helmClient';
import {
  appendUser,
  dismissApproval,
  emptyTimeline,
  markHistoryLoading,
  reduceTimeline,
  restoreTimeline,
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
  notifySessionEnded,
} from './notifications';

export type SessionStatus = 'connecting' | 'live' | 'idle' | 'ended' | 'error';

export interface SessionMeta {
  channelId: string;
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
  /** True until the one-time pre-join history backfill has been requested. */
  firstJoin: boolean;
  error?: string;
  unsubscribe?: () => void;
  stopDemo?: () => Promise<void>;
  saveTimer?: number;
}

// A healthy session heartbeats on a fixed interval (the extension beats every 15s —
// see DEFAULT_HEARTBEAT_MS in extension/src/relay.mjs). Only flag a session "Quiet"
// once a beat has been missed with slack, so a live session never flickers Live->Quiet.
const IDLE_AFTER_MS = 20_000;
// Coalesce transcript writes so a burst of stream deltas doesn't hammer storage.
const PERSIST_THROTTLE_MS = 800;

function basename(path: string | null): string | null {
  if (!path) return null;
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

function titleFor(channelId: string, cwd: string | null, stored: string | null): string {
  return stored || basename(cwd) || `Session ${channelId.slice(0, 6)}`;
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
        .map((r) => ({ meta: { ...r.meta }, status: r.status, timeline: r.timeline })),
    };
    for (const listener of this.listeners) listener();
  }

  // --- lifecycle -------------------------------------------------------
  async init(): Promise<void> {
    if (this.initStarted) return;
    this.initStarted = true;
    void ensureNotificationPermission();
    this.startWatchdog();
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
        // No persisted transcript yet => never connected on this device => pull pre-join history.
        firstJoin: persisted == null,
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
    runtime.unsubscribe = client.subscribe((message) => this.onMessage(channelId, message));
    this.emit();
    this.maybeRequestFirstHistory(channelId, client);
  }

  /**
   * One-time backfill: the first time the phone ever connects to a session (no local
   * transcript existed), pull the most recent page of pre-join turns. Refreshes and
   * reconnects rely on the restored local transcript instead and never pull.
   */
  private maybeRequestFirstHistory(channelId: string, client: HelmClient): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral || !runtime.firstJoin) return;
    runtime.firstJoin = false;
    runtime.timeline = markHistoryLoading(runtime.timeline, true);
    this.emit();
    void client.send(historyRequest(null, HISTORY_PAGE_DEFAULT)).catch(() => {
      const r = this.runtimes.get(channelId);
      if (r) {
        r.timeline = markHistoryLoading(r.timeline, false);
        this.emit();
      }
    });
  }

  private onMessage(channelId: string, message: InnerMessage): void {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    runtime.timeline = reduceTimeline(runtime.timeline, message);

    if (message.kind === KIND.SESSION_END) {
      runtime.status = 'ended';
      void notifySessionEnded(runtime.timeline.endedReason);
    } else {
      if (runtime.status !== 'live') runtime.status = 'live';
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

  // --- adding sessions -------------------------------------------------
  async addByQr(raw: string): Promise<string> {
    const { client, pairing } = await pairSession(raw);
    const channelId = pairing.channelId;
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
      firstJoin: true,
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
      firstJoin: false,
      stopDemo: demo.stop,
    });
    if (!this.order.includes(channelId)) this.order.push(channelId);
    this.activeId = channelId;
    this.attach(channelId, demo.client);
    return channelId;
  }

  // --- session controls ------------------------------------------------
  setActive(channelId: string): void {
    if (!this.runtimes.has(channelId) || this.activeId === channelId) return;
    this.activeId = channelId;
    if (!this.runtimes.get(channelId)?.ephemeral) void patchSession(channelId, { lastSeenAt: Date.now() });
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
    if (this.activeId === channelId) this.activeId = this.order[0] ?? null;
    this.emit();
  }

  async reconnect(channelId: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime || runtime.ephemeral) return;
    const stored = (await loadSessions()).find((s) => s.pairing.channelId === channelId);
    if (!stored) return;
    runtime.status = 'connecting';
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

  async sendPrompt(channelId: string, text: string): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    runtime.timeline = appendUser(runtime.timeline, text, Date.now());
    this.schedulePersist(channelId);
    this.emit();
    await runtime.client?.send(prompt(text));
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
    runtime.timeline = dismissApproval(runtime.timeline, requestId);
    this.emit();
    await runtime.client?.send(approvalDecision(requestId, optionId));
  }

  async sendMode(channelId: string, mode: SessionMode): Promise<void> {
    const runtime = this.runtimes.get(channelId);
    if (!runtime) return;
    runtime.timeline = { ...runtime.timeline, mode };
    this.emit();
    await runtime.client?.send(modeChange(mode));
  }

  private startWatchdog(): void {
    if (this.watchdog !== null) return;
    this.watchdog = window.setInterval(() => {
      let changed = false;
      const now = Date.now();
      for (const runtime of this.runtimes.values()) {
        if (runtime.status !== 'live') continue;
        const beat = runtime.timeline.lastHeartbeat;
        if (beat && now - beat > IDLE_AFTER_MS) {
          runtime.status = 'idle';
          changed = true;
        }
      }
      if (changed) this.emit();
    }, 1_000);
  }
}

export const sessionManager = new SessionManager();

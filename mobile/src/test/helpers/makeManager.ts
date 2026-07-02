// makeManager — the L2 scenario harness.
//
// Spins up a FRESH `SessionManager` (never the shared singleton, so tests don't bleed into each
// other) wired to the FakeHelmClient transport. It records every emitted snapshot and gives terse
// accessors so a scenario reads like a story:
//
//   const h = makeManager();
//   const { channelId, client } = await h.pair('c1');
//   client.emit(B.channelUp('c1', 's1', '/repo', 'Refactor auth'));
//   await h.flush();
//   expect(h.active()?.meta.title).toBe('Refactor auth');
//   expect(client.sentOfKind('control.state_request')).toHaveLength(1);
import { createSessionRuntime, type SessionRuntime } from '@/session/runtime/sessionRuntime';
import type { ManagerSnapshot, SessionView } from '@/lib/sessionManager';
import { registry } from './fakeHelmClient';
import type { FakeHelmClient } from './fakeHelmClient';

export interface ManagerHarness {
  manager: SessionRuntime;
  /** Every snapshot the manager has emitted, in order. */
  snapshots: ManagerSnapshot[];
  /** The current snapshot. */
  snapshot(): ManagerSnapshot;
  /** All session views in sidebar order. */
  sessions(): SessionView[];
  /** The active session view, if any. */
  active(): SessionView | undefined;
  /** A session view by channelId. */
  byChannel(channelId: string): SessionView | undefined;
  /** Restore stored sessions from Preferences (call after seeding, for restart scenarios). */
  init(): Promise<void>;
  /**
   * Join a session via QR. Returns its channelId and the FakeHelmClient the manager bound, so the
   * test can `client.emit(...)` inbound and read `client.sent`. The QR string is used verbatim as the
   * channelId (real code parses a pairing payload).
   */
  pair(arg?: string | { channelId?: string; qr?: string }): Promise<PairResult>;
  /** The freshest FakeHelmClient bound to a channel (a rescan/reconnect makes a new one). */
  client(channelId: string): FakeHelmClient;
  /** Settle the microtasks that attach()/persist scheduling kick off. */
  flush(): Promise<void>;
  /** Stop listening. */
  dispose(): void;
}

export interface PairResult {
  channelId: string;
  client: FakeHelmClient;
}

let channelCounter = 0;

export function makeManager(): ManagerHarness {
  const manager = createSessionRuntime();
  const snapshots: ManagerSnapshot[] = [];
  const unsub = manager.subscribe(() => snapshots.push(manager.getSnapshot()));

  const flush = async (): Promise<void> => {
    // attach() fires requestState()/syncHistory() and onMessage() schedules a throttled persist;
    // a couple of microtask turns let those settle before assertions. Timer-based work (the 800ms
    // persist, the watchdog) is advanced explicitly by the test with vi.advanceTimersByTime*.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  const client = (channelId: string): FakeHelmClient => {
    const c = registry.get(channelId);
    if (!c) throw new Error(`makeManager: no FakeHelmClient bound for channel "${channelId}"`);
    return c;
  };

  return {
    manager,
    snapshots,
    snapshot: () => manager.getSnapshot(),
    sessions: () => manager.getSnapshot().sessions,
    active: () => {
      const snap = manager.getSnapshot();
      return snap.sessions.find((s) => s.meta.channelId === snap.activeId);
    },
    byChannel: (channelId: string) =>
      manager.getSnapshot().sessions.find((s) => s.meta.channelId === channelId),
    init: () => manager.init(),
    async pair(arg): Promise<PairResult> {
      const channelId =
        typeof arg === 'string' ? arg : (arg?.channelId ?? `chan-${(channelCounter += 1)}`);
      const qr = typeof arg === 'object' && arg?.qr ? arg.qr : channelId;
      await manager.addByQr(qr);
      await flush();
      return { channelId, client: client(channelId) };
    },
    client,
    flush,
    dispose: () => {
      unsub();
      manager.dispose();
    },
  };
}

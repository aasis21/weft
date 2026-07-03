import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: reconnect + resume', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  // #91 — transport auto-recovery must also pull recent history, not just re-confirm the host.
  it('re-issues a recent-turns sync when the same socket auto-recovers from a drop', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    client.emit(B.heartbeat(2, false));
    client.emit(B.assistantDelta('live tail', 'm1'));
    await h!.flush();

    client.setStatus('disconnected');
    await h!.flush();
    expect(h!.active()?.status).toBe('error');

    client.clearSent();
    client.setStatus('connected'); // auto-recovery on the SAME client
    await h!.flush();

    expect(client.sentOfKind('control.state_request')).toHaveLength(1);
    expect(client.sentOfKind('control.recent_turns_request')).toHaveLength(1);
    expect(client.sentOfKind('control.recent_turns_request')[0].limit).toBe(50);
  });

  // #75 — overlapping foreground triggers (online + visibility + appState) must coalesce.
  it('coalesces two back-to-back resume triggers into a single state sync', async () => {
    await h!.init();
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    client.emit(B.heartbeat(2, false));
    await h!.flush();
    expect(h!.active()?.status).toBe('live');

    client.clearSent();
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new Event('online'));
    await h!.flush();

    // Without the leading-edge debounce this warm, healthy session would emit two state requests.
    expect(client.sentOfKind('control.state_request')).toHaveLength(1);
  });

  // #125 — a session still inside its confirmation window must not be torn down by a resume.
  it('does not reconnect a session that is already connecting when a resume fires', async () => {
    await h!.init();
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    client.emit(B.heartbeat(2, false));
    await h!.flush();

    // Let the heartbeat go stale so the watchdog quiets it, then start a fresh reconnect that parks
    // the session in `connecting` with the still-stale heartbeat — the exact #125 precondition.
    await vi.advanceTimersByTimeAsync(21_000);
    expect(h!.active()?.status).toBe('idle');

    await h!.manager.reconnect('c1');
    await h!.flush();
    expect(h!.active()?.status).toBe('connecting');
    const fresh = h!.client('c1');

    window.dispatchEvent(new Event('online'));
    await h!.flush();

    // The guard skips the connecting session, so the fresh client is NOT closed and replaced.
    expect(h!.client('c1')).toBe(fresh);
    expect(h!.active()?.status).toBe('connecting');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { registry } from '@/test/helpers/fakeWeftClient';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: heartbeat watchdog', () => {
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

  it('re-handshakes when host replacement leaves the relay socket open but heartbeats stop', async () => {
    await h!.init();
    const { client } = await h!.pair('c1');

    client.emit(B.heartbeat(3, true));
    await h!.flush();
    expect(h!.active()).toMatchObject({ status: 'live' });
    expect(h!.active()!.timeline.busy).toBe(true);
    expect(h!.active()!.timeline.latestTurnIndex).toBe(3);

    await vi.advanceTimersByTimeAsync(21_000);
    expect(h!.active()).toMatchObject({ status: 'idle' });
    expect(h!.active()!.timeline.busy).toBe(false);

    await vi.advanceTimersByTimeAsync(10_000);
    await h!.flush();
    const clients = registry.forChannel('c1');
    expect(clients).toHaveLength(2);
    const replacement = clients[1]!;
    expect(replacement).not.toBe(client);
    expect(h!.active()).toMatchObject({ status: 'connecting' });

    replacement.emit(B.heartbeat(4, true));
    await h!.flush();
    expect(h!.active()).toMatchObject({ status: 'live' });
    expect(h!.active()!.timeline.busy).toBe(true);
    expect(h!.active()!.timeline.latestTurnIndex).toBe(4);

    replacement.emit(B.heartbeat(5, null));
    await h!.flush();
    expect(h!.active()!.timeline.busy).toBe(true);
    expect(h!.active()!.timeline.latestTurnIndex).toBe(5);
  });
});


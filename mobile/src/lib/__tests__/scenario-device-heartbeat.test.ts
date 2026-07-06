import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';
import { registry } from '@/test/helpers/fakeWeftClient';
import * as B from '@/test/helpers/builders';

function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'local' },
  });
}

describe('scenario: device (listener) heartbeat watchdog', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    vi.useFakeTimers();
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('stays online on repeated DEVICE_HEARTBEATs, then flips offline once the beat goes stale', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();
    const listener = registry.get('listener-1')!;

    listener.emit(B.projectList([{ name: 'weft', path: '/repo', isDefault: true }], 'Akash Laptop'));
    await h!.flush();
    expect(h!.snapshot().devices[0]).toMatchObject({ channelId: 'listener-1', connected: true });

    // Advance well past a session's OFFLINE_AFTER_MS (30s) but keep beating every 2min, as the real
    // listener does — the device should stay online the whole time.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(120_000);
      listener.emit(B.deviceHeartbeat('device-1'));
      await h!.flush();
      expect(h!.snapshot().devices[0]).toMatchObject({ connected: true });
    }

    // Now the beats stop entirely (process hung/killed) — the watchdog should flip it offline once
    // lastSeenAt exceeds DEVICE_OFFLINE_AFTER_MS (3min = 2min heartbeat + 50%), even though nothing
    // told the transport itself to disconnect.
    await vi.advanceTimersByTimeAsync(181_000);
    expect(h!.snapshot().devices[0]).toMatchObject({ connected: false });
  });
});

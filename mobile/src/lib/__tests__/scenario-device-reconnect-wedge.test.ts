import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { registry } from '@/test/helpers/fakeWeftClient';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

// A devtunnel/relay listener QR — the transport that does NOT self-heal a dropped socket (unlike
// supabase), so the phone-side runtime is solely responsible for re-establishing it.
function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'devtunnel', url: 'wss://relay.example.ms' },
  });
}

describe('scenario: device reconnect wedge (devtunnel socket drop)', () => {
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

  it('self-heals a device whose socket died but whose stale client was still attached', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();

    const first = registry.get('listener-1')!;
    first.emit(B.projectList([{ name: 'weft', path: '/repo', isDefault: true }], 'Devbox'));
    await h!.flush();
    expect(h!.snapshot().devices[0]).toMatchObject({ channelId: 'listener-1', connected: true });
    expect(registry.forChannel('listener-1')).toHaveLength(1);

    // The devtunnel socket drops (phone backgrounded / tunnel idle-drop while the laptop restarted).
    // createRelayTransport just emits 'disconnected' and leaves the dead client attached — it never
    // re-opens. The device flips Offline but ctrl.client is still the (now dead) `first` client.
    first.setStatus('disconnected');
    await h!.flush();
    expect(h!.snapshot().devices[0].connected).toBe(false);

    // Before the fix, connectDevice bailed on `if (ctrl.client) return`, so the watchdog/resume could
    // never replace the dead client and the device wedged in "reconnecting" forever. Now the watchdog
    // drives a fresh reconnect on a backoff — a SECOND client is created and the device revives.
    await vi.advanceTimersByTimeAsync(1_100);
    await h!.flush();

    const clients = registry.forChannel('listener-1');
    expect(clients).toHaveLength(2);
    expect(clients[1]).not.toBe(first);
    expect(h!.snapshot().devices[0].connected).toBe(true);

    // The revived client can actually talk to the station again (refreshProjects on attach).
    const second = clients[1]!;
    expect(second.sentOfKind('control.project_list_request').length).toBeGreaterThan(0);
  });
});

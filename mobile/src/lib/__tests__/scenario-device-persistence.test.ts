import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { loadEventLog } from '@/lib/eventLog';
import { registry } from '@/test/helpers/fakeWeftClient';
import { makeManager } from '@/test/helpers/makeManager';
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

describe('scenario: device persistence + auto-reconnect (#186 follow-up)', () => {
  let h: ReturnType<typeof makeManager> | undefined;
  let h2: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    vi.useFakeTimers();
    h = makeManager();
  });

  afterEach(() => {
    h2?.dispose();
    h?.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('persists the device event log to disk (throttled), surviving a restart', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();
    const listener = registry.get('listener-1')!;

    listener.emit(B.projectList([{ name: 'weft', path: '/repo', isDefault: true }], 'Akash Laptop'));
    await h!.flush();
    await vi.advanceTimersByTimeAsync(2_000);
    await h!.flush();

    const stored = await loadEventLog('listener-1');
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.some((e) => e.eventType === 'control' && e.eventSubtype === 'project_list')).toBe(true);

    h2 = makeManager();
    await h2.init();
    await h2.flush();
    expect(h2.snapshot().devices[0]).toMatchObject({ channelId: 'listener-1' });
    // init()'s auto-reconnect issues its own fresh refreshProjects (one more 'out' event), so the
    // restored log is a strict prefix/subset, not an exact match — what matters is the ORIGINAL
    // persisted inbound project_list survived the restart.
    expect(h2.snapshot().devices[0].events.length).toBeGreaterThanOrEqual(stored.length);
    expect(
      h2.snapshot().devices[0].events.some((e) => e.eventType === 'control' && e.eventSubtype === 'project_list'),
    ).toBe(true);
  });

  it('auto-reconnects every persisted device on boot', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.manager.addByQr(listenerQr('listener-2'));
    await h!.flush();

    h2 = makeManager();
    await h2.init();
    await h2.flush();

    expect(registry.get('listener-1')).toBeTruthy();
    expect(registry.get('listener-2')).toBeTruthy();
    expect(h2.snapshot().devices.every((d) => d.connected)).toBe(true);
  });
});

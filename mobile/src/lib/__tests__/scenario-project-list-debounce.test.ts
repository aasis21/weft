import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { registry } from '@/test/helpers/fakeWeftClient';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'devtunnel', url: 'wss://relay.example.ms' },
  });
}

const REQ = 'control.project_list_request';

// A single reconnect fans out to several refreshProjects triggers (boot auto-reconnect + watchdog
// self-heal + attachListener's trailing refresh + a manual pull). connectDevice short-circuits once
// the device is healthy, so each trigger would send a duplicate project_list_request on the same
// client (5 in ~1min observed). An in-flight guard collapses them into one until the reply lands.
describe('scenario: project_list_request debounce', () => {
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

  it('collapses overlapping refreshProjects into one in-flight request, then re-arms after the reply', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();

    const client = registry.get('listener-1')!;
    // attachListener sent exactly one request; the device is optimistically connected.
    expect(client.sentOfKind(REQ)).toHaveLength(1);
    expect(h!.snapshot().devices[0].connected).toBe(true);

    // Three more triggers arrive before the station replies — all collapse into the one in-flight
    // request (connectDevice short-circuits on the healthy client, the guard blocks the send).
    await h!.manager.refreshProjects('listener-1');
    await h!.manager.refreshProjects('listener-1');
    await h!.manager.refreshProjects('listener-1');
    await h!.flush();
    expect(client.sentOfKind(REQ)).toHaveLength(1);

    // The reply clears the in-flight marker, so a later refresh is allowed to send again.
    client.emit(B.projectList([{ name: 'weft', path: '/repo', isDefault: true }], 'Devbox'));
    await h!.flush();
    await h!.manager.refreshProjects('listener-1');
    await h!.flush();
    expect(client.sentOfKind(REQ)).toHaveLength(2);
  });

  it('auto-clears the in-flight marker after the fail-safe window so a dropped reply cannot wedge refreshes', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();

    const client = registry.get('listener-1')!;
    expect(client.sentOfKind(REQ)).toHaveLength(1);

    // No reply ever comes. A refresh right away is suppressed…
    await h!.manager.refreshProjects('listener-1');
    await h!.flush();
    expect(client.sentOfKind(REQ)).toHaveLength(1);

    // …but once the fail-safe window (8s) elapses the marker clears and refresh works again.
    await vi.advanceTimersByTimeAsync(8_500);
    await h!.manager.refreshProjects('listener-1');
    await h!.flush();
    expect(client.sentOfKind(REQ)).toHaveLength(2);
  });
});

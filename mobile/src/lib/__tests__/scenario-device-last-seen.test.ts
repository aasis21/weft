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

// "Last seen" must reflect the last time the phone RECEIVED a message FROM the laptop — never a
// phone-side action (transport socket open, optimistic attach, outbound send). See sessionsSlice
// deviceSeen / deviceErrorSet and sessionRuntime.onListenerMessage.
describe('scenario: device (listener) last-seen only advances on inbound', () => {
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

  it('does not stamp lastSeenAt on optimistic attach or transport-open, only on a real inbound message', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();
    const listener = registry.get('listener-1')!;

    // Just attached: the phone optimistically opened the channel, but the laptop has said nothing.
    // lastSeenAt must still be unset even though the device may already read as connected.
    expect(h!.snapshot().devices[0].lastSeenAt).toBeUndefined();

    // A pure transport socket status flip (phone<->relay) is NOT the laptop talking — no stamp.
    await vi.advanceTimersByTimeAsync(5_000);
    listener.setStatus('connected');
    await h!.flush();
    expect(h!.snapshot().devices[0].lastSeenAt).toBeUndefined();

    // First genuine inbound message from the laptop — NOW last-seen is stamped.
    await vi.advanceTimersByTimeAsync(5_000);
    listener.emit(B.projectList([{ name: 'weft', path: '/repo', isDefault: true }], 'Akash Laptop'));
    await h!.flush();
    const firstSeen = h!.snapshot().devices[0].lastSeenAt;
    expect(typeof firstSeen).toBe('number');

    // A later heartbeat (also inbound) advances it further.
    await vi.advanceTimersByTimeAsync(60_000);
    listener.emit(B.deviceHeartbeat('device-1'));
    await h!.flush();
    expect(h!.snapshot().devices[0].lastSeenAt!).toBeGreaterThan(firstSeen!);
  });
});

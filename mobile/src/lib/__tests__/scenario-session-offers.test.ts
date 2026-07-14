import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function offerPayload(channelId: string) {
  return { v: 1, channelId, pub: `offer-pub-${channelId}`, kind: 'session', transport: { kind: 'local' } };
}

describe('scenario: station-relayed /weft session offers', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('receives SESSION_OFFERS, adopts one by tapping, and ACKs the station with SESSION_CLAIMED', async () => {
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();
    const listener = registry.get('listener-1')!;

    listener.emit(B.projectList([{ name: 'weft', path: 'C:\\weft', isDefault: true }], 'Akash Laptop'));
    await h!.flush();

    // The station relays two in-session `/weft` offers waiting to be adopted.
    listener.emit(
      B.sessionOffers([
        { channelId: 'offer-1', name: 'weft', cwd: 'C:\\weft', payload: offerPayload('offer-1') },
        { channelId: 'offer-2', name: 'cortex', cwd: 'C:\\cortex', payload: offerPayload('offer-2') },
      ]),
    );
    await h!.flush();

    expect(h!.snapshot().devices[0]!.offers).toHaveLength(2);
    expect(h!.snapshot().devices[0]!.offers![0]).toMatchObject({ channelId: 'offer-1', name: 'weft', cwd: 'C:\\weft' });

    // Tap to adopt the first offer: the phone pairs digitally to that session's own channel.
    const joinedId = await h!.manager.joinOfferedSession('listener-1', 'offer-1');
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(joinedId).toBe('offer-1');
    expect(h!.snapshot().activeId).toBe('offer-1');
    expect(h!.active()?.meta.title).toBe('weft');
    expect(h!.active()?.meta.spawnedFromDeviceId).toBe('listener-1');
    expect(h!.active()?.meta.spawnedFromDeviceName).toBe('Akash Laptop');
    expect(registry.get('offer-1')?.sentOfKind('control.state_request')).toHaveLength(1);

    // The station is ACKed so it can drop the offer, and the adopted offer is optimistically removed
    // from the device's advertised list (offer-2 remains).
    const claims = listener.sentOfKind('control.session_claimed');
    expect(claims).toHaveLength(1);
    expect(claims[0]).toMatchObject({ channelId: 'offer-1' });
    expect(h!.snapshot().devices[0]!.offers!.map((o) => o.channelId)).toEqual(['offer-2']);

    // The outbound claim is recorded on the device event log.
    expect(h!.snapshot().devices[0]!.events.some((e) => e.eventSubtype === 'session_claimed')).toBe(true);
  });

  it('rejects an offer that is no longer advertised', async () => {
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();
    registry.get('listener-1')!.emit(B.projectList([], 'Akash Laptop'));
    await h!.flush();

    await expect(h!.manager.joinOfferedSession('listener-1', 'ghost-offer')).rejects.toThrow(/no longer available/);
  });
});

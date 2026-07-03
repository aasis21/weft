import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { heartbeat } from '@aasis21/helm-shared';
import { loadEventLog } from '@/lib/eventLog';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: debug event log', () => {
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

  it('captures both directions, attributes senders, and persists per session', async () => {
    const { client } = await h!.pair('c1');
    // Pairing already dispatched outbound state/history requests (dir 'out').
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    client.emit(B.assistantDelta('Hi', 'm1'));
    await h!.flush();

    await h!.manager.sendPrompt('c1', 'hello there');
    await h!.flush();

    const events = h!.active()!.events;
    const inbound = events.filter((e) => e.dir === 'in');
    const outbound = events.filter((e) => e.dir === 'out');
    expect(inbound.length).toBeGreaterThan(0);
    expect(outbound.length).toBeGreaterThan(0);

    // Inbound is attributed to Copilot; outbound to this phone (WebApp under jsdom).
    expect(inbound.every((e) => e.senderName === 'Copilot')).toBe(true);
    expect(outbound.every((e) => e.senderName === 'WebApp')).toBe(true);

    // The prompt we sent shows up as an outbound 'prompt' event carrying its text.
    const promptEvent = outbound.find((e) => e.eventType === 'prompt');
    expect(promptEvent).toBeTruthy();
    expect((promptEvent!.msg as { text?: string }).text).toBe('hello there');

    // The channel_up we received shows up as an inbound control event.
    expect(
      inbound.some((e) => e.eventType === 'control' && e.eventSubtype === 'channel_up'),
    ).toBe(true);

    // Persisted after the coalesce window; reload returns the same chain.
    await vi.advanceTimersByTimeAsync(800);
    const stored = await loadEventLog('c1');
    expect(stored.length).toBe(events.length);
    expect(stored.some((e) => e.eventType === 'prompt' && e.dir === 'out')).toBe(true);
  });

  it('excludes control.heartbeat from the debug log so real events survive the ring (#67)', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();

    const before = h!.active()!.events.length;
    // A burst of heartbeats must not add any rows to the debug log.
    for (let i = 0; i < 20; i += 1) {
      client.emit(heartbeat(i, false));
    }
    await h!.flush();
    const after = h!.active()!.events;
    expect(after.length).toBe(before);
    expect(after.some((e) => e.eventType === 'control' && e.eventSubtype === 'heartbeat')).toBe(
      false,
    );

    // A subsequent real event is still recorded.
    client.emit(B.assistantDelta('still here', 'm9'));
    await h!.flush();
    expect(
      h!.active()!.events.some((e) => e.eventType === 'stream' && e.eventSubtype === 'assistant_delta'),
    ).toBe(true);
  });

  it('does not leak events across sessions', async () => {
    const c1 = await h!.pair('c1');
    c1.client.emit(B.channelUp('c1', 'sess-1', '/one', 'One'));
    await h!.flush();

    const c2 = await h!.pair('c2');
    c2.client.emit(B.channelUp('c2', 'sess-2', '/two', 'Two'));
    await h!.flush();

    c1.client.emit(B.assistantDelta('only-c1', 'm1'));
    await h!.flush();

    const isDelta = (e: { eventType: string; eventSubtype: string }): boolean =>
      e.eventType === 'stream' && e.eventSubtype === 'assistant_delta';
    expect(h!.byChannel('c1')!.events.some(isDelta)).toBe(true);
    expect(h!.byChannel('c2')!.events.some(isDelta)).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: recent turns backfill', () => {
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

  it('backfills an empty thread from the recent-turns snapshot and clears loading', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();

    // Connect-time sync asks for the in-memory snapshot and shows the skeleton until it lands.
    expect(client.sentOfKind('control.recent_turns_request')).toHaveLength(1);
    expect(h!.active()?.timeline.historyLoading).toBe(true);

    client.emit(
      B.recentTurnsSnapshot([
        B.recentTurnItem('user', 'earlier question', 100, 'u1'),
        B.recentTurnItem('assistant', 'earlier answer', 200, 'a1'),
      ]),
    );
    await h!.flush();

    expect(h!.active()?.timeline.historyLoading).toBe(false);
    expect(h!.active()?.timeline.items.map((i) => ('text' in i ? i.text : ''))).toEqual([
      'earlier question',
      'earlier answer',
    ]);
  });

  it('clears the loading skeleton via the fail-safe when the snapshot reply never lands', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();

    expect(h!.active()?.timeline.historyLoading).toBe(true);

    // No recent-turns reply arrives (lost/dead host) — the 8s fail-safe must release the skeleton.
    await vi.advanceTimersByTimeAsync(8_000);
    await h!.flush();

    expect(h!.active()?.timeline.historyLoading).toBe(false);
  });
});

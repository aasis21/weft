import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: deprecated paginated history', () => {
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

  it('requests only recent-turns on connect and never sends a paginated history request', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();

    expect(client.sentOfKind('control.recent_turns_request')).toHaveLength(1);
    expect(client.sentOfKind('control.history_request')).toHaveLength(0);

    client.emit(
      B.historyPage(
        [B.historyItem(1, 'user', 'legacy', 100), B.historyItem(2, 'assistant', 'page', 200)],
        { nextCursor: 0, hasMore: true },
      ),
    );
    await h!.flush();
    await vi.advanceTimersByTimeAsync(8_000);
    await h!.flush();

    expect(client.sentOfKind('control.history_request')).toHaveLength(0);
    expect(h!.active()!.timeline.historyLoading).toBe(false);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: history', () => {
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

  it('renders the latest page as scrollback with an earlier cursor', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();

    client.emit(
      B.historyPage(
        [B.historyItem(1, 'user', 'hi', 100), B.historyItem(2, 'assistant', 'yo', 200)],
        { nextCursor: 0, hasMore: true },
      ),
    );
    await h!.flush();

    const timeline = h!.active()!.timeline;
    expect(timeline.history.map((item) => item.text)).toEqual(['hi', 'yo']);
    expect(timeline.historyHasMore).toBe(true);
    expect(timeline.historyCursor).toBe(0);
    expect(timeline.latestTurnIndex).toBe(2);
    expect(timeline.historyLoading).toBe(false);
  });

  it('loads an earlier page and prepends it before existing history', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    client.emit(
      B.historyPage(
        [B.historyItem(3, 'user', 'later', 300), B.historyItem(4, 'assistant', 'now', 400)],
        { nextCursor: 2, hasMore: true },
      ),
    );
    await h!.flush();

    await h!.manager.loadEarlierHistory('c1');
    await h!.flush();

    const requests = client.sentOfKind('control.history_request');
    expect(requests).toHaveLength(1);
    expect(requests[0].before).toBe(2);
    expect(requests[0].since).toBeNull();

    client.emit(B.historyPage([B.historyItem(1, 'user', 'older', 100), B.historyItem(2, 'assistant', 'then', 200)], { nextCursor: 0, hasMore: false }));
    await h!.flush();

    const timeline = h!.active()!.timeline;
    expect(timeline.history.map((item) => item.text)).toEqual(['older', 'then', 'later', 'now']);
    expect(timeline.historyCursor).toBe(0);
    expect(timeline.historyHasMore).toBe(false);
    expect(timeline.historyLoading).toBe(false);
  });
});

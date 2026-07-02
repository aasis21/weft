import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSessions } from '@/lib/sessions';
import { loadTranscript } from '@/lib/transcripts';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: remove forget', () => {
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

  it('fully forgets a removed session and rejoins as a fresh empty thread', async () => {
    const first = await h!.pair('c1');
    first.client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    first.client.emit(B.assistantDelta('persist me', 'm1'));
    await h!.flush();
    await vi.advanceTimersByTimeAsync(800);
    await h!.flush();
    expect(await loadTranscript('c1')).not.toBeNull();

    await h!.manager.remove('c1');
    await h!.flush();

    expect(h!.sessions()).toEqual([]);
    expect(h!.snapshot().activeId).toBeNull();
    expect(await loadSessions()).toEqual([]);
    expect(await loadTranscript('c1')).toBeNull();
    expect(first.client.closed).toBe(true);

    const second = await h!.pair('c1');
    const requests = second.client.sentOfKind('control.recent_turns_request');
    expect(requests).toHaveLength(1);
    expect(requests[0].limit).toBe(50);
    expect(second.client.sentOfKind('control.history_request')).toHaveLength(0);
    expect(h!.active()?.timeline.items).toEqual([]);
    expect(h!.active()?.timeline.history).toEqual([]);

    second.client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    second.client.emit(
      B.historyPage(
        [B.historyItem(1, 'user', 'meanwhile', 100), B.historyItem(2, 'assistant', 'caught up', 200)],
        { nextCursor: null, hasMore: false },
      ),
    );
    await h!.flush();

    expect(h!.active()?.timeline.history.map((item) => item.text)).toEqual(['meanwhile', 'caught up']);
  });
});

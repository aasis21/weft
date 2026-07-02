import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: drop catchup', () => {
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

  it('goes offline on socket drop and reconnects with a recent-turns request', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    client.emit(B.heartbeat(5, false));
    client.emit(B.assistantDelta('live tail', 'm1'));
    await h!.flush();
    await vi.advanceTimersByTimeAsync(800);
    await h!.flush();

    expect(h!.active()?.timeline.latestTurnIndex).toBe(5);
    client.setStatus('disconnected');
    await h!.flush();
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toBe('Connection lost — reconnect to resume.');

    await h!.manager.reconnect('c1');
    await h!.flush();

    const fresh = h!.client('c1');
    expect(fresh).not.toBe(client);
    // Reconnect backfill now flows through the extension's in-memory recent-turns snapshot, which is
    // self-contained (no incremental forward-catchup paging).
    expect(fresh.sentOfKind('control.history_request')).toHaveLength(0);
    const requests = fresh.sentOfKind('control.recent_turns_request');
    expect(requests).toHaveLength(1);
    expect(requests[0].limit).toBe(50);
  });
});

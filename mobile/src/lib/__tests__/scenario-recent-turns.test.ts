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

  const texts = (items: readonly { text?: string }[] | undefined): string[] =>
    (items ?? []).map((i) => ('text' in i ? (i.text as string) : ''));
  const dividers = (items: readonly { kind: string; id: string }[] | undefined) =>
    (items ?? []).filter((i) => i.kind === 'notice' && i.id.startsWith('recent-'));

  it('orders backfilled history ABOVE an in-progress live turn on an active-turn join (#93)', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();

    // A live turn is already streaming (newer ts) when we join.
    client.emit(B.stamp(B.assistantDelta('partial answer', 'm1'), { ts: 5_000 }));
    await h!.flush();

    // The recent-turns snapshot then lands with the OLDER conversation that preceded it.
    client.emit(
      B.recentTurnsSnapshot([
        B.recentTurnItem('user', 'earlier question', 100, 'u1'),
        B.recentTurnItem('assistant', 'earlier answer', 200, 'a1'),
      ]),
    );
    await h!.flush();

    const items = h!.active()?.timeline.items;
    expect(texts(items)).toEqual(['earlier question', 'earlier answer', 'partial answer']);
    // Prior context is not "new while you were away" — no divider on a first active-turn join.
    expect(dividers(items)).toHaveLength(0);
  });

  it('shows a divider for an assistant-only backfill under an existing user message (#117)', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();
    client.emit(B.recentTurnsSnapshot([B.recentTurnItem('user', 'my question', 100, 'u1')]));
    await h!.flush();

    // A reconnect backfills ONLY the missing assistant reply.
    client.emit(B.recentTurnsSnapshot([B.recentTurnItem('assistant', 'the answer', 200, 'a1')]));
    await h!.flush();

    const items = h!.active()?.timeline.items;
    const marks = dividers(items);
    expect(marks).toHaveLength(1);
    expect(marks[0].text).toBe('1 new reply');
    expect(texts(items)).toContain('the answer');
  });

  it('keeps at most one "new while away" divider across repeated reconnects (#135)', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();
    client.emit(
      B.recentTurnsSnapshot([
        B.recentTurnItem('user', 'q1', 100, 'u1'),
        B.recentTurnItem('assistant', 'a1', 200, 'a1'),
      ]),
    );
    await h!.flush();

    client.emit(B.recentTurnsSnapshot([B.recentTurnItem('user', 'q2', 300, 'u2')]));
    await h!.flush();
    client.emit(B.recentTurnsSnapshot([B.recentTurnItem('user', 'q3', 400, 'u3')]));
    await h!.flush();

    const items = h!.active()?.timeline.items;
    expect(dividers(items)).toHaveLength(1);
    const msgs = (items ?? []).filter((i) => i.kind === 'user' || i.kind === 'assistant');
    expect(texts(msgs)).toEqual(['q1', 'a1', 'q2', 'q3']);
  });

  it('does not collapse two distinct long prompts sharing a 256-char prefix (#119)', async () => {
    const shared = 'q'.repeat(300);
    const promptA = `${shared}-alpha`;
    const promptB = `${shared}-bravo`;
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();
    client.emit(B.recentTurnsSnapshot([B.recentTurnItem('user', promptA, 100, 'u1')]));
    await h!.flush();
    client.emit(B.recentTurnsSnapshot([B.recentTurnItem('user', promptB, 200, 'u2')]));
    await h!.flush();

    const t = texts(h!.active()?.timeline.items);
    expect(t).toContain(promptA);
    expect(t).toContain(promptB);
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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTranscript } from '@/lib/transcripts';
import { memoryPreferences } from '@/test/helpers/mockPreferences';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

function assistantTexts(items: { kind: string; text?: string }[]): string[] {
  return items.filter((item) => item.kind === 'assistant').map((item) => item.text ?? '');
}

describe('scenario: stream', () => {
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

  it('folds live stream activity, assistant deltas, and inline tool status', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();

    client.emit(B.activity(true));
    expect(h!.active()?.timeline.busy).toBe(true);

    client.emit(B.assistantDelta('Hel', 'm1'));
    client.emit(B.assistantDelta('lo', 'm1'));
    expect(assistantTexts(h!.active()!.timeline.items)).toEqual(['Hello']);

    client.emit(B.toolStart('t1', 'read_file', { path: 'x' }));
    client.emit(B.toolComplete('t1', 'read_file', true, 'ok'));
    const tool = h!.active()!.timeline.items.find((item) => item.kind === 'tool');
    expect(tool).toMatchObject({ id: 't1', name: 'read_file', status: 'success', resultPreview: 'ok' });

    client.emit(B.activity(false));
    expect(h!.active()?.timeline.busy).toBe(false);
  });

  it('marks inactive host activity unread and clears it when focused', async () => {
    const c1 = await h!.pair('c1');
    c1.client.emit(B.channelUp('c1', 'sess-1', '/repo/one', 'One'));
    await h!.flush();

    const c2 = await h!.pair('c2');
    c2.client.emit(B.channelUp('c2', 'sess-2', '/repo/two', 'Two'));
    await h!.flush();

    c1.client.emit(B.assistantDelta('new', 'm1'));
    await h!.flush();

    expect(h!.snapshot().activeId).toBe('c2');
    expect(h!.byChannel('c1')?.unread).toBe(true);
    expect(h!.byChannel('c2')?.unread).toBeFalsy();

    h!.manager.setActive('c1');
    await h!.flush();
    expect(h!.byChannel('c1')?.unread).toBeFalsy();
  });

  it('coalesces a burst into one transcript write containing the final assistant text', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo/app', 'Refactor auth'));
    await h!.flush();

    const setSpy = vi.spyOn(memoryPreferences, 'set');
    setSpy.mockClear();

    client.emit(B.assistantDelta('He', 'm1'));
    client.emit(B.assistantDelta('ll', 'm1'));
    client.emit(B.assistantDelta('o', 'm1'));
    await h!.flush();

    expect(await loadTranscript('c1')).toBeNull();
    await vi.advanceTimersByTimeAsync(800);
    await h!.flush();

    const transcript = await loadTranscript('c1');
    expect(assistantTexts(transcript?.items ?? [])).toEqual(['Hello']);
    const transcriptWrites = setSpy.mock.calls.filter(([arg]) => arg.key === 'weft.transcript.v1.c1');
    expect(transcriptWrites).toHaveLength(1);
  });
});

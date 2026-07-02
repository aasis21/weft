import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadTranscript } from '@/lib/transcripts';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: send prompt', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('optimistically appends, carries attachments, marks failures, retries, and persists', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo', 'Title'));
    await h!.flush();
    client.clearSent();

    await h!.manager.sendPrompt('c1', 'hello');
    const hello = h!.active()!.timeline.items.find((item) => item.kind === 'user' && item.text === 'hello');
    expect(hello).toMatchObject({ kind: 'user', origin: 'phone', text: 'hello' });
    expect(client.sentOfKind('prompt.prompt')).toHaveLength(1);
    expect(client.sentOfKind('prompt.prompt')[0]).toMatchObject({ text: 'hello' });

    const attachments = [{ data: 'AAA', mimeType: 'image/png', name: 'a.png' }];
    await h!.manager.sendPrompt('c1', 'with image', attachments);
    expect(client.sentOfKind('prompt.prompt').at(-1)).toMatchObject({ text: 'with image', attachments });

    const originalSend = client.send;
    client.send = vi.fn().mockRejectedValue(new Error('offline'));
    await h!.manager.sendPrompt('c1', 'will fail');
    const failed = h!.active()!.timeline.items.at(-1);
    expect(failed).toMatchObject({ kind: 'user', text: 'will fail', failed: true });

    client.send = originalSend;
    client.clearSent();
    await h!.manager.retryPrompt('c1', failed!.id);
    const retried = h!.active()!.timeline.items.find((item) => item.kind === 'user' && item.id === failed!.id);
    expect(retried).toMatchObject({ kind: 'user', text: 'will fail' });
    expect(retried).not.toHaveProperty('failed');
    expect(client.sentOfKind('prompt.prompt')).toHaveLength(1);
    expect(client.sentOfKind('prompt.prompt')[0]).toMatchObject({ text: 'will fail' });

    await vi.advanceTimersByTimeAsync(800);
    await h!.flush();
    const transcript = await loadTranscript('c1');
    expect(transcript?.items).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'user', text: 'hello' })]));
  });
});

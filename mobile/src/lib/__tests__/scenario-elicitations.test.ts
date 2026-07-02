import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import { notificationSpies } from '@/test/helpers/mockNotifications';
import * as B from '@/test/helpers/builders';

describe('scenario: elicitations', () => {
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

  it('notifies, answers form/url requests, supports decline/cancel, and dismisses completions', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo', 'Title'));
    await h!.flush();
    client.clearSent();

    client.emit(
      B.elicitationRequest('e1', 'Choose', 'form', {
        type: 'object',
        properties: { name: { type: 'string' } },
        required: ['name'],
      }),
    );
    client.emit(B.elicitationRequest('e2', 'Open this', 'url', undefined, undefined, 'https://x'));
    await h!.flush();

    expect(h!.active()!.timeline.elicitations.map((e) => e.requestId)).toEqual(['e1', 'e2']);
    expect(h!.active()!.timeline.elicitations.find((e) => e.requestId === 'e2')?.url).toBe('https://x');
    expect(notificationSpies().notifyElicitationRequest).toHaveBeenCalledTimes(2);

    await h!.manager.sendElicitation('c1', 'e1', 'accept', { name: 'bob' });
    expect(h!.active()!.timeline.elicitations.map((e) => e.requestId)).toEqual(['e2']);
    expect(client.sentOfKind('elicitation_response.response')[0]).toMatchObject({
      requestId: 'e1',
      action: 'accept',
      content: { name: 'bob' },
    });

    client.emit(B.elicitationRequest('e3', 'Decline?', 'form', { type: 'object', properties: {} }));
    client.emit(B.elicitationRequest('e4', 'Cancel?', 'form', { type: 'object', properties: {} }));
    await h!.flush();
    await h!.manager.sendElicitation('c1', 'e3', 'decline');
    await h!.manager.sendElicitation('c1', 'e4', 'cancel');
    expect(client.sentOfKind('elicitation_response.response')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ requestId: 'e3', action: 'decline' }),
        expect.objectContaining({ requestId: 'e4', action: 'cancel' }),
      ]),
    );

    client.emit(B.elicitationRequest('e5', 'Elsewhere?', 'form', { type: 'object', properties: {} }));
    await h!.flush();
    expect(h!.active()!.timeline.elicitations.some((e) => e.requestId === 'e5')).toBe(true);
    client.emit(B.elicitationComplete('e5'));
    await h!.flush();
    expect(h!.active()!.timeline.elicitations.some((e) => e.requestId === 'e5')).toBe(false);
  });
});

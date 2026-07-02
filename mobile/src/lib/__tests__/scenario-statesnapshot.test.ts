import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

describe('scenario: state snapshot', () => {
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

  it('hydrates live busy, mode, cursor, approvals, and elicitations from a connect snapshot', async () => {
    const { client } = await h!.pair('c1');

    client.emit(
      B.stateSnapshot({
        busy: true,
        abortable: true,
        mode: 'plan',
        latestTurnIndex: 7,
        approvals: [
          B.approvalRequest('r1', 'write_file', {}, [
            { id: 'allow', label: 'Allow' },
            { id: 'deny', label: 'Deny' },
          ]).msg,
        ],
        elicitations: [
          B.elicitationRequest('e1', 'Pick one', 'form', { type: 'object', properties: {} }).msg,
        ],
      }),
    );
    await h!.flush();

    const timeline = h!.active()!.timeline;
    expect(h!.active()?.status).toBe('live');
    expect(timeline.busy).toBe(true);
    expect(timeline.mode).toBe('plan');
    expect(timeline.latestTurnIndex).toBe(7);
    expect(timeline.approvals).toHaveLength(1);
    expect(timeline.approvals[0].requestId).toBe('r1');
    expect(timeline.elicitations).toHaveLength(1);
    expect(timeline.elicitations[0].requestId).toBe('e1');
  });
});

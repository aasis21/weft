import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import { notificationSpies } from '@/test/helpers/mockNotifications';
import * as B from '@/test/helpers/builders';

describe('scenario: approvals', () => {
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

  it('notifies, dedupes, sends decisions, and restores failed decisions', async () => {
    const { client } = await h!.pair('c1');
    client.emit(B.channelUp('c1', 'sess-1', '/repo', 'Title'));
    await h!.flush();
    client.clearSent();

    const request = B.approvalRequest('r1', 'write_file', { path: 'a.ts' }, [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ]);
    client.emit(request);
    await h!.flush();

    expect(h!.active()!.timeline.approvals.map((a) => a.requestId)).toEqual(['r1']);
    expect(notificationSpies().notifyApprovalRequest).toHaveBeenCalledTimes(1);

    await h!.manager.sendApproval('c1', 'r1', 'allow');
    expect(h!.active()!.timeline.approvals).toHaveLength(0);
    expect(client.sentOfKind('decision.approval_decision')).toHaveLength(1);
    expect(client.sentOfKind('decision.approval_decision')[0]).toMatchObject({ requestId: 'r1', optionId: 'allow' });

    client.emit(request);
    client.emit(request);
    await h!.flush();
    expect(h!.active()!.timeline.approvals.map((a) => a.requestId)).toEqual(['r1']);

    client.send = vi.fn().mockRejectedValue(new Error('offline'));
    await h!.manager.sendApproval('c1', 'r1', 'deny');

    const timeline = h!.active()!.timeline;
    expect(timeline.approvals.map((a) => a.requestId)).toEqual(['r1']);
    expect(timeline.approvalErrors.r1).toContain('offline');
  });
});

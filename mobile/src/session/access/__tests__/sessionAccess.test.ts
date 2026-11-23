import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RuntimeSessionAccess } from '@/session/access/sessionAccess';
import { loadPendingOperations } from '@/lib/pendingOperations';
import { makeManager } from '@/test/helpers/makeManager';
import { registry } from '@/test/helpers/fakeWeftClient';
import * as B from '@/test/helpers/builders';

function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'local' },
  });
}

describe('SessionAccess (protocol v3 open requests)', () => {
  let h: ReturnType<typeof makeManager>;
  const accessors: RuntimeSessionAccess[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    h = makeManager();
  });

  afterEach(() => {
    for (const access of accessors) access.dispose();
    h.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  function access(): RuntimeSessionAccess {
    const result = new RuntimeSessionAccess(h.manager);
    accessors.push(result);
    return result;
  }

  it('opens an existing phone card without asking Station', async () => {
    await h.manager.addByQr(listenerQr('listener-existing'));
    const listener = registry.get('listener-existing')!;
    const { client } = await h.pair('live-card');
    client.emit(B.channelUp('live-card', 'session-a', 'C:\\repo', 'Session A'));
    await h.flush();

    const status = await access().open({
      requestId: 'open-existing',
      deviceChannelId: 'listener-existing',
      target: { kind: 'existing', storeAuthority: null, sessionId: 'session-a' },
    });

    expect(status).toMatchObject({ requestId: 'open-existing', outcome: 'done', result: { sessionId: 'session-a' } });
    expect(h.snapshot().activeId).toBe('live-card');
    expect(listener.sentOfKind('control.open_session')).toHaveLength(0);
  });

  it('pairs an offered session directly and opens a stopped session by target only', async () => {
    await h.manager.addByQr(listenerQr('listener-open'));
    const listener = registry.get('listener-open')!;
    listener.emit(B.projectList([], 'Laptop'));
    listener.emit(B.sessionOffers([{
      channelId: 'offered',
      name: 'Offered session',
      cwd: 'C:\\repo',
      payload: {
        v: 1,
        channelId: 'offered',
        pub: 'offered-pub',
        kind: 'session',
        transport: { kind: 'local' },
      },
    }]));
    await h.flush();

    const sessionAccess = access();
    const activated = await sessionAccess.open({
      requestId: 'activate-live',
      deviceChannelId: 'listener-open',
      target: { kind: 'offer', offerChannelId: 'offered' },
    });
    expect(activated).toMatchObject({ outcome: 'done' });
    expect(listener.sentOfKind('control.session_claimed')[0]).toMatchObject({ channelId: 'offered' });

    const resumed = await sessionAccess.open({
      requestId: 'resume-stopped',
      deviceChannelId: 'listener-open',
      target: { kind: 'existing', storeAuthority: 'cli', sessionId: 'stopped-session' },
      title: 'Stopped session',
      cwd: 'C:\\repo',
    });
    expect(resumed).toMatchObject({ requestId: 'resume-stopped', stage: 'accepted', outcome: null });
    expect(listener.sentOfKind('control.open_session')).toEqual([{
      requestId: 'resume-stopped',
      target: { sessionId: 'stopped-session', storeAuthority: 'cli' },
      options: { permissionMode: 'default', title: null },
    }]);
    expect(listener.sentOfKind('control.resume_session')).toHaveLength(0);
  });

  it('refuses to reuse a request id for a different request', async () => {
    await h.manager.addByQr(listenerQr('listener-idem'));
    const listener = registry.get('listener-idem')!;
    const sessionAccess = access();
    await sessionAccess.open({
      requestId: 'same-id',
      deviceChannelId: 'listener-idem',
      target: { kind: 'new', projectName: 'weft' },
    });
    const again = await sessionAccess.open({
      requestId: 'same-id',
      deviceChannelId: 'listener-idem',
      target: { kind: 'new', projectName: 'weft' },
    });
    const conflict = await sessionAccess.open({
      requestId: 'same-id',
      deviceChannelId: 'listener-idem',
      target: { kind: 'new', projectName: 'cortex' },
    });

    expect(again).toMatchObject({ requestId: 'same-id', outcome: null });
    expect(conflict).toMatchObject({ requestId: 'same-id', outcome: 'failed', reason: 'invalid-request' });
    expect(listener.sentOfKind('control.open_session')).toHaveLength(1);
  });

  it('persists accepted Start requests, retries the same request id, and cancels them', async () => {
    await h.manager.addByQr(listenerQr('listener-start'));
    const listener = registry.get('listener-start')!;
    const firstAccess = access();
    const started = await firstAccess.open({
      requestId: 'start-new',
      deviceChannelId: 'listener-start',
      target: { kind: 'new', projectName: 'weft' },
      mode: 'allow-all',
      name: 'Phone launch',
    });
    expect(started).toMatchObject({ requestId: 'start-new', stage: 'accepted', outcome: null });
    expect(listener.sentOfKind('control.open_session')[0]).toEqual({
      requestId: 'start-new',
      target: { project: 'weft' },
      options: { permissionMode: 'allow-all', title: 'Phone launch' },
    });

    firstAccess.dispose();
    const restoredAccess = access();
    await restoredAccess.init();
    expect(await restoredAccess.inspect('start-new')).toMatchObject({
      requestId: 'start-new',
      outcome: null,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await h.flush();
    expect(await restoredAccess.inspect('start-new')).toMatchObject({
      outcome: 'failed',
      reason: 'timeout',
    });

    await restoredAccess.retry('start-new');
    expect(listener.sentOfKind('control.open_session')).toHaveLength(2);
    expect(listener.sentOfKind('control.open_session')[1]!.requestId).toBe('start-new');

    await vi.advanceTimersByTimeAsync(30_000);
    await h.flush();
    expect(await restoredAccess.cancel('start-new')).toMatchObject({ outcome: 'cancelled' });
    expect(listener.sentOfKind('control.lifecycle_cancel').at(-1)).toMatchObject({ requestId: 'start-new' });
    expect(await loadPendingOperations()).toHaveLength(0);
  });

  it('shows Station\u2019s takeover challenge and confirms it with the exact challenge id and revision', async () => {
    await h.manager.addByQr(listenerQr('listener-takeover'));
    const listener = registry.get('listener-takeover')!;
    await h.flush();
    const sessionAccess = access();
    await sessionAccess.open({
      requestId: 'v3-takeover',
      deviceChannelId: 'listener-takeover',
      target: { kind: 'existing', storeAuthority: 'cli', sessionId: 'session-a' },
    });

    listener.emit(B.lifecycleStatus({
      requestId: 'v3-takeover',
      revision: 4,
      stage: 'awaiting-confirmation',
      reason: 'controller-conflict',
      result: {
        challenge: { challengeId: 'challenge-4', runtimeId: 'runtime-a', controllerRevision: 2, controllerName: 'Pixel' },
      },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h.flush();
    expect(await sessionAccess.inspect('v3-takeover')).toMatchObject({
      stage: 'awaiting-confirmation',
      outcome: null,
      reason: 'controller-conflict',
      revision: 4,
      result: { challenge: { challengeId: 'challenge-4', runtimeId: 'runtime-a', controllerRevision: 2 } },
    });

    const confirming = sessionAccess.confirmTakeover('v3-takeover');
    await h.flush();
    expect(listener.sentOfKind('control.takeover_confirm').at(-1)).toEqual({
      requestId: 'v3-takeover',
      challengeId: 'challenge-4',
      revision: 4,
    });
    expect(listener.sentOfKind('control.open_session')).toHaveLength(1);
    listener.emit(B.lifecycleStatus({
      requestId: 'v3-takeover',
      revision: 5,
      stage: 'preparing-link',
      result: { action: 'takeover' },
    }));
    await expect(confirming).resolves.toMatchObject({
      stage: 'preparing-link',
      revision: 5,
      result: { action: 'takeover' },
    });
  });

  it('refuses a takeover without a live challenge instead of guessing', async () => {
    await h.manager.addByQr(listenerQr('listener-stale'));
    const listener = registry.get('listener-stale')!;
    const sessionAccess = access();
    await sessionAccess.open({
      requestId: 'no-challenge',
      deviceChannelId: 'listener-stale',
      target: { kind: 'existing', sessionId: 'session-b' },
    });
    expect(await sessionAccess.confirmTakeover('no-challenge')).toMatchObject({
      outcome: 'failed',
      reason: 'takeover-stale',
    });
    expect(listener.sentOfKind('control.takeover_confirm')).toHaveLength(0);
  });

  it('waits for Station acknowledgement before applying a revisioned cancel', async () => {
    await h.manager.addByQr(listenerQr('listener-v3-cancel'));
    const listener = registry.get('listener-v3-cancel')!;
    await h.flush();
    const sessionAccess = access();
    await sessionAccess.open({
      requestId: 'v3-cancel',
      deviceChannelId: 'listener-v3-cancel',
      target: { kind: 'new', projectName: 'weft' },
    });
    listener.emit(B.lifecycleStatus({
      requestId: 'v3-cancel',
      revision: 3,
      stage: 'dispatching',
      result: { action: 'start' },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h.flush();

    const cancelling = sessionAccess.cancel('v3-cancel');
    await h.flush();
    expect(listener.sentOfKind('control.lifecycle_cancel').at(-1)).toEqual({
      requestId: 'v3-cancel',
      revision: 3,
    });
    expect(await sessionAccess.inspect('v3-cancel')).toMatchObject({ stage: 'dispatching', outcome: null, revision: 3 });

    listener.emit(B.lifecycleStatus({
      requestId: 'v3-cancel',
      revision: 4,
      stage: 'dispatching',
      outcome: 'cancelled',
      result: { action: 'start', mayBeRunning: true },
    }));
    await expect(cancelling).resolves.toMatchObject({ outcome: 'cancelled', revision: 4 });
    expect(await sessionAccess.inspect('v3-cancel')).toMatchObject({ outcome: 'cancelled', revision: 4 });
  });
});

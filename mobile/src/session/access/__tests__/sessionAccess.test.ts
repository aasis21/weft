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

describe('SessionAccess compatibility adapter', () => {
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

  it('opens an existing phone card without sending a Resume request', async () => {
    await h.manager.addByQr(listenerQr('listener-existing'));
    const listener = registry.get('listener-existing')!;
    const { client } = await h.pair('live-card');
    client.emit(B.channelUp('live-card', 'session-a', 'C:\\repo', 'Session A'));
    await h.flush();

    const status = await access().open({
      operationId: 'open-existing',
      deviceChannelId: 'listener-existing',
      target: { kind: 'existing', storeAuthority: null, sessionId: 'session-a' },
    });

    expect(status).toMatchObject({ state: 'open', action: 'reconnect' });
    expect(h.snapshot().activeId).toBe('live-card');
    expect(listener.sentOfKind('control.resume_session')).toHaveLength(0);
  });

  it('adapts offered activation and stopped Resume through Open intents', async () => {
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
      operationId: 'activate-live',
      deviceChannelId: 'listener-open',
      target: { kind: 'offer', offerChannelId: 'offered' },
    });
    expect(activated).toMatchObject({ state: 'open', action: 'activate' });
    expect(listener.sentOfKind('control.session_claimed')[0]).toMatchObject({
      channelId: 'offered',
    });

    const resumed = await sessionAccess.open({
      operationId: 'resume-stopped',
      deviceChannelId: 'listener-open',
      target: { kind: 'existing', storeAuthority: null, sessionId: 'stopped-session' },
      title: 'Stopped session',
      cwd: 'C:\\repo',
    });
    expect(resumed).toMatchObject({ state: 'launching', action: 'resume' });
    expect(listener.sentOfKind('control.resume_session')[0]).toMatchObject({
      requestId: 'resume-stopped',
      sessionId: 'stopped-session',
    });
  });

  it('persists accepted Start operations, retries the same operation, and cancels them', async () => {
    await h.manager.addByQr(listenerQr('listener-start'));
    const listener = registry.get('listener-start')!;
    const firstAccess = access();
    const started = await firstAccess.open({
      operationId: 'start-new',
      deviceChannelId: 'listener-start',
      target: { kind: 'new', projectName: 'weft' },
      mode: 'allow-all',
      name: 'Phone launch',
    });
    expect(started).toMatchObject({ state: 'launching', action: 'start' });
    expect(listener.sentOfKind('control.spawn_session')[0]).toMatchObject({
      requestId: 'start-new',
      projectName: 'weft',
      mode: 'allow-all',
    });

    firstAccess.dispose();
    const restoredAccess = access();
    await restoredAccess.init();
    expect(await restoredAccess.inspect('start-new')).toMatchObject({
      operationId: 'start-new',
      state: 'launching',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await h.flush();
    expect(await restoredAccess.inspect('start-new')).toMatchObject({
      state: 'failed',
      failure: { code: 'timeout', actions: ['retry', 'cancel'] },
    });

    await restoredAccess.retry('start-new');
    expect(listener.sentOfKind('control.spawn_session')).toHaveLength(2);
    expect(listener.sentOfKind('control.spawn_session')[1]!.requestId).toBe('start-new');

    expect(await restoredAccess.cancel('start-new')).toMatchObject({
      state: 'cancelled',
      failure: { code: 'cancelled' },
    });
    expect(await loadPendingOperations()).toHaveLength(0);
  });

  it('turns a legacy controller refusal into a structured takeover challenge', async () => {
    const resume = vi.spyOn(h.manager, 'resumeSession')
      .mockRejectedValueOnce(
        new Error('That session is already running on this laptop and connected to a phone.'),
      )
      .mockResolvedValueOnce('taken-over');
    const sessionAccess = access();

    const blocked = await sessionAccess.open({
      operationId: 'takeover-op',
      deviceChannelId: 'listener',
      target: { kind: 'existing', storeAuthority: null, sessionId: 'session-a' },
    });
    expect(blocked).toMatchObject({
      state: 'failed',
      failure: {
        code: 'controller-conflict',
        actions: ['confirm-takeover', 'cancel'],
      },
      challenge: { operationId: 'takeover-op', sessionId: 'session-a' },
    });

    const confirmed = await sessionAccess.confirmTakeover('takeover-op');
    expect(confirmed).toMatchObject({ state: 'open', action: 'takeover' });
    expect(resume).toHaveBeenLastCalledWith(
      'listener',
      expect.objectContaining({
        sessionId: 'session-a',
        force: true,
        operationId: 'takeover-op',
      }),
    );
  });

  it('preserves modern lifecycle snapshots and confirms takeover with the exact challenge revision', async () => {
    await h.manager.addByQr(listenerQr('listener-modern-takeover'));
    const listener = registry.get('listener-modern-takeover')!;
    listener.emit(B.projectList([], 'Laptop', 'device-a', [
      B.DEVICE_CAPABILITY.SESSION_ACTIVATION_V1,
    ]));
    await h.flush();
    const sessionAccess = access();
    await sessionAccess.open({
      operationId: 'modern-takeover',
      deviceChannelId: 'listener-modern-takeover',
      target: { kind: 'existing', storeAuthority: 'cli', sessionId: 'session-a' },
    });

    listener.emit(B.lifecycleStatus({
      operationId: 'modern-takeover',
      fingerprint: 'server-fingerprint',
      state: 'activating',
      revision: 4,
      action: 'activate',
      target: { kind: 'existing', storeAuthority: 'cli', sessionId: 'session-a' },
      failure: {
        code: 'controller-conflict',
        actions: ['confirm-takeover', 'cancel'],
      },
      challenge: {
        challengeId: 'challenge-4',
        operationId: 'modern-takeover',
        revision: 4,
        sessionId: 'session-a',
        storeAuthority: 'cli',
        runtimeInstanceId: 'runtime-a',
        generation: 3,
        pid: 42,
        processStartedAt: 100,
        responsive: true,
      },
    }));
    await h.flush();
    expect(await sessionAccess.inspect('modern-takeover')).toMatchObject({
      state: 'activating',
      fingerprint: 'server-fingerprint',
      revision: 4,
      challenge: { challengeId: 'challenge-4', revision: 4 },
    });

    const confirming = sessionAccess.confirmTakeover('modern-takeover');
    await h.flush();
    expect(listener.sentOfKind('control.takeover_confirm').at(-1)).toEqual({
      operationId: 'modern-takeover',
      challengeId: 'challenge-4',
      revision: 4,
    });
    expect(listener.sentOfKind('control.open_session')).toHaveLength(1);
    listener.emit(B.lifecycleStatus({
      operationId: 'modern-takeover',
      fingerprint: 'server-fingerprint',
      state: 'pairing-ready',
      revision: 5,
      action: 'takeover',
      target: { kind: 'existing', storeAuthority: 'cli', sessionId: 'session-a' },
    }));
    await expect(confirming).resolves.toMatchObject({
      state: 'pairing-ready',
      revision: 5,
      action: 'takeover',
    });
  });

  it('waits for Station acknowledgement before applying a revisioned cancel', async () => {
    await h.manager.addByQr(listenerQr('listener-modern-cancel'));
    const listener = registry.get('listener-modern-cancel')!;
    listener.emit(B.projectList([], 'Laptop', 'device-a', [
      B.DEVICE_CAPABILITY.SESSION_ACTIVATION_V1,
    ]));
    await h.flush();
    const sessionAccess = access();
    await sessionAccess.open({
      operationId: 'modern-cancel',
      deviceChannelId: 'listener-modern-cancel',
      target: { kind: 'new', projectName: 'weft' },
    });
    listener.emit(B.lifecycleStatus({
      operationId: 'modern-cancel',
      fingerprint: 'server-fingerprint',
      state: 'launching',
      revision: 3,
      action: 'start',
      target: { kind: 'new', projectName: 'weft' },
    }));
    await h.flush();

    const cancelling = sessionAccess.cancel('modern-cancel');
    await h.flush();
    expect(listener.sentOfKind('control.lifecycle_cancel').at(-1)).toEqual({
      operationId: 'modern-cancel',
      revision: 3,
    });
    expect(await sessionAccess.inspect('modern-cancel')).toMatchObject({
      state: 'launching',
      revision: 3,
    });

    listener.emit(B.lifecycleStatus({
      operationId: 'modern-cancel',
      fingerprint: 'server-fingerprint',
      state: 'cancelled',
      revision: 4,
      action: 'start',
      target: { kind: 'new', projectName: 'weft' },
      failure: { code: 'cancelled', actions: [] },
    }));
    await expect(cancelling).resolves.toMatchObject({
      state: 'cancelled',
      revision: 4,
    });
    expect(await sessionAccess.inspect('modern-cancel')).toMatchObject({
      state: 'cancelled',
      revision: 4,
    });
  });
});

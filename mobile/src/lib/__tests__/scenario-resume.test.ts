import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import { registry } from '@/test/helpers/fakeWeftClient';
import * as B from '@/test/helpers/builders';
import { sessionListScopeKey } from '@/session/model';

function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'local' },
  });
}

function requiredRequestId(message: { requestId?: unknown }): string {
  if (typeof message.requestId !== 'string') throw new Error('Expected requestId on session-list request.');
  return message.requestId;
}

describe('scenario: resume a CLI session from the phone', () => {
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

  it('pulls the session list on demand, then resumes one and pairs to the new channel', async () => {
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();
    const listener = registry.get('listener-1');
    expect(listener).toBeDefined();

    // On-demand pull only — nothing is requested until the phone asks.
    await h!.manager.refreshSessions('listener-1', 'C:\\repo\\weft', 'created');
    await h!.flush();
    expect(listener!.sentOfKind('control.session_list_request')).toHaveLength(1);
    expect(listener!.sentOfKind('control.session_list_request')[0]).toMatchObject({
      cwd: 'C:\\repo\\weft',
      sort: 'created',
      requestId: expect.any(String),
    });
    expect(h!.snapshot().devices[0]!.sessionsLoading).toBe(true);

    listener!.emit(
      B.sessionList([
        {
          sessionId: 'sid-42',
          title: 'Fix the bug',
          cwd: 'C:\\repo\\weft',
          repository: 'weft',
          branch: 'main',
          updatedAt: Date.now(),
        },
      ]),
    );
    await h!.flush();

    const device = h!.snapshot().devices[0]!;
    expect(device.sessionsLoading).toBe(false);
    expect(device.sessions).toHaveLength(1);
    expect(device.sessions![0]).toMatchObject({ sessionId: 'sid-42', title: 'Fix the bug' });
    expect(device.sessionLists?.[sessionListScopeKey('C:\\repo\\weft', 'created')]).toMatchObject({
      sessions: [{ sessionId: 'sid-42', title: 'Fix the bug' }],
      loading: false,
    });

    // Resume it — spawns an Initializing card and sends a target-only v3 OPEN_SESSION.
    const tempId = await h!.manager.resumeSession('listener-1', {
      sessionId: 'sid-42',
      mode: 'allow-all',
      title: 'Fix the bug',
      cwd: 'C:\\repo\\weft',
    });
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(tempId);
    expect(h!.active()?.status).toBe('initializing');
    expect(h!.active()?.meta.title).toBe('Fix the bug');
    expect(h!.active()?.meta.sessionId).toBe('sid-42');
    const resume = listener!.sentOfKind('control.open_session')[0]!;
    expect(resume).toEqual({
      requestId: expect.any(String),
      target: { sessionId: 'sid-42' },
      options: { permissionMode: 'allow-all', title: null },
    });
    expect(listener!.sentOfKind('control.spawn_session')).toHaveLength(0);

    // Station resumes it and hands over the resumed session's pairing material in lifecycle_status.
    listener!.emit(B.lifecycleStatus({
      requestId: resume.requestId as string,
      revision: 2,
      stage: 'preparing-link',
      result: {
        action: 'resume',
        payload: { v: 1, channelId: 'resumed-1', pub: 'resumed-pub', kind: 'session', transport: { kind: 'local' } },
      },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe('resumed-1');
    expect(h!.byChannel(tempId)).toBeUndefined();
    expect(h!.active()?.status).toBe('connecting');
    // renamed stays false so the resumed session's own CLI title can win later.
    expect(h!.active()?.meta.renamed).toBeFalsy();
    expect(h!.active()?.meta.spawnedFromDeviceId).toBe('listener-1');

    const deviceEvents = h!.snapshot().devices[0]!.events;
    expect(deviceEvents.some((e) => e.eventSubtype === 'session_list_request')).toBe(true);
    expect(deviceEvents.some((e) => e.eventSubtype === 'session_list')).toBe(true);
    expect(deviceEvents.some((e) => e.eventSubtype === 'open_session')).toBe(true);
  });

  it('serializes refreshes per device and keeps each folder/sort snapshot separate', async () => {
    await h!.manager.addByQr(listenerQr('listener-scoped'));
    await h!.flush();
    const listener = registry.get('listener-scoped')!;

    await h!.manager.refreshSessions('listener-scoped', 'C:\\repo\\one', 'activity');
    await h!.flush();
    const first = listener.sentOfKind('control.session_list_request')[0]!;
    const firstRequestId = requiredRequestId(first);
    await h!.manager.refreshSessions('listener-scoped', 'C:\\repo\\two', 'created');
    await h!.flush();
    expect(listener.sentOfKind('control.session_list_request')).toHaveLength(1);

    listener.emit(B.sessionList([
      {
        sessionId: 'one',
        title: 'First folder',
        cwd: 'C:\\repo\\one',
        repository: 'one',
        branch: 'main',
        updatedAt: 100,
      },
    ], null, { requestId: firstRequestId, cwd: 'C:\\repo\\one', sort: 'activity' }));
    await h!.flush();

    const requests = listener.sentOfKind('control.session_list_request');
    expect(requests).toHaveLength(2);
    const secondRequestId = requiredRequestId(requests[1]!);
    expect(requests[1]).toMatchObject({
      cwd: 'C:\\repo\\two',
      sort: 'created',
      requestId: expect.any(String),
    });
    listener.emit(B.sessionList([
      {
        sessionId: 'two',
        title: 'Second folder',
        cwd: 'C:\\repo\\two',
        repository: 'two',
        branch: 'main',
        updatedAt: 200,
      },
    ], null, {
      requestId: secondRequestId,
      cwd: 'C:\\repo\\two',
      sort: 'created',
    }));
    await h!.flush();

    const lists = h!.snapshot().devices[0]!.sessionLists;
    expect(lists?.[sessionListScopeKey('C:\\repo\\one', 'activity')]?.sessions?.[0]?.sessionId).toBe('one');
    expect(lists?.[sessionListScopeKey('C:\\repo\\two', 'created')]?.sessions?.[0]?.sessionId).toBe('two');
  });

  it('keeps a failed store read distinct from an empty session list', async () => {
    await h!.manager.addByQr(listenerQr('listener-store-error'));
    await h!.flush();
    const listener = registry.get('listener-store-error')!;

    await h!.manager.refreshSessions('listener-store-error', 'C:\\repo\\gone', 'activity');
    await h!.flush();
    const request = listener.sentOfKind('control.session_list_request')[0]!;
    listener.emit(B.sessionList([], null, {
      requestId: requiredRequestId(request),
      cwd: 'C:\\repo\\gone',
      sort: 'activity',
      errorCode: 'session-store-unavailable',
    }));
    await h!.flush();

    const cache = h!.snapshot().devices[0]!.sessionLists?.[
      sessionListScopeKey('C:\\repo\\gone', 'activity')
    ];
    expect(cache).toMatchObject({ error: 'session-store-unavailable', loading: false });
    expect(cache?.sessions).toBeUndefined();
  });

  it('does not assign a late uncorrelated reply to a different scope after a timeout', async () => {
    await h!.manager.addByQr(listenerQr('listener-timeout'));
    await h!.flush();
    const listener = registry.get('listener-timeout')!;
    await h!.manager.refreshSessions('listener-timeout', 'C:\\repo\\one', 'activity');
    await h!.flush();
    await h!.manager.refreshSessions('listener-timeout', 'C:\\repo\\two', 'created');

    await vi.advanceTimersByTimeAsync(8_000);
    await h!.flush();
    const request = listener.sentOfKind('control.session_list_request')[1]!;
    listener.emit(B.sessionList([{
      sessionId: 'stale',
      title: 'Old request',
      cwd: 'C:\\repo\\one',
      repository: 'one',
      branch: null,
      updatedAt: 1,
    }]));
    await h!.flush();
    const key = sessionListScopeKey('C:\\repo\\two', 'created');
    expect(h!.snapshot().devices[0]!.sessionLists?.[key]).toMatchObject({ loading: true });

    listener.emit(B.sessionList([], null, {
      requestId: requiredRequestId(request),
      cwd: 'C:\\repo\\two',
      sort: 'created',
    }));
    await h!.flush();
    expect(h!.snapshot().devices[0]!.sessionLists?.[key]).toMatchObject({ loading: false, sessions: [] });
  });

  it('fails an initializing resume card if the laptop reports it cannot resume', async () => {
    await h!.manager.addByQr(listenerQr('listener-2'));
    await h!.flush();
    const listener = registry.get('listener-2');

    const tempId = await h!.manager.resumeSession('listener-2', {
      sessionId: 'gone-sid',
      mode: 'default',
      title: 'Deleted worktree',
      cwd: 'C:\\repo\\gone',
    });
    await h!.flush();

    const resume = listener!.sentOfKind('control.open_session')[0]!;
    listener!.emit(B.lifecycleStatus({
      requestId: resume.requestId as string,
      revision: 1,
      stage: 'resolving',
      outcome: 'failed',
      reason: 'not-found',
      result: { message: 'That session no longer exists.' },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(tempId);
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toBe('That session no longer exists.');
  });

  it('retries a slow resume with the same request id instead of starting a second writer', async () => {
    await h!.manager.addByQr(listenerQr('listener-retry'));
    await h!.flush();
    const listener = registry.get('listener-retry')!;

    const tempId = await h!.manager.resumeSession('listener-retry', {
      sessionId: 'sid-slow',
      mode: 'default',
      title: 'Slow session',
      cwd: 'C:\\repo\\weft',
    });
    await h!.flush();
    const first = listener.sentOfKind('control.open_session')[0]!;

    await vi.advanceTimersByTimeAsync(90_000);
    await h!.flush();
    expect(h!.active()?.status).toBe('error');

    await h!.manager.retrySpawn(tempId);
    await h!.flush();

    const requests = listener.sentOfKind('control.open_session');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requestId).toBe(first.requestId);
    expect(requests[1]!.target).toEqual({ sessionId: 'sid-slow' });
  });
});

describe('scenario: resuming a session the phone is already driving', () => {
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

  /** Pair a session card and let it report the CLI sessionId, which is the only handle the resume
   *  list and the phone's cards have in common. */
  async function liveCard(channelId: string, sessionId: string): Promise<void> {
    const { client } = await h!.pair(channelId);
    client.emit(B.channelUp(channelId, sessionId, 'C:\\repo\\weft', 'Fix the bug'));
    client.emit(B.heartbeat(1, false));
    await h!.flush();
  }

  it('opens the live card instead of forking a second CLI onto the same session', async () => {
    await h!.manager.addByQr(listenerQr('listener-3'));
    await h!.flush();
    const listener = registry.get('listener-3');
    await liveCard('already-here', 'sid-42');
    expect(h!.byChannel('already-here')?.meta.sessionId).toBe('sid-42');

    const id = await h!.manager.resumeSession('listener-3', {
      sessionId: 'sid-42',
      mode: 'allow-all',
      title: 'Fix the bug',
      cwd: 'C:\\repo\\weft',
    });
    await h!.flush();

    // No message to the laptop at all — the only thing a resume could have achieved is already true.
    expect(listener!.sentOfKind('control.open_session')).toHaveLength(0);
    expect(id).toBe('already-here');
    expect(h!.snapshot().activeId).toBe('already-here');
    // And no second card: the reconcile that used to clean this up disposed the duplicate card but
    // left the extra `copilot --resume` process running.
    expect(h!.sessions().filter((s) => s.meta.sessionId === 'sid-42')).toHaveLength(1);
  });

  it('still resumes a session whose card has ended', async () => {
    await h!.manager.addByQr(listenerQr('listener-4'));
    await h!.flush();
    const listener = registry.get('listener-4');
    const { client } = await h!.pair('finished');
    client.emit(B.channelUp('finished', 'sid-99', 'C:\\repo\\weft', 'All done'));
    await h!.flush();
    client.emit(B.channelDown('Session ended.'));
    await h!.flush();
    expect(h!.byChannel('finished')?.status).toBe('ended');

    await h!.manager.resumeSession('listener-4', {
      sessionId: 'sid-99',
      mode: 'allow-all',
      title: 'All done',
      cwd: 'C:\\repo\\weft',
    });
    await h!.flush();

    expect(listener!.sentOfKind('control.open_session')).toHaveLength(1);
  });

  it('resumes normally when no card on this phone knows the session', async () => {
    await h!.manager.addByQr(listenerQr('listener-5'));
    await h!.flush();
    const listener = registry.get('listener-5');
    await liveCard('unrelated', 'sid-other');

    await h!.manager.resumeSession('listener-5', {
      sessionId: 'sid-brand-new',
      mode: 'allow-all',
      title: 'Elsewhere',
      cwd: 'C:\\repo\\weft',
    });
    await h!.flush();

    expect(listener!.sentOfKind('control.open_session')).toHaveLength(1);
  });

  it('reconnects an archived card first, and only resumes if it does not come back', async () => {
    await h!.manager.addByQr(listenerQr('listener-6'));
    await h!.flush();
    const listener = registry.get('listener-6');
    await liveCard('napping', 'sid-7');
    h!.manager.archive('napping');
    await h!.flush();
    expect(h!.byChannel('napping')?.cold).toBe(true);

    const pending = h!.manager.resumeSession('listener-6', {
      sessionId: 'sid-7',
      mode: 'allow-all',
      title: 'Fix the bug',
      cwd: 'C:\\repo\\weft',
    });
    await h!.flush();

    // Reconnect is tried first: it keeps the transcript on the same card and cannot fork a process.
    expect(h!.snapshot().activeId).toBe('napping');
    expect(h!.byChannel('napping')?.status).toBe('connecting');
    expect(listener!.sentOfKind('control.open_session')).toHaveLength(0);

    // The laptop never confirms the session, so the pairing really is dead — now a resume is the
    // only way back, and the ladder falls through to it.
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;

    expect(listener!.sentOfKind('control.open_session')).toHaveLength(1);
  });
});

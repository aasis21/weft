import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    await h!.manager.refreshSessions('listener-1');
    await h!.flush();
    expect(listener!.sentOfKind('control.session_list_request')).toHaveLength(1);
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

    // Resume it — spawns an Initializing card and sends RESUME_SESSION (not SPAWN_SESSION).
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
    const resume = listener!.sentOfKind('control.resume_session')[0];
    expect(resume).toMatchObject({ sessionId: 'sid-42', mode: 'allow-all' });
    expect(listener!.sentOfKind('control.spawn_session')).toHaveLength(0);

    // The laptop replies with the resumed session's pairing material (reusing the spawn path).
    listener!.emit(
      B.spawnPairing(
        resume.requestId as string,
        { v: 1, channelId: 'resumed-1', pub: 'resumed-pub', kind: 'session', transport: { kind: 'local' } },
        null,
        null,
      ),
    );
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
    expect(deviceEvents.some((e) => e.eventSubtype === 'resume_session')).toBe(true);
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

    const resume = listener!.sentOfKind('control.resume_session')[0];
    listener!.emit(B.spawnResult(resume.requestId as string, false, 'That session no longer exists.'));
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(tempId);
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toBe('That session no longer exists.');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';
import { failNextPairing, pairingIdentities, registry } from '@/test/helpers/fakeWeftClient';
import { loadPendingOperations } from '@/lib/pendingOperations';
import * as B from '@/test/helpers/builders';
import { firstMessageTitle } from '@/session/runtime/sessionRuntime';

function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'local' },
  });
}

function sessionPayload(channelId: string) {
  return {
    v: 1 as const,
    channelId,
    pub: `${channelId}-pub`,
    kind: 'session' as const,
    transport: { kind: 'local' as const },
  };
}

describe('firstMessageTitle', () => {
  it('collapses whitespace and cuts a long first message on a word boundary', () => {
    expect(firstMessageTitle('  Fix   the\n flaky test ')).toBe('Fix the flaky test');
    expect(firstMessageTitle('Investigate why the nightly build fails on the Windows agents only')).toBe('Investigate why the nightly build fails…');
    expect(firstMessageTitle('   ')).toBeUndefined();
  });
});

describe('scenario: phone-launched sessions (protocol v3)', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
  });

  it('registers a listener, opens a new session by target, pairs from lifecycle_status, handles failure, and forgets the device', async () => {
    const route = await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();

    expect(route).toBe('listener:listener-1');
    const listener = registry.get('listener-1');
    expect(listener).toBeDefined();
    expect(listener!.sentOfKind('control.project_list_request')).toHaveLength(1);

    listener!.emit(B.projectList([
      { name: 'weft', path: 'C:\\Users\\akash\\weft', isDefault: true },
      { name: 'cortex', path: 'C:\\Users\\akash\\cortex' },
    ], 'Akash Laptop'));
    await h!.flush();

    expect(h!.snapshot().devices[0]).toMatchObject({
      channelId: 'listener-1',
      name: 'Akash Laptop',
      projects: [{ name: 'weft', path: 'C:\\Users\\akash\\weft', isDefault: true }, { name: 'cortex', path: 'C:\\Users\\akash\\cortex' }],
      connected: true,
    });

    const tempId = await h!.manager.spawnSession('listener-1', {
      projectName: 'weft',
      mode: 'allow-all',
      name: 'Phone launch',
    });
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(tempId);
    expect(h!.active()?.status).toBe('initializing');
    const open = listener!.sentOfKind('control.open_session')[0]!;
    // Target only: no action, no takeover flag — Station decides.
    expect(open).toEqual({
      requestId: expect.any(String),
      target: { project: 'weft' },
      options: { permissionMode: 'allow-all', title: 'Phone launch' },
    });
    expect(listener!.sentOfKind('control.spawn_session')).toHaveLength(0);

    listener!.emit(B.lifecycleStatus({
      requestId: open.requestId as string,
      revision: 1,
      stage: 'dispatching',
      result: { action: 'start' },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();
    expect(h!.byChannel(tempId)?.spawning?.stage).toBe('launched');

    listener!.emit(B.lifecycleStatus({
      requestId: open.requestId as string,
      revision: 2,
      stage: 'preparing-link',
      result: { action: 'start', name: 'Phone launch', payload: sessionPayload('spawned-1') },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe('spawned-1');
    expect(h!.byChannel(tempId)).toBeUndefined();
    expect(h!.active()?.meta.title).toBe('Phone launch');
    expect(h!.active()?.status).toBe('connecting');
    expect(registry.get('spawned-1')?.sentOfKind('control.state_request')).toHaveLength(1);
    expect(h!.active()?.meta.spawnedFromDeviceId).toBe('listener-1');
    expect(h!.active()?.meta.spawnedFromDeviceName).toBe('Akash Laptop');

    // The device event log records the v3 open request and its lifecycle replies, but never the
    // (noisy, liveness-only) DEVICE_HEARTBEAT.
    const deviceEvents = h!.snapshot().devices[0]!.events;
    expect(deviceEvents.some((e) => e.eventSubtype === 'project_list_request')).toBe(true);
    expect(deviceEvents.some((e) => e.eventSubtype === 'open_session')).toBe(true);
    expect(deviceEvents.some((e) => e.eventSubtype === 'lifecycle_status')).toBe(true);
    expect(deviceEvents.some((e) => e.eventSubtype === 'device_heartbeat')).toBe(false);

    const failedTempId = await h!.manager.spawnSession('listener-1', {
      projectName: 'cortex',
      mode: 'default',
    });
    await h!.flush();
    const failedOpen = listener!.sentOfKind('control.open_session').at(-1)!;
    listener!.emit(B.lifecycleStatus({
      requestId: failedOpen.requestId as string,
      revision: 1,
      stage: 'resolving',
      outcome: 'failed',
      reason: 'not-found',
      result: { message: 'No project named cortex' },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(failedTempId);
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toBe('No project named cortex');

    await h!.manager.forgetDevice('listener-1');
    await h!.flush();

    expect(listener!.sentOfKind('control.forget_device')).toHaveLength(1);
    expect(h!.snapshot().devices).toHaveLength(0);
  });

  it('shows a first message as queued while launching and sends it once through the normal sender on pairing', async () => {
    await h!.manager.addByQr(listenerQr('listener-write-first'));
    await h!.flush();
    const listener = registry.get('listener-write-first')!;
    listener.emit(B.projectList([{ name: 'weft', path: 'C:\\weft', isDefault: true }], 'Laptop'));
    await h!.flush();

    const tempId = await h!.manager.spawnSession('listener-write-first', {
      projectName: 'weft',
      mode: 'default',
      initialPrompt: '  Fix the flaky test  ',
    });
    await h!.flush();

    expect(h!.byChannel(tempId)?.timeline.items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'Fix the flaky test', delivery: 'enqueue' }),
    ]);
    expect((await loadPendingOperations())[0]).toMatchObject({ initialPrompt: 'Fix the flaky test' });
    expect(h!.byChannel(tempId)?.meta.title).toBe('Fix the flaky test');

    const open = listener.sentOfKind('control.open_session')[0]!;
    // Launched under the first message so the laptop's title matches until Copilot names it.
    expect(open).toMatchObject({ options: { title: 'Fix the flaky test' } });
    listener.emit(B.lifecycleStatus({
      requestId: open.requestId as string,
      revision: 1,
      stage: 'preparing-link',
      result: { action: 'start', payload: sessionPayload('spawned-write-first') },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    const session = registry.get('spawned-write-first')!;
    expect(session.sentOfKind('prompt.prompt')).toEqual([
      expect.objectContaining({ text: 'Fix the flaky test' }),
    ]);
    expect(h!.active()?.timeline.items).toEqual([
      expect.objectContaining({ kind: 'user', text: 'Fix the flaky test' }),
    ]);
    expect(h!.active()?.timeline.items[0]).not.toHaveProperty('promptFailed', true);
    expect(await loadPendingOperations()).toHaveLength(0);
  });

  it('resumes an existing session by target and gives way to the card Station repaired in place', async () => {
    await h!.manager.addByQr(listenerQr('listener-existing'));
    await h!.flush();
    const listener = registry.get('listener-existing')!;
    const { client } = await h!.pair('kept-card');
    client.emit(B.channelUp('kept-card', 'session-kept', 'C:\\repo', 'Kept'));
    client.emit(B.channelDown('terminal closed'));
    await h!.flush();

    const tempId = await h!.manager.resumeSession('listener-existing', {
      sessionId: 'session-other',
      storeAuthority: 'cli',
      mode: 'default',
      title: 'Other',
      requestId: 'resume-other',
    });
    await h!.flush();
    expect(listener.sentOfKind('control.open_session')).toEqual([{
      requestId: 'resume-other',
      target: { sessionId: 'session-other', storeAuthority: 'cli' },
      options: { permissionMode: 'default', title: null },
    }]);

    listener.emit(B.lifecycleStatus({
      requestId: 'resume-other',
      revision: 3,
      stage: 'preparing-link',
      outcome: 'done',
      result: { action: 'repair', sessionId: 'session-kept' },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();
    expect(h!.byChannel(tempId)).toBeUndefined();
    expect(h!.snapshot().activeId).toBe('kept-card');
    expect(await loadPendingOperations()).toHaveLength(0);
  });

  it('treats a pre-v3 Station reply as "update Weft on your laptop" and fails the launch honestly', async () => {
    await h!.manager.addByQr(listenerQr('listener-old'));
    await h!.flush();
    const listener = registry.get('listener-old')!;
    const tempId = await h!.manager.spawnSession('listener-old', { projectName: 'weft', mode: 'default' });
    await h!.flush();
    const open = listener.sentOfKind('control.open_session')[0]!;

    listener.emit(B.spawnResult(open.requestId as string, false, 'Unknown request'));
    await h!.flush();

    expect(h!.snapshot().devices[0]).toMatchObject({ updateRequired: 'laptop' });
    expect(h!.byChannel(tempId)?.status).toBe('error');
    expect(h!.byChannel(tempId)?.error).toBe('Weft on your laptop needs an update.');
  });

  it('marks the device update-required when Station says so', async () => {
    await h!.manager.addByQr(listenerQr('listener-update'));
    await h!.flush();
    const listener = registry.get('listener-update')!;
    listener.emit(B.updateRequired({ side: 'phone', peerVersion: 2 }));
    await h!.flush();
    expect(h!.snapshot().devices[0]).toMatchObject({
      updateRequired: 'phone',
      error: 'Update Weft on this phone to keep using this session.',
    });
  });

  it('keeps a slow launch recoverable, retries the same request, and accepts late pairing', async () => {
    await h!.manager.addByQr(listenerQr('listener-timeout'));
    await h!.flush();
    const listener = registry.get('listener-timeout')!;
    const tempId = await h!.manager.spawnSession('listener-timeout', {
      projectName: 'weft',
      mode: 'default',
    });
    await h!.flush();
    const first = listener.sentOfKind('control.open_session')[0]!;

    await vi.advanceTimersByTimeAsync(30_000);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(tempId);
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toContain('has not answered yet');
    expect(await loadPendingOperations()).toHaveLength(1);

    await h!.manager.retrySpawn(tempId);
    await h!.flush();
    const requests = listener.sentOfKind('control.open_session');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requestId).toBe(first.requestId);

    listener.emit(B.lifecycleStatus({
      requestId: first.requestId as string,
      revision: 2,
      stage: 'preparing-link',
      result: { action: 'start', payload: sessionPayload('late-session') },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe('late-session');
    expect(h!.byChannel(tempId)).toBeUndefined();
    expect(pairingIdentities).toHaveLength(1);
    expect(await loadPendingOperations()).toHaveLength(0);
  });

  it('restores an unresolved launch after restart, asks Station for its status, and never redelivers it automatically', async () => {
    await h!.manager.addByQr(listenerQr('listener-restart'));
    await h!.flush();
    const firstListener = registry.get('listener-restart')!;
    const tempId = await h!.manager.spawnSession('listener-restart', {
      projectName: 'weft',
      mode: 'default',
    });
    await h!.flush();
    const requestId = firstListener.sentOfKind('control.open_session')[0]!.requestId;

    h!.dispose();
    h = makeManager();
    await h!.init();
    await h!.flush();

    expect(h!.byChannel(tempId)?.status).toBe('initializing');
    const reconnectedListener = registry.get('listener-restart')!;
    expect(reconnectedListener.sentOfKind('control.open_session')).toHaveLength(0);
    expect(reconnectedListener.sentOfKind('control.lifecycle_status_request')).toEqual([{ requestId }]);

    await h!.manager.retrySpawn(tempId);
    await h!.flush();
    expect(reconnectedListener.sentOfKind('control.open_session')[0]!.requestId).toBe(requestId);
  });

  it('reuses the same phone identity when a ready session needs another pairing attempt', async () => {
    await h!.manager.addByQr(listenerQr('listener-pair-retry'));
    await h!.flush();
    const listener = registry.get('listener-pair-retry')!;
    const tempId = await h!.manager.spawnSession('listener-pair-retry', {
      projectName: 'weft',
      mode: 'default',
    });
    await h!.flush();
    const request = listener.sentOfKind('control.open_session')[0]!;

    failNextPairing();
    listener.emit(B.lifecycleStatus({
      requestId: request.requestId as string,
      revision: 1,
      stage: 'preparing-link',
      result: { action: 'start', payload: sessionPayload('pair-retry-session') },
    }));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(h!.byChannel(tempId)?.status).toBe('error');
    expect(pairingIdentities).toHaveLength(1);
    const firstIdentity = pairingIdentities[0];

    await h!.manager.retrySpawn(tempId);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe('pair-retry-session');
    expect(pairingIdentities).toHaveLength(2);
    expect(pairingIdentities[1]).toEqual(firstIdentity);
  });

  it('preserves the accepted request and phone identity across an app reload', async () => {
    await h!.manager.addByQr(listenerQr('listener-pair-reload'));
    await h!.flush();
    const listener = registry.get('listener-pair-reload')!;
    const tempId = await h!.manager.spawnSession('listener-pair-reload', {
      projectName: 'weft',
      mode: 'default',
      requestId: 'reload-operation',
    });
    await h!.flush();
    const payload = sessionPayload('pair-reload-session');

    failNextPairing();
    listener.emit(B.lifecycleStatus({
      requestId: 'reload-operation',
      revision: 1,
      stage: 'preparing-link',
      result: { action: 'start', payload },
    }));
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 5; i += 1) await h!.flush();
    const firstIdentity = pairingIdentities[0];
    expect(firstIdentity).toBeDefined();
    expect(h!.byChannel(tempId)?.status).toBe('error');
    expect(await loadPendingOperations()).toEqual([
      expect.objectContaining({
        requestId: 'reload-operation',
        stage: 'pairing-failed',
        pairingPayload: payload,
        phoneIdentity: firstIdentity,
        lifecycleStatus: expect.objectContaining({ requestId: 'reload-operation', stage: 'preparing-link' }),
      }),
    ]);

    h!.dispose();
    h = makeManager();
    await h!.init();
    for (let i = 0; i < 20 && !h!.byChannel('pair-reload-session'); i += 1) {
      await h!.flush();
    }

    expect(pairingIdentities).toHaveLength(2);
    expect(h!.active()).toMatchObject({
      status: 'connecting',
      meta: { channelId: 'pair-reload-session' },
    });
    expect(pairingIdentities.at(-1)).toEqual(firstIdentity);
  });
});

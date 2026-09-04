import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';
import { failNextPairing, pairingIdentities, registry } from '@/test/helpers/fakeWeftClient';
import { loadPendingOperations } from '@/lib/pendingOperations';
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

describe('scenario: phone-launched sessions', () => {
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

  it('registers a listener, receives projects, spawns a session, handles failure, and forgets the device', async () => {
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
    const spawn = listener!.sentOfKind('control.spawn_session')[0];
    expect(spawn).toMatchObject({ projectName: 'weft', mode: 'allow-all', name: 'Phone launch' });

    listener!.emit(B.spawnPairing(spawn.requestId as string, {
      v: 1,
      channelId: 'spawned-1',
      pub: 'spawned-pub',
      kind: 'session',
      transport: { kind: 'local' },
    }, 'Phone launch', 'weft'));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe('spawned-1');
    expect(h!.byChannel(tempId)).toBeUndefined();
    expect(h!.active()?.meta.title).toBe('Phone launch');
    expect(h!.active()?.status).toBe('connecting');
    expect(registry.get('spawned-1')?.sentOfKind('control.state_request')).toHaveLength(1);
    expect(h!.active()?.meta.spawnedFromDeviceId).toBe('listener-1');
    expect(h!.active()?.meta.spawnedFromDeviceName).toBe('Akash Laptop');

    // The device event log records the outbound project-list-request + spawn-session and the inbound
    // project-list + spawn-pairing, but never the (noisy, liveness-only) DEVICE_HEARTBEAT.
    const deviceEvents = h!.snapshot().devices[0]!.events;
    expect(deviceEvents.some((e) => e.eventSubtype === 'project_list_request')).toBe(true);
    expect(deviceEvents.some((e) => e.eventSubtype === 'spawn_session')).toBe(true);
    expect(deviceEvents.some((e) => e.eventSubtype === 'spawn_pairing')).toBe(true);
    expect(deviceEvents.some((e) => e.eventSubtype === 'device_heartbeat')).toBe(false);

    const failedTempId = await h!.manager.spawnSession('listener-1', {
      projectName: 'cortex',
      mode: 'default',
    });
    await h!.flush();
    const failedSpawn = listener!.sentOfKind('control.spawn_session').at(-1)!;
    listener!.emit(B.spawnResult(failedSpawn.requestId as string, false, 'No project named cortex'));
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(failedTempId);
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toBe('No project named cortex');

    await h!.manager.forgetDevice('listener-1');
    await h!.flush();

    expect(listener!.sentOfKind('control.forget_device')).toHaveLength(1);
    expect(h!.snapshot().devices).toHaveLength(0);
  });

  it('keeps a slow launch recoverable, retries the same operation, and accepts late pairing', async () => {
    await h!.manager.addByQr(listenerQr('listener-timeout'));
    await h!.flush();
    const listener = registry.get('listener-timeout')!;
    const tempId = await h!.manager.spawnSession('listener-timeout', {
      projectName: 'weft',
      mode: 'default',
    });
    await h!.flush();
    const first = listener.sentOfKind('control.spawn_session')[0]!;

    await vi.advanceTimersByTimeAsync(30_000);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(tempId);
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toContain('has not answered yet');
    expect(await loadPendingOperations()).toHaveLength(1);

    await h!.manager.retrySpawn(tempId);
    await h!.flush();
    const requests = listener.sentOfKind('control.spawn_session');
    expect(requests).toHaveLength(2);
    expect(requests[1]!.requestId).toBe(first.requestId);

    listener.emit(B.spawnPairing(first.requestId as string, {
      v: 1,
      channelId: 'late-session',
      pub: 'late-pub',
      kind: 'session',
      transport: { kind: 'local' },
    }, null, 'weft'));
    await vi.advanceTimersByTimeAsync(0);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe('late-session');
    expect(h!.byChannel(tempId)).toBeUndefined();
    expect(pairingIdentities).toHaveLength(1);
    expect(await loadPendingOperations()).toHaveLength(0);
  });

  it('restores an unresolved launch after restart without redelivering it automatically', async () => {
    await h!.manager.addByQr(listenerQr('listener-restart'));
    await h!.flush();
    const firstListener = registry.get('listener-restart')!;
    const tempId = await h!.manager.spawnSession('listener-restart', {
      projectName: 'weft',
      mode: 'default',
    });
    await h!.flush();
    const requestId = firstListener.sentOfKind('control.spawn_session')[0]!.requestId;

    h!.dispose();
    h = makeManager();
    await h!.init();
    await h!.flush();

    expect(h!.byChannel(tempId)?.status).toBe('initializing');
    const reconnectedListener = registry.get('listener-restart')!;
    expect(reconnectedListener.sentOfKind('control.spawn_session')).toHaveLength(0);

    await h!.manager.retrySpawn(tempId);
    await h!.flush();
    expect(reconnectedListener.sentOfKind('control.spawn_session')[0]!.requestId).toBe(requestId);
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
    const request = listener.sentOfKind('control.spawn_session')[0]!;
    const payload = {
      v: 1 as const,
      channelId: 'pair-retry-session',
      pub: 'pair-retry-pub',
      kind: 'session' as const,
      transport: { kind: 'local' as const },
    };

    failNextPairing();
    listener.emit(B.launchStatus(request.requestId as string, 'ready', { payload, operation: 'new' }));
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeManager } from '@/test/helpers/makeManager';
import { registry } from '@/test/helpers/fakeHelmClient';
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
      { name: 'helm', path: 'C:\\Users\\akash\\helm', isDefault: true },
      { name: 'cortex', path: 'C:\\Users\\akash\\cortex' },
    ], 'Akash Laptop'));
    await h!.flush();

    expect(h!.snapshot().devices[0]).toMatchObject({
      channelId: 'listener-1',
      name: 'Akash Laptop',
      projects: [{ name: 'helm', path: 'C:\\Users\\akash\\helm', isDefault: true }, { name: 'cortex', path: 'C:\\Users\\akash\\cortex' }],
      connected: true,
    });

    const tempId = await h!.manager.spawnSession('listener-1', {
      projectName: 'helm',
      mode: 'allow-all',
      name: 'Phone launch',
    });
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(tempId);
    expect(h!.active()?.status).toBe('initializing');
    const spawn = listener!.sentOfKind('control.spawn_session')[0];
    expect(spawn).toMatchObject({ projectName: 'helm', mode: 'allow-all', name: 'Phone launch' });

    listener!.emit(B.spawnPairing(spawn.requestId as string, {
      v: 1,
      channelId: 'spawned-1',
      pub: 'spawned-pub',
      kind: 'session',
      transport: { kind: 'local' },
    }, 'Phone launch', 'helm'));
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

  it('fails an initializing card if the listener never returns pairing material', async () => {
    await h!.manager.addByQr(listenerQr('listener-timeout'));
    await h!.flush();
    const tempId = await h!.manager.spawnSession('listener-timeout', {
      projectName: 'helm',
      mode: 'default',
    });

    await vi.advanceTimersByTimeAsync(30_000);
    await h!.flush();

    expect(h!.snapshot().activeId).toBe(tempId);
    expect(h!.active()?.status).toBe('error');
    expect(h!.active()?.error).toContain('Timed out');
  });
});

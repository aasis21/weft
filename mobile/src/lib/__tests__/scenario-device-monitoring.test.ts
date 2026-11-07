import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { App } from '@capacitor/app';
import { registry } from '@/test/helpers/fakeWeftClient';
import { makeManager } from '@/test/helpers/makeManager';
import { loadDevices } from '@/lib/devices';
import * as B from '@/test/helpers/builders';
import { ATTENTION_CAPABILITY, WATCH_RENEW_MS } from '@aasis21/weft-shared';

function listenerQr(channelId: string): string {
  return JSON.stringify({
    v: 1,
    channelId,
    pub: `listener-pub-${channelId}`,
    kind: 'listener',
    transport: { kind: 'devtunnel', url: 'wss://relay.example.ms' },
  });
}

function snapshot(monitorId: string, sequence: number, capturedAt = Date.now()) {
  return B.deviceSnapshot({
    monitorId,
    sequence,
    capturedAt,
    effectiveIntervalMs: 10_000,
    leaseExpiresAt: capturedAt + 45_000,
    system: {
      cpuPercent: 25,
      memoryUsedBytes: 4,
      memoryTotalBytes: 8,
      uptimeSeconds: 60,
      diskUsedBytes: 5,
      diskTotalBytes: 10,
      batteryPercent: null,
      batteryCharging: null,
    },
    apps: [],
    observedAt: { system: capturedAt, disk: capturedAt, battery: null, apps: capturedAt },
    issues: [],
  });
}

describe('scenario: device monitoring', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    h = makeManager();
  });

  afterEach(() => {
    h?.dispose();
    vi.useRealTimers();
  });

  it('leases Station compact by default, details only for monitoring, and stops all refresh on hide', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-attention'));
    const client = registry.get('listener-attention')!;
    client.emit(B.projectList([], 'Devbox', null, [ATTENTION_CAPABILITY, 'device-monitor-v1']));
    expect(client.sentOfKind('control.watch_request').at(-1)?.level).toBe('compact');
    h!.manager.startDeviceMonitoring('listener-attention');
    expect(client.sentOfKind('control.watch_request').at(-1)?.level).toBe('detail');
    window.dispatchEvent(new Event('pagehide'));
    expect(client.sentOfKind('control.watch_request').at(-1)?.level).toBe('off');
    expect(client.sentOfKind('control.device_monitor_stop')).toHaveLength(1);
    client.clearSent();
    await vi.advanceTimersByTimeAsync(WATCH_RENEW_MS * 4);
    expect(client.sentOfKind('control.watch_request')).toHaveLength(0);
    expect(client.sentOfKind('control.device_monitor_start')).toHaveLength(0);
    expect(h!.snapshot().devices[0]?.connected).toBe(true);
    window.dispatchEvent(new Event('pageshow'));
    expect(client.sentOfKind('control.watch_request').at(-1)?.level).toBe('compact');
  });

  it('removes a native foreground listener even when its registration settles after disposal', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    let register!: (handle: { remove: typeof remove }) => void;
    vi.mocked(App.addListener).mockImplementationOnce(() => new Promise((resolve) => { register = resolve; }));
    await h!.init();
    h!.dispose();
    register({ remove });
    await h!.flush();
    expect(remove).toHaveBeenCalledOnce();
  });

  it('gates by capability, renews one lease, stops it, and accepts only ordered matching snapshots', async () => {
    await h!.init();
    await h!.manager.addByQr(listenerQr('listener-1'));
    await h!.flush();
    const client = registry.get('listener-1')!;

    h!.manager.startDeviceMonitoring('listener-1');
    expect(client.sentOfKind('control.device_monitor_start')).toHaveLength(0);

    client.emit(B.projectList([], 'Devbox', null, ['device-monitor-v1']));
    await h!.flush();

    h!.manager.startDeviceMonitoring('listener-1');
    await h!.flush();
    const starts = client.sentOfKind('control.device_monitor_start');
    expect(starts).toHaveLength(1);
    const monitorId = starts[0]!.monitorId as string;

    h!.manager.startDeviceMonitoring('listener-1');
    await h!.flush();
    expect(client.sentOfKind('control.device_monitor_start')).toHaveLength(2);
    expect(client.sentOfKind('control.device_monitor_start')[1]!.monitorId).toBe(monitorId);
    expect(client.sentOfKind('control.device_monitor_stop')).toHaveLength(0);

    client.emit(snapshot('old-monitor', 100));
    client.emit(snapshot(monitorId, 2));
    client.emit(snapshot(monitorId, 1));
    await h!.flush();
    expect(h!.snapshot().devices[0]!.monitoring?.snapshot?.sequence).toBe(2);
    expect(h!.snapshot().devices[0]!.cachedHealth).toMatchObject({
      capturedAt: Date.now(),
      system: { cpuPercent: 25 },
    });
    expect((await loadDevices())[0]!.cachedHealth).toMatchObject({
      capturedAt: Date.now(),
      effectiveIntervalMs: 10_000,
      system: { cpuPercent: 25 },
      issues: [],
    });
    expect((await loadDevices())[0]!.cachedHealth).not.toHaveProperty('apps');
    const snapshotEvents = h!.snapshot().devices[0]!.events.filter(
      (event) => event.eventSubtype === 'device_snapshot',
    );
    expect(snapshotEvents).toHaveLength(1);
    expect(snapshotEvents[0]!.msg).toMatchObject({ monitorId, sequence: 1 });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(client.sentOfKind('control.device_monitor_start')).toHaveLength(3);
    expect(client.sentOfKind('control.device_monitor_start')[2]!.monitorId).toBe(monitorId);

    vi.setSystemTime(new Date('2026-01-01T00:01:20Z'));
    h!.manager.startDeviceMonitoring('listener-1');
    await h!.flush();
    const restarted = client.sentOfKind('control.device_monitor_start').at(-1)!.monitorId as string;
    expect(restarted).not.toBe(monitorId);

    h!.manager.stopDeviceMonitoring('listener-1');
    await h!.flush();
    expect(client.sentOfKind('control.device_monitor_stop')).toEqual([{ monitorId: restarted }]);
    expect(h!.snapshot().devices[0]!.monitoring).toBeUndefined();
    expect(h!.snapshot().devices[0]!.cachedHealth?.system.cpuPercent).toBe(25);
  });
});

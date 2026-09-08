import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@capacitor/app';
import {
  CLIPBOARD_MAX_BYTES, DEVICE_CAPABILITY, KEEP_AWAKE_MIN_MS, KEEP_AWAKE_MAX_MS,
  clipboardResult, deviceSnapshot, keepAwakeStatus, projectList,
  type KeepAwakeStatusMsg,
} from '@aasis21/weft-shared';
import { makeManager } from '@/test/helpers/makeManager';
import { loadDevices } from '@/lib/devices';
import { loadEventLog, saveEventLog, toDebugEvent } from '@/lib/eventLog';
import { memoryPreferences, peekPreference } from '@/test/helpers/mockPreferences';

const channelId = 'utility-station';
const capabilities = [DEVICE_CAPABILITY.CLIPBOARD_V1, DEVICE_CAPABILITY.KEEP_AWAKE_V1];

describe('scenario: explicit device utilities', () => {
  let h: ReturnType<typeof makeManager>;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T00:00:00Z'));
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    h = makeManager();
  });
  afterEach(() => {
    h.dispose();
    vi.useRealTimers();
  });

  const device = () => h.snapshot().devices.find((item) => item.channelId === channelId)!;
  async function connect(flags: string[] = capabilities) {
    await h.init();
    await h.manager.addByQr(JSON.stringify({
      v: 1, channelId, pub: 'public-station-key', kind: 'listener',
      transport: { kind: 'devtunnel', url: 'wss://relay.example.ms' },
    }));
    await h.flush();
    const client = h.client(channelId);
    client.emit(projectList([], 'Laptop', null, flags));
    await h.flush();
    const query = client.sentOfKind('control.keep_awake_status_request').at(-1);
    if (query && typeof query.requestId === 'string') client.emit(keepAwakeStatus(query.requestId));
    await h.flush();
    return client;
  }

  it('does not read on open, gates each capability separately, and never sends while offline', async () => {
    const client = await connect([]);
    h.manager.openDeviceClipboard(channelId);
    expect(client.sentOfKind('control.clipboard_read')).toHaveLength(0);
    h.manager.readDeviceClipboard(channelId);
    expect(device().clipboard?.code).toBe('unsupported');
    h.manager.startDeviceKeepAwake(channelId, KEEP_AWAKE_MIN_MS);
    expect(device().keepAwake?.code).toBe('unsupported');
    expect(client.sentOfKind('control.keep_awake_start')).toHaveLength(0);
    client.emit(projectList([], 'Laptop', null, [DEVICE_CAPABILITY.CLIPBOARD_V1]));
    h.manager.readDeviceClipboard(channelId);
    expect(client.sentOfKind('control.clipboard_read')).toHaveLength(1);
    expect(client.sentOfKind('control.keep_awake_status_request')).toHaveLength(0);
    client.setStatus('disconnected');
    h.manager.openDeviceClipboard(channelId);
    h.manager.writeDeviceClipboard(channelId, 'not sent offline');
    expect(device().clipboard?.code).toBe('unavailable');
    expect(client.sentOfKind('control.clipboard_write')).toHaveLength(0);
  });

  it('correlates exact Unicode reads, ignores wrong operations and duplicates, and redacts persistence', async () => {
    const client = await connect();
    h.manager.openDeviceClipboard(channelId);
    h.manager.readDeviceClipboard(channelId);
    h.manager.readDeviceClipboard(channelId);
    const reads = client.sentOfKind('control.clipboard_read');
    expect(reads).toHaveLength(1);
    const id = String(reads[0]!.requestId);
    client.emit(clipboardResult('old', 'read', 'ok', 'old private text'));
    client.emit(clipboardResult(id, 'write', 'ok'));
    expect(device().clipboard?.pending).toBe(true);
    const text = 'private clipboard \u{1f600}\r\n $() "\' \t';
    client.emit(clipboardResult(id, 'read', 'ok', text));
    expect(device().clipboard).toMatchObject({ pending: false, operation: 'read', code: 'ok', text });
    client.emit(clipboardResult(id, 'read', 'ok', 'duplicate'));
    expect(device().clipboard?.text).toBe(text);
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(device().events)).not.toContain(text);
    expect((await loadEventLog(channelId)).filter((event) => event.eventSubtype.startsWith('clipboard_')))
      .toEqual(expect.arrayContaining([expect.objectContaining({ msg: { redacted: true } })]));
    expect(JSON.stringify(await loadDevices())).not.toContain(text);
    expect(JSON.stringify((await memoryPreferences.keys()).keys.map(peekPreference))).not.toContain('private clipboard');
    expect(JSON.stringify({ ...localStorage })).not.toContain('private clipboard');
  });

  it('writes explicit exact text including empty text, and rejects multibyte overflow without sending', async () => {
    const client = await connect();
    h.manager.openDeviceClipboard(channelId);
    const text = '\u{1f600}'.repeat(CLIPBOARD_MAX_BYTES / 4);
    h.manager.writeDeviceClipboard(channelId, `${text}x`);
    expect(device().clipboard?.code).toBe('too-large');
    expect(client.sentOfKind('control.clipboard_write')).toHaveLength(0);
    h.manager.writeDeviceClipboard(channelId, text);
    const write = client.sentOfKind('control.clipboard_write')[0]!;
    expect(write.text).toBe(text);
    client.emit({ ...clipboardResult(String(write.requestId), 'write', 'ok'), msg: {
      requestId: String(write.requestId), operation: 'write', code: 'ok', text: 'must not echo writes',
    } });
    expect(device().clipboard?.text).toBeUndefined();
    h.manager.writeDeviceClipboard(channelId, '');
    expect(client.sentOfKind('control.clipboard_write')[1]!.text).toBe('');
    expect(JSON.stringify(device().events)).not.toContain('must not echo');
  });

  it('bounds inbound clipboard results and sanitizes transport failures', async () => {
    const client = await connect();
    h.manager.openDeviceClipboard(channelId);
    h.manager.readDeviceClipboard(channelId);
    const requestId = String(client.sentOfKind('control.clipboard_read')[0]!.requestId);
    client.emit({ ...clipboardResult(requestId, 'read', 'ok', ''), msg: {
      requestId, operation: 'read', code: 'ok', text: '\u{1f600}'.repeat(CLIPBOARD_MAX_BYTES / 4 + 1),
    } });
    expect(device().clipboard).toMatchObject({ pending: false, code: 'too-large' });
    expect(device().clipboard?.text).toBeUndefined();
    vi.spyOn(client, 'send').mockRejectedValueOnce(new Error('secret clipboard contents'));
    h.manager.writeDeviceClipboard(channelId, 'private input');
    await h.flush();
    expect(device().clipboard?.code).toBe('unavailable');
    expect(JSON.stringify(device())).not.toContain('secret clipboard contents');
  });

  it('clears sheet state on close, rejects delayed results after reopen, and times out without replay', async () => {
    const client = await connect();
    h.manager.openDeviceClipboard(channelId);
    h.manager.readDeviceClipboard(channelId);
    const oldId = String(client.sentOfKind('control.clipboard_read')[0]!.requestId);
    h.manager.closeDeviceClipboard(channelId);
    client.emit(clipboardResult(oldId, 'read', 'ok', 'discarded'));
    expect(device().clipboard).toBeUndefined();
    h.manager.openDeviceClipboard(channelId);
    h.manager.readDeviceClipboard(channelId);
    client.emit(clipboardResult(oldId, 'read', 'ok', 'old request'));
    expect(device().clipboard?.pending).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device().clipboard).toMatchObject({ pending: false, code: 'timeout' });
    const currentId = String(client.sentOfKind('control.clipboard_read')[1]!.requestId);
    client.emit(clipboardResult(currentId, 'read', 'ok', 'too late'));
    expect(device().clipboard?.text).toBeUndefined();
    expect(client.sentOfKind('control.clipboard_read')).toHaveLength(2);
  });

  it('clears clipboard on page hide and disconnect without stopping the station lease', async () => {
    const client = await connect();
    h.manager.openDeviceClipboard(channelId);
    h.manager.readDeviceClipboard(channelId);
    const id = String(client.sentOfKind('control.clipboard_read')[0]!.requestId);
    client.emit(clipboardResult(id, 'read', 'ok', 'secret'));
    window.dispatchEvent(new Event('pagehide'));
    expect(device().clipboard).toBeUndefined();
    h.manager.openDeviceClipboard(channelId);
    client.setStatus('disconnected');
    expect(device().clipboard).toBeUndefined();
    expect(device().keepAwake).toBeUndefined();
    expect(client.sentOfKind('control.keep_awake_stop')).toHaveLength(0);
  });

  it('clears clipboard on native background and document hide but not foreground visibility changes', async () => {
    let nativeState: ((state: { isActive: boolean }) => void) | undefined;
    const addAppStateListener: (
      name: 'appStateChange', callback: (state: { isActive: boolean }) => void,
    ) => ReturnType<typeof App.addListener> = App.addListener;
    vi.mocked(addAppStateListener).mockImplementation((_name, callback) => {
      nativeState = callback;
      return Promise.resolve({ remove: vi.fn() });
    });
    const client = await connect();
    h.manager.openDeviceClipboard(channelId);
    document.dispatchEvent(new Event('visibilitychange'));
    expect(device().clipboard).toBeDefined();
    nativeState?.({ isActive: false });
    expect(device().clipboard).toBeUndefined();
    h.manager.openDeviceClipboard(channelId);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    document.dispatchEvent(new Event('visibilitychange'));
    expect(device().clipboard).toBeUndefined();
    expect(client.sentOfKind('control.clipboard_read')).toHaveLength(0);
    expect(client.sentOfKind('control.keep_awake_stop')).toHaveLength(0);
  });

  it('accepts authoritative start/extend/stop and filters stale correlated and unsolicited statuses', async () => {
    const client = await connect();
    h.manager.startDeviceKeepAwake(channelId, KEEP_AWAKE_MIN_MS - 1);
    const start = client.sentOfKind('control.keep_awake_start')[0]!;
    expect(start.durationMs).toBe(KEEP_AWAKE_MIN_MS);
    const active = { active: true, leaseId: String(start.leaseId), expiresAt: Date.now() + KEEP_AWAKE_MIN_MS, revision: 1 };
    client.emit(keepAwakeStatus('wrong-request', active));
    expect(device().keepAwake?.pending).toBe(true);
    client.emit(keepAwakeStatus(String(start.requestId), active));
    expect(device().keepAwake).toMatchObject({ pending: false, status: active });
    h.manager.startDeviceKeepAwake(channelId, KEEP_AWAKE_MAX_MS + 100);
    const extend = client.sentOfKind('control.keep_awake_start')[1]!;
    expect(extend.leaseId).toBe(start.leaseId);
    expect(extend.durationMs).toBe(KEEP_AWAKE_MAX_MS);
    client.emit(keepAwakeStatus(String(extend.requestId), { ...active, expiresAt: Date.now() + KEEP_AWAKE_MAX_MS, revision: 2 }));
    client.emit(keepAwakeStatus(null, { active: false, leaseId: active.leaseId, revision: 1 }));
    expect(device().keepAwake?.status?.active).toBe(true);
    h.manager.stopDeviceKeepAwake(channelId);
    const stop = client.sentOfKind('control.keep_awake_stop')[0]!;
    expect(stop.leaseId).toBe(start.leaseId);
    client.emit(keepAwakeStatus(String(stop.requestId), { active: false, leaseId: active.leaseId, revision: 3 }));
    expect(device().keepAwake?.status).toMatchObject({ active: false, expiresAt: null, revision: 3 });
    client.emit(keepAwakeStatus(String(extend.requestId), { ...active, revision: 2 }));
    expect(device().keepAwake?.status?.active).toBe(false);
    expect((await loadDevices())[0]).not.toHaveProperty('keepAwake');
  });

  it('refreshes the lease on reopen, ignores malformed statuses, and receives expiry/failure pushes', async () => {
    const client = await connect();
    h.manager.refreshDeviceKeepAwake(channelId);
    const query = client.sentOfKind('control.keep_awake_status_request').at(-1)!;
    const status = { active: true, leaseId: 'station-lease', expiresAt: Date.now() + KEEP_AWAKE_MIN_MS, revision: 5 };
    const malformed: KeepAwakeStatusMsg = { requestId: String(query.requestId), code: 'ok', ...status, revision: -1 };
    client.emit({ ...keepAwakeStatus(String(query.requestId)), msg: malformed });
    expect(device().keepAwake?.pending).toBe(true);
    client.emit(keepAwakeStatus(String(query.requestId), status));
    client.emit(keepAwakeStatus(null, { leaseId: status.leaseId, active: false, revision: 6, code: 'unavailable' }));
    expect(device().keepAwake?.status).toMatchObject({ active: false, revision: 6, code: 'unavailable' });
    expect(device().keepAwake?.code).toBe('unavailable');
    h.manager.startDeviceKeepAwake(channelId, NaN);
    expect(device().keepAwake?.code).toBe('invalid-request');
    expect(client.sentOfKind('control.keep_awake_start')).toHaveLength(0);
    h.manager.startDeviceKeepAwake(channelId, KEEP_AWAKE_MIN_MS);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(device().keepAwake).toMatchObject({ pending: false, code: 'timeout' });
  });

  it('clears utilities on capability removal, forgetting and shutdown with no lingering timeout', async () => {
    const client = await connect();
    h.manager.openDeviceClipboard(channelId);
    h.manager.readDeviceClipboard(channelId);
    client.emit(projectList([], 'Laptop', null, []));
    expect(device().clipboard).toBeUndefined();
    expect(device().keepAwake).toBeUndefined();
    h.manager.openDeviceClipboard(channelId);
    h.dispose();
    expect(device().clipboard).toBeUndefined();
    expect(device().keepAwake).toBeUndefined();
    await h.manager.forgetDevice(channelId);
    expect(h.snapshot().devices).toHaveLength(0);
  });

  it('caches additive AC power while preserving uptime and excluding clipboard data', async () => {
    const client = await connect([DEVICE_CAPABILITY.MONITOR_V1]);
    h.manager.startDeviceMonitoring(channelId);
    await h.flush();
    const monitor = client.sentOfKind('control.device_monitor_start')[0]!;
    client.emit(deviceSnapshot({
      monitorId: String(monitor.monitorId), sequence: 1, capturedAt: Date.now(), effectiveIntervalMs: 10_000,
      leaseExpiresAt: Date.now() + 45_000,
      system: { cpuPercent: 10, memoryUsedBytes: 1, memoryTotalBytes: 2, diskUsedBytes: 1, diskTotalBytes: 2,
        uptimeSeconds: 123456, batteryPercent: null, batteryCharging: null, onAcPower: true },
      apps: [], observedAt: { system: Date.now(), disk: Date.now(), battery: Date.now(), apps: Date.now() }, issues: [],
    }));
    expect(device().cachedHealth?.system).toMatchObject({ onAcPower: true, uptimeSeconds: 123456 });
    expect((await loadDevices())[0]?.cachedHealth?.system).toMatchObject({ onAcPower: true, uptimeSeconds: 123456 });
  });
});

it('redacts clipboard events even when callers bypass normal runtime event construction', async () => {
  const event = toDebugEvent('in', clipboardResult('r', 'read', 'ok', 'private payload'), 1, 'Laptop');
  expect(event.msg).toEqual({ redacted: true });
  await saveEventLog('privacy', [{ ...event, msg: { text: 'accidentally raw' } }]);
  expect((await loadEventLog('privacy'))[0]?.msg).toEqual({ redacted: true });
  expect(JSON.stringify((await memoryPreferences.keys()).keys.map(peekPreference))).not.toContain('accidentally raw');
});

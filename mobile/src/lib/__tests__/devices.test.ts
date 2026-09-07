import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { vi } from 'vitest';
import { loadDevices, removeDevice, upsertDevice, type RegisteredDevice } from '@/lib/devices';

const device: RegisteredDevice = {
  channelId: 'listener-1',
  pub: 'laptop-public-key',
  transport: { kind: 'local' },
  publicKeyB64: 'phone-public-key',
  privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'private' },
  savedAt: 123,
};

describe('device persistence', () => {
  it('keeps native device keys out of localStorage and removes them from the saved list', async () => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    localStorage.setItem('weft.devices.v1', JSON.stringify({ devices: [device] }));

    await upsertDevice(device);

    expect(localStorage.getItem('weft.devices.v1')).toBeNull();
    expect(await loadDevices()).toEqual([{ ...device, isDefault: true }]);
    expect((await Preferences.get({ key: 'weft.devices.v1' })).value).toContain('"d":"private"');

    await removeDevice(device.channelId);

    expect(await loadDevices()).toEqual([]);
    expect((await Preferences.get({ key: 'weft.devices.v1' })).value).not.toContain('"d":"private"');
    expect(localStorage.getItem('weft.devices.v1')).toBeNull();
  });
});

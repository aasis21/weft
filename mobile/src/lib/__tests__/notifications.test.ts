import { Capacitor } from '@capacitor/core';
import { expect, it, vi } from 'vitest';

const plugin = vi.hoisted(() => ({
  checkPermissions: vi.fn(),
  requestPermissions: vi.fn(),
  createChannel: vi.fn(),
  get then(): never {
    throw new Error('LocalNotifications.then() is not implemented on android');
  },
}));

vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: plugin }));

it('checks native notification permission without awaiting the Capacitor plugin proxy', async () => {
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  plugin.createChannel.mockResolvedValue(undefined);
  plugin.checkPermissions.mockResolvedValue({ display: 'granted' });
  const { ensureNotificationPermission } =
    await vi.importActual<typeof import('@/lib/notifications')>('@/lib/notifications');

  await expect(ensureNotificationPermission()).resolves.toBe(true);
  expect(plugin.checkPermissions).toHaveBeenCalledOnce();
  expect(plugin.requestPermissions).not.toHaveBeenCalled();
});

it('never prompts for permission when an approval alert fires', async () => {
  vi.resetModules();
  vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  plugin.createChannel.mockResolvedValue(undefined);
  plugin.checkPermissions.mockResolvedValue({ display: 'prompt' });
  plugin.requestPermissions.mockClear();
  const { notifyApprovalRequest } =
    await vi.importActual<typeof import('@/lib/notifications')>('@/lib/notifications');

  await notifyApprovalRequest({ requestId: 'r1', toolName: 'shell' } as Parameters<typeof notifyApprovalRequest>[0]);
  expect(plugin.checkPermissions).toHaveBeenCalled();
  expect(plugin.requestPermissions).not.toHaveBeenCalled();
});

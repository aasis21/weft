import type { ListenerDeviceState } from '@/session/model';

export function deviceLabel(device: ListenerDeviceState): string {
  return device.name || `Device ${device.channelId.slice(0, 8)}`;
}

export function deviceStatus(device: ListenerDeviceState): { label: string; tone: 'online' | 'offline' | 'loading' } {
  if (device.projectsLoading) return { label: 'Connecting…', tone: 'loading' };
  if (device.connected) return { label: 'Online', tone: 'online' };
  return { label: 'Offline', tone: 'offline' };
}

export function formatLastSeen(ts?: number): string | null {
  if (!ts) return null;
  const diffMs = Date.now() - ts;
  if (diffMs < 45_000) return 'just now';
  const minutes = Math.round(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

/** Devices sorted online-first, then default, then most-recently-seen — used by both the
 *  single-device StartSessionScreen picker and the full DevicesScreen list. */
export function sortDevices(devices: ListenerDeviceState[]): ListenerDeviceState[] {
  return [...devices].sort(
    (a, b) =>
      Number(b.connected) - Number(a.connected) ||
      Number(b.isDefault) - Number(a.isDefault) ||
      (b.lastSeenAt ?? b.savedAt) - (a.lastSeenAt ?? a.savedAt),
  );
}

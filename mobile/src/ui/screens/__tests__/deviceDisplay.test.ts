import { describe, expect, it } from 'vitest';
import { deviceStatus, formatLastSeen } from '@/ui/screens/deviceDisplay';
import type { ListenerDeviceState } from '@/session/model';

const now = 2_000_000_000_000;

describe('formatLastSeen (injectable now — powers the sidebar last-seen/last-tried clocks)', () => {
  it('returns null when the clock was never set', () => {
    expect(formatLastSeen(undefined, now)).toBeNull();
    expect(formatLastSeen(0, now)).toBeNull();
  });

  it('is deterministic against the injected now, not wall-clock', () => {
    expect(formatLastSeen(now - 10_000, now)).toBe('just now');
    expect(formatLastSeen(now - 5 * 60_000, now)).toBe('5m ago');
    expect(formatLastSeen(now - 3 * 60 * 60_000, now)).toBe('3h ago');
    expect(formatLastSeen(now - 2 * 24 * 60 * 60_000, now)).toBe('2d ago');
  });
});

describe('deviceStatus', () => {
  it('keeps a connected device online while projects are refreshing', () => {
    const device = {
      connected: true,
      projectsLoading: true,
    } as ListenerDeviceState;

    expect(deviceStatus(device)).toEqual({ label: 'Online', tone: 'online' });
  });
});

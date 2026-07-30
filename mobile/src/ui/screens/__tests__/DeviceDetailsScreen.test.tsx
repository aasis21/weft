import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DeviceDetailsScreen } from '../DeviceDetailsScreen';
import { emptyTimeline } from '@/lib/timeline';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';

/** A session spawned by the device under test (`spawnedFromDeviceId` matches its stable deviceId). */
function makeSession(channelId: string, title: string, status: SessionView['status']): SessionView {
  return {
    meta: {
      channelId,
      title,
      cwd: 'C:\\Users\\me\\weft',
      kind: 'live',
      addedAt: Date.now(),
      spawnedFromDeviceId: 'device-1',
    },
    status,
    timeline: emptyTimeline(),
    events: [],
  };
}

function makeDevice(overrides: Partial<ListenerDeviceState> = {}): ListenerDeviceState {
  return {
    channelId: 'chan-1',
    pub: 'pub-1',
    transport: { kind: 'local' },
    publicKeyB64: 'phone-pub-1',
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' } as JsonWebKey,
    name: 'MacBook Pro',
    deviceId: 'device-1',
    isDefault: true,
    savedAt: Date.now(),
    projects: [],
    projectsLoading: false,
    connected: true,
    events: [],
    ...overrides,
  };
}

function renderDetails(overrides: Partial<ComponentProps<typeof DeviceDetailsScreen>> = {}) {
  const props: ComponentProps<typeof DeviceDetailsScreen> = {
    device: makeDevice(),
    activeId: null,
    sessions: [],
    devices: [],
    onRefreshProjects: vi.fn(),
    onResumeOnDevice: vi.fn(),
    onSetDefault: vi.fn().mockResolvedValue(undefined),
    onForget: vi.fn().mockResolvedValue(undefined),
    onStartOnDevice: vi.fn(),
    onOpenDeviceDetails: vi.fn(),
    onJoinOffer: vi.fn(),
    onOpenSession: vi.fn(),
    onSelectSession: vi.fn(),
    onAddSession: vi.fn(),
    onStartSession: vi.fn(),
    onOpenDevices: vi.fn(),
    onRemoveSession: vi.fn(),
    onRenameSession: vi.fn(),
    onGoHome: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DeviceDetailsScreen {...props} />) };
}

describe('DeviceDetailsScreen is device administration, not a second launcher', () => {
  it('sends both ways into a session to the one screen that owns them', () => {
    // The resumable list used to live here, with its own folder filter and its own unlabelled
    // permission toggle — a parallel, subtly different copy of the start flow bolted onto a device
    // admin page. Both routes now go to the same screen, which is where the shared steps live.
    const onStartOnDevice = vi.fn();
    const onResumeOnDevice = vi.fn();
    renderDetails({ onStartOnDevice, onResumeOnDevice });

    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    expect(onStartOnDevice).toHaveBeenCalledWith('chan-1');

    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    expect(onResumeOnDevice).toHaveBeenCalledWith('chan-1');
  });

  it('no longer carries a resumable-session list or a bare permission toggle', () => {
    renderDetails({ device: makeDevice({ sessions: [] }) });
    expect(screen.queryByLabelText(/search recent sessions/i)).toBeNull();
    expect(screen.queryByRole('radio', { name: /allow all/i })).toBeNull();
  });

  it('replaces the launch buttons with an inline reason when the device is offline', () => {
    // These used to be rendered-but-disabled with the explanation hidden in a `title` tooltip,
    // which a touch device never shows.
    renderDetails({ device: makeDevice({ connected: false }) });
    expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull();
    expect(screen.getByText(/run/i).textContent).toMatch(/weft start/);
  });
});

describe('DeviceDetailsScreen header keeps only navigation and defers the rest to a menu', () => {
  it('hides refresh, make default, event log and forget behind the overflow menu', () => {
    renderDetails({ device: makeDevice({ isDefault: false }) });

    expect(screen.queryByRole('menuitem', { name: /refresh projects/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /device actions/i }));
    expect(screen.getByRole('menuitem', { name: /refresh projects/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /make default/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /event log/i })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: /forget device/i })).toBeTruthy();
  });

  it('omits "make default" for the device that already is the default', () => {
    renderDetails({ device: makeDevice({ isDefault: true }) });
    fireEvent.click(screen.getByRole('button', { name: /device actions/i }));
    expect(screen.queryByRole('menuitem', { name: /make default/i })).toBeNull();
  });

  it('makes forget a two-tap action so an unrecoverable unpair is never one stray tap away', () => {
    const onForget = vi.fn().mockResolvedValue(undefined);
    renderDetails({ onForget });

    fireEvent.click(screen.getByRole('button', { name: /device actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /forget device/i }));
    expect(onForget).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('menuitem', { name: /tap again to forget/i }));
    expect(onForget).toHaveBeenCalledWith('chan-1');
  });

  it('offers an explicit way back to the device list', () => {
    const onOpenDevices = vi.fn();
    renderDetails({ onOpenDevices });
    fireEvent.click(screen.getByRole('button', { name: /^devices$/i }));
    expect(onOpenDevices).toHaveBeenCalled();
  });
});

describe('DeviceDetailsScreen session list separates what is running from what is not', () => {
  it('shows active sessions immediately and collapses the rest behind a counted toggle', () => {
    const sessions = [makeSession('live-1', 'Running thing', 'live'), makeSession('done-1', 'Old thing', 'ended')];
    renderDetails({ device: makeDevice({ deviceId: 'device-1' }), sessions });

    expect(screen.getByText('Running thing')).toBeTruthy();
    expect(screen.queryByText('Old thing')).toBeNull();

    const toggle = screen.getByRole('button', { name: /inactive \(1\)/i });
    fireEvent.click(toggle);
    expect(screen.getByText('Old thing')).toBeTruthy();
  });

  it('folds status, folder and age onto one line per row', () => {
    const sessions = [makeSession('live-1', 'Running thing', 'live')];
    renderDetails({ sessions });
    expect(screen.getByText(/Live · weft ·/)).toBeTruthy();
  });
});

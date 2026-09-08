import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@capacitor/app';
import { DeviceDetailsScreen } from '../DeviceDetailsScreen';
import { emptyTimeline } from '@/lib/timeline';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';

beforeEach(() => {
  vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
});

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
    onStartMonitoring: vi.fn(),
    onStopMonitoring: vi.fn(),
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

    fireEvent.click(screen.getByRole('button', { name: /start copilot/i }));
    expect(onStartOnDevice).toHaveBeenCalledWith('chan-1');

    fireEvent.click(screen.getByRole('button', { name: /resume copilot/i }));
    expect(onResumeOnDevice).toHaveBeenCalledWith('chan-1');
  });

  it('presents a uniform four-item quick-action grid without pretending future actions work', () => {
    renderDetails();

    expect(screen.getByRole('button', { name: /start copilot/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /resume copilot/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /explore files/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /open terminal/i })).toBeDisabled();
    expect(screen.getAllByText('Coming soon')).toHaveLength(2);
  });

  it('no longer carries a resumable-session list or a bare permission toggle', () => {
    renderDetails({ device: makeDevice({ sessions: [] }) });
    expect(screen.queryByLabelText(/search recent sessions/i)).toBeNull();
    expect(screen.queryByRole('radio', { name: /allow all/i })).toBeNull();
  });

  it('keeps the action layout visible but explains why laptop actions are disabled offline', () => {
    renderDetails({ device: makeDevice({ connected: false }) });
    expect(screen.getByRole('button', { name: /start copilot/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /resume copilot/i })).toBeDisabled();
    expect(screen.getByText(/weft start/i).textContent).toMatch(/weft start/);
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
    fireEvent.click(screen.getByRole('button', { name: /device actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /^devices$/i }));
    expect(onOpenDevices).toHaveBeenCalled();
  });

  it('keeps the sessions drawer on the header, where every other screen puts it', () => {
    renderDetails({});
    expect(screen.getByRole('button', { name: /open sessions/i })).toBeTruthy();
  });
});

describe('DeviceDetailsScreen session list separates what is running from what is not', () => {
  it('shows active sessions immediately and collapses the rest behind a counted toggle', () => {
    const sessions = [makeSession('live-1', 'Running thing', 'live'), makeSession('done-1', 'Old thing', 'ended')];
    renderDetails({ device: makeDevice({ deviceId: 'device-1' }), sessions });

    expect(screen.getByText('Running thing')).toBeTruthy();
    expect(screen.queryByText('Old thing')).toBeNull();

    expect(screen.getByText('Active Copilot sessions (1)')).toBeTruthy();
    const toggle = screen.getByRole('button', { name: /inactive copilot sessions \(1\)/i });
    fireEvent.click(toggle);
    expect(screen.getByText('Old thing')).toBeTruthy();
  });

  it('folds status, folder and age onto one line per row', () => {
    const sessions = [makeSession('live-1', 'Running thing', 'live')];
    renderDetails({ sessions });
    expect(screen.getByText(/Live · weft ·/)).toBeTruthy();
  });
});

describe('DeviceDetailsScreen workspaces', () => {
  it('shows readable workspace rows with path context, default state, and controlled expansion', () => {
    const projects = Array.from({ length: 6 }, (_, index) => ({
      name: `Workspace ${index + 1}`,
      path: index === 1 ? '/Users/me/src/Workspace 2' : `C:\\work\\Workspace ${index + 1}`,
      isDefault: index === 0,
    }));
    renderDetails({ device: makeDevice({ projects }) });

    expect(screen.getByRole('heading', { name: 'Copilot workspaces' })).toBeTruthy();
    expect(screen.getByText('Folders registered on this laptop for starting sessions.')).toBeTruthy();
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.getByText('C:\\work\\Workspace 1')).toBeTruthy();
    expect(screen.getByText('…/me/src/Workspace 2')).toBeTruthy();
    expect(screen.getByText('Workspace 4')).toBeTruthy();
    expect(screen.queryByText('Workspace 5')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /show all 6 workspaces/i }));
    expect(screen.getByText('Workspace 6')).toBeTruthy();
    expect(screen.getByRole('button', { name: /show fewer workspaces/i })).toBeTruthy();
  });

  it('collapses an expanded workspace list when navigating to another device', () => {
    const projects = Array.from({ length: 5 }, (_, index) => ({
      name: `Workspace ${index + 1}`,
      path: `C:\\work\\Workspace ${index + 1}`,
    }));
    const view = renderDetails({ device: makeDevice({ projects }) });
    fireEvent.click(screen.getByRole('button', { name: /show all 5 workspaces/i }));
    expect(screen.getByText('Workspace 5')).toBeTruthy();

    view.rerender(
      <DeviceDetailsScreen
        {...view.props}
        device={makeDevice({ channelId: 'chan-2', deviceId: 'device-2', projects })}
      />,
    );

    expect(screen.queryByText('Workspace 5')).toBeNull();
    expect(screen.getByRole('button', { name: /show all 5 workspaces/i })).toBeTruthy();
  });

  it('uses an actionable empty state instead of a missing-project placeholder', () => {
    renderDetails({ device: makeDevice({ projects: [] }) });

    expect(screen.getByText('No Copilot workspaces configured')).toBeTruthy();
    expect(screen.getByText(/weft add-project/i)).toBeTruthy();
  });
});

describe('DeviceDetailsScreen monitoring', () => {
  it('starts monitoring while visible and stops on cleanup', () => {
    const onStartMonitoring = vi.fn();
    const onStopMonitoring = vi.fn();
    const view = renderDetails({
      device: makeDevice({ capabilities: ['device-monitor-v1'] }),
      onStartMonitoring,
      onStopMonitoring,
    });

    expect(onStartMonitoring).toHaveBeenCalledWith('chan-1');
    view.unmount();
    expect(onStopMonitoring).toHaveBeenCalledWith('chan-1');
  });

  it('stops while the native app is backgrounded and resumes the same visible page', async () => {
    let appStateListener: ((state: { isActive: boolean }) => void) | undefined;
    vi.mocked(App.addListener).mockImplementationOnce((_eventName, listener) => {
      appStateListener = listener as unknown as (state: { isActive: boolean }) => void;
      return Promise.resolve({ remove: vi.fn() });
    });
    const onStartMonitoring = vi.fn();
    const onStopMonitoring = vi.fn();
    renderDetails({
      device: makeDevice({ capabilities: ['device-monitor-v1'] }),
      onStartMonitoring,
      onStopMonitoring,
    });
    await act(async () => Promise.resolve());

    act(() => appStateListener?.({ isActive: false }));
    expect(onStopMonitoring).toHaveBeenCalledWith('chan-1');

    act(() => appStateListener?.({ isActive: true }));
    expect(onStartMonitoring).toHaveBeenCalledTimes(2);
  });

  it('gates monitoring behind the advertised capability', () => {
    const onStartMonitoring = vi.fn();
    renderDetails({ device: makeDevice({ capabilities: [] }), onStartMonitoring });

    expect(onStartMonitoring).not.toHaveBeenCalled();
    expect(screen.getByText(/update weft on this laptop/i)).toBeTruthy();
  });

  it('shows offline state before capability negotiation instead of claiming an update is required', () => {
    renderDetails({ device: makeDevice({ connected: false, capabilities: undefined }) });

    expect(screen.getByText(/system health unavailable/i)).toBeTruthy();
    expect(screen.queryByText(/update weft on this laptop/i)).toBeNull();
  });

  it('renders percentage-first metrics without inventing an unavailable battery value', () => {
    renderDetails({
      device: makeDevice({
        capabilities: ['device-monitor-v1'],
        monitoring: {
          monitorId: 'monitor-1',
          startedAt: Date.now(),
          latestSequence: 1,
          snapshot: {
            schemaVersion: 1,
            monitorId: 'monitor-1',
            sequence: 1,
            capturedAt: Date.now(),
            effectiveIntervalMs: 10_000,
            leaseExpiresAt: Date.now() + 45_000,
            system: {
              cpuPercent: 18,
              memoryUsedBytes: 10 * 1024 ** 3,
              memoryTotalBytes: 16 * 1024 ** 3,
              uptimeSeconds: 90_000,
              diskUsedBytes: 70 * 1024 ** 3,
              diskTotalBytes: 100 * 1024 ** 3,
              batteryPercent: null,
              batteryCharging: null,
            },
            apps: [],
            observedAt: {
              system: Date.now(),
              disk: Date.now(),
              battery: null,
              apps: Date.now(),
            },
            issues: [],
          },
        },
      }),
    });

    expect(screen.getByText('18%')).toBeTruthy();
    expect(screen.getByText('63%')).toBeTruthy();
    expect(screen.getByText('70%')).toBeTruthy();
    expect(screen.getByText('1d 1h')).toBeTruthy();
    expect(screen.getByText('Since last restart')).toBeTruthy();
    expect(screen.queryByText(/battery/i)).toBeNull();
  });

  it('limits Running Now to five apps and expands without exposing window titles or controls', () => {
    const apps = Array.from({ length: 7 }, (_, index) => ({
      id: `app-${index + 1}`,
      name: `App ${index + 1}`,
      processCount: 1,
      windowCount: index + 1,
      memoryBytes: (index + 1) * 1024 ** 2,
    }));
    renderDetails({
      device: makeDevice({
        capabilities: ['device-monitor-v1'],
        monitoring: {
          monitorId: 'monitor-1',
          startedAt: Date.now(),
          latestSequence: 1,
          snapshot: {
            schemaVersion: 1,
            monitorId: 'monitor-1',
            sequence: 1,
            capturedAt: Date.now(),
            effectiveIntervalMs: 10_000,
            leaseExpiresAt: Date.now() + 45_000,
            system: {
              cpuPercent: null,
              memoryUsedBytes: null,
              memoryTotalBytes: null,
              uptimeSeconds: null,
              diskUsedBytes: null,
              diskTotalBytes: null,
              batteryPercent: null,
              batteryCharging: null,
            },
            apps,
            observedAt: {
              system: Date.now(),
              disk: null,
              battery: null,
              apps: Date.now(),
            },
            issues: [],
          },
        },
      }),
    });

    expect(screen.getByText('App 5')).toBeTruthy();
    expect(screen.queryByText('App 6')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show all 7/i }));
    expect(screen.getByText('App 7')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /end task|focus|close app/i })).toBeNull();
  });

  it('treats uptime-only telemetry as available system health', () => {
    renderDetails({
      device: makeDevice({
        capabilities: ['device-monitor-v1'],
        monitoring: {
          monitorId: 'monitor-1',
          startedAt: Date.now(),
          latestSequence: 1,
          snapshot: {
            schemaVersion: 1,
            monitorId: 'monitor-1',
            sequence: 1,
            capturedAt: Date.now(),
            effectiveIntervalMs: 10_000,
            leaseExpiresAt: Date.now() + 45_000,
            system: {
              cpuPercent: null,
              memoryUsedBytes: null,
              memoryTotalBytes: null,
              uptimeSeconds: 7_200,
              diskUsedBytes: null,
              diskTotalBytes: null,
              batteryPercent: null,
              batteryCharging: null,
            },
            apps: [],
            observedAt: {
              system: Date.now(),
              disk: null,
              battery: null,
              apps: Date.now(),
            },
            issues: [],
          },
        },
      }),
    });

    expect(screen.getByText('2h 0m')).toBeTruthy();
    expect(screen.queryByText(/system metrics are temporarily unavailable/i)).toBeNull();
  });

  it('marks old and partially unavailable snapshots without displaying zero placeholders', () => {
    const capturedAt = Date.now() - 60_000;
    renderDetails({
      device: makeDevice({
        capabilities: ['device-monitor-v1'],
        monitoring: {
          monitorId: 'monitor-1',
          startedAt: capturedAt,
          latestSequence: 1,
          snapshot: {
            schemaVersion: 1,
            monitorId: 'monitor-1',
            sequence: 1,
            capturedAt,
            effectiveIntervalMs: 10_000,
            leaseExpiresAt: capturedAt + 45_000,
            system: {
              cpuPercent: null,
              memoryUsedBytes: null,
              memoryTotalBytes: null,
              uptimeSeconds: null,
              diskUsedBytes: null,
              diskTotalBytes: null,
              batteryPercent: null,
              batteryCharging: null,
            },
            apps: [],
            observedAt: { system: null, disk: null, battery: null, apps: null },
            issues: [
              { component: 'system', code: 'unavailable' },
              { component: 'apps', code: 'timeout' },
            ],
          },
        },
      }),
    });

    expect(screen.getByText(/update delayed/i)).toBeTruthy();
    expect(screen.getByText(/system metrics are temporarily unavailable/i)).toBeTruthy();
    expect(screen.getByText(/running applications are temporarily unavailable/i)).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });
});

import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '@capacitor/app';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DeviceDetailsScreen } from '../DeviceDetailsScreen';
import { emptyTimeline } from '@/lib/timeline';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { CLIPBOARD_MAX_BYTES, DEVICE_CAPABILITY, type DeviceSystemSnapshot, type KeepAwakeStatusMsg } from '@aasis21/weft-shared';

const deviceStyles = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'styles', 'chat.css'), 'utf8');

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
    onOpenDeviceClipboard: vi.fn(),
    onCloseDeviceClipboard: vi.fn(),
    onReadDeviceClipboard: vi.fn(),
    onWriteDeviceClipboard: vi.fn(),
    onRefreshDeviceKeepAwake: vi.fn(),
    onStartDeviceKeepAwake: vi.fn(),
    onStopDeviceKeepAwake: vi.fn(),
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

  it('presents five actions without pretending unsupported utilities work', () => {
    renderDetails();

    expect(screen.getByRole('button', { name: /start copilot/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /resume copilot/i })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: /open terminal/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /clipboard/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /keep awake/i })).toBeDisabled();
    expect(screen.getAllByText('Checking support')).toHaveLength(2);
    expect(screen.queryByText('New session')).toBeNull();
    expect(screen.queryByText('Recent session')).toBeNull();
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
    expect(screen.getAllByText(/weft start/i).some((element) => element.textContent?.includes('weft start'))).toBe(true);
  });

  it('enables the terminal only for an authorized capable laptop', () => {
    const onOpenTerminal = vi.fn();
    renderDetails({ device: makeDevice({ capabilities: ['device-terminal-v1'] }), onOpenTerminal });
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }));
    expect(onOpenTerminal).toHaveBeenCalledWith('chan-1');
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

    expect(screen.getByRole('heading', { name: 'Active Copilot sessions, 1' })).toBeTruthy();
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

    expect(screen.getByRole('heading', { name: 'Copilot workspaces, 6 folders' })).toBeTruthy();
    expect(screen.queryByText('Folders registered on this laptop for starting sessions.')).toBeNull();
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.getByText('C:\\work\\Workspace 1')).toBeTruthy();
    expect(screen.getByText('…/me/src/Workspace 2')).toBeTruthy();
    expect(screen.getByText('Workspace 3')).toBeTruthy();
    expect(screen.queryByText('Workspace 4')).toBeNull();

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
    expect(screen.getByText(/^update weft on this laptop$/i)).toBeTruthy();
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
    expect(screen.getByRole('group', { name: 'Power' })).toHaveTextContent('Power unavailable');
    expect(screen.queryByText('Uptime')).toBeNull();
    expect(screen.queryByText('Since last restart')).toBeNull();
    expect(screen.queryByText(/battery/i)).toBeNull();
  });

  it('shows cached system health immediately while waiting for a fresh snapshot', () => {
    const capturedAt = Date.now() - 60_000;
    renderDetails({
      device: makeDevice({
        capabilities: ['device-monitor-v1'],
        cachedHealth: {
          capturedAt,
          effectiveIntervalMs: 10_000,
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
          issues: [],
        },
        monitoring: {
          monitorId: 'monitor-2',
          startedAt: Date.now(),
          latestSequence: -1,
        },
      }),
    });

    expect(screen.getByText('18%')).toBeTruthy();
    expect(screen.getByText(/updating · saved/i)).toBeTruthy();
    expect(screen.queryByText(/checking system health/i)).toBeNull();
    expect(screen.queryByRole('heading', { name: /running now/i })).toBeNull();
  });

  it('shows the laptop update state instead of a cache that can no longer refresh', () => {
    renderDetails({
      device: makeDevice({
        capabilities: [],
        cachedHealth: {
          capturedAt: Date.now() - 60_000,
          effectiveIntervalMs: 10_000,
          system: {
            cpuPercent: 18,
            memoryUsedBytes: null,
            memoryTotalBytes: null,
            uptimeSeconds: null,
            diskUsedBytes: null,
            diskTotalBytes: null,
            batteryPercent: null,
            batteryCharging: null,
          },
          issues: [],
        },
      }),
    });

    expect(screen.getByText(/^update weft on this laptop$/i)).toBeTruthy();
    expect(screen.queryByText('18%')).toBeNull();
    expect(screen.queryByText(/updating · saved/i)).toBeNull();
  });

  it('limits Running Now to three apps and expands without exposing window titles or controls', () => {
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

    expect(screen.getByText('App 3')).toBeTruthy();
    expect(screen.queryByText('App 4')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /show all 7/i }));
    expect(screen.getByText('App 7')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /end task|focus|close app/i })).toBeNull();
  });

  it('keeps the Power card unavailable when only legacy uptime telemetry is available', () => {
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

    expect(screen.queryByText('2h 0m')).toBeNull();
    expect(screen.getByText('Power unavailable')).toBeTruthy();
    expect(screen.getByText(/system metrics are temporarily unavailable/i)).toBeTruthy();
  });
});

  const utilityCapabilities = [DEVICE_CAPABILITY.MONITOR_V1, DEVICE_CAPABILITY.CLIPBOARD_V1, DEVICE_CAPABILITY.KEEP_AWAKE_V1];

  function utilityDevice(overrides: Partial<ListenerDeviceState> = {}): ListenerDeviceState {
    return makeDevice({ capabilities: utilityCapabilities, ...overrides });
  }

  function powerHealth(power: Partial<DeviceSystemSnapshot>): NonNullable<ListenerDeviceState['cachedHealth']> {
    return {
      capturedAt: Date.now(),
      effectiveIntervalMs: 10_000,
      system: {
        cpuPercent: 10,
        memoryUsedBytes: null,
        memoryTotalBytes: null,
        diskUsedBytes: null,
        diskTotalBytes: null,
        uptimeSeconds: 7_200,
        batteryPercent: null,
        batteryCharging: null,
        onAcPower: null,
        ...power,
      },
      issues: [],
    };
  }

  function awakeStatus(overrides: Partial<KeepAwakeStatusMsg> = {}): KeepAwakeStatusMsg {
    return {
      requestId: 'status-1',
      leaseId: 'lease-1',
      active: true,
      expiresAt: Date.now() + 15 * 60_000,
      revision: 1,
      code: 'ok',
      ...overrides,
    };
  }

  describe('Device Details Power and independent utility capabilities', () => {
    it.each([
      ['charging battery', { batteryPercent: 72, batteryCharging: true, onAcPower: null }, '72%', 'Charging'],
      ['AC-connected battery', { batteryPercent: 100, batteryCharging: false, onAcPower: true }, '100%', 'Charging'],
      ['battery without AC', { batteryPercent: 0, batteryCharging: false, onAcPower: false }, '0%', 'On battery'],
      ['unknown charging without AC', { batteryPercent: 42, batteryCharging: null, onAcPower: false }, '42%', 'On battery'],
      ['unknown power source', { batteryPercent: 42, batteryCharging: false, onAcPower: null }, '42%', ''],
      ['AC desktop', { onAcPower: true }, 'AC', 'Plugged in'],
      ['unknown power', {}, '', 'Power unavailable'],
      ['battery source without percentage', { onAcPower: false }, '', 'On battery'],
    ] as const)('renders %s without fabricating power fields or adding a duplicate battery card', (_name, power, value, detail) => {
      renderDetails({ device: utilityDevice({ cachedHealth: powerHealth(power) }) });
      const card = screen.getByRole('group', { name: 'Power' });
      if (value) expect(card).toHaveTextContent(value);
      if (detail) expect(card).toHaveTextContent(detail);
      else {
        expect(card).not.toHaveTextContent(/Charging|On battery|Plugged in/);
      }
      expect(screen.queryByText('Battery')).toBeNull();
      expect(screen.queryByText('Uptime')).toBeNull();
      expect(screen.getAllByRole('group', { name: 'Power' })).toHaveLength(1);
    });

    it.each([
      [DEVICE_CAPABILITY.CLIPBOARD_V1, 'Clipboard', 'Keep Awake'],
      [DEVICE_CAPABILITY.KEEP_AWAKE_V1, 'Keep Awake', 'Clipboard'],
    ])('enables only the independently advertised %s capability', (capability, enabled, disabled) => {
      renderDetails({ device: utilityDevice({ capabilities: [DEVICE_CAPABILITY.MONITOR_V1, capability] }) });
      expect(screen.getByRole('button', { name: new RegExp(enabled, 'i') })).toBeEnabled();
      const unavailable = screen.getByRole('button', { name: new RegExp(disabled, 'i') });
      expect(unavailable).toBeDisabled();
      expect(unavailable).toHaveAccessibleDescription('Update Weft on this laptop to enable unavailable utilities.');
    });

    it('explains offline separately from unsupported and hides stale active time', () => {
      renderDetails({
        device: utilityDevice({ connected: false, keepAwake: { pending: false, status: awakeStatus() }, cachedHealth: powerHealth({ onAcPower: true }) }),
      });
      for (const name of [/clipboard/i, /keep awake/i]) {
        const button = screen.getByRole('button', { name });
        expect(button).toBeDisabled();
        expect(button).toHaveTextContent('Offline');
        expect(button).toHaveAccessibleDescription('Reconnect this laptop to use device utilities.');
      }
      expect(screen.queryByText(/15m left/)).toBeNull();
      expect(screen.queryByText(/enable unavailable utilities/)).toBeNull();
    });

    it('shows authoritative remaining time only on the Keep Awake action', () => {
      renderDetails({ device: utilityDevice({ keepAwake: { pending: false, status: awakeStatus() }, cachedHealth: powerHealth({ onAcPower: true }) }) });
      expect(screen.getByRole('button', { name: /Keep Awake/ })).toHaveTextContent('15m left');
      expect(screen.getByRole('group', { name: 'Power' })).not.toHaveTextContent('Keep Awake');
    });

    it('retains a single focused Power card without monitoring support', () => {
      renderDetails({ device: utilityDevice({ capabilities: [DEVICE_CAPABILITY.KEEP_AWAKE_V1], keepAwake: { pending: false, status: awakeStatus() } }) });
      expect(screen.getAllByRole('group', { name: 'Power' })).toHaveLength(1);
      expect(screen.getByRole('group', { name: 'Power' })).toHaveTextContent('Power unavailable');
      expect(screen.getByRole('group', { name: 'Power' })).not.toHaveTextContent('15m left');
    });

    it('shows pending feedback on the action without inventing a successful lease', () => {
      renderDetails({ device: utilityDevice({ keepAwake: { pending: true }, cachedHealth: powerHealth({}) }) });
      expect(screen.getByRole('button', { name: /Keep Awake/ })).toHaveTextContent('Working…');
      expect(screen.getByRole('group', { name: 'Power' })).not.toHaveTextContent('Keep Awake');
    });

    it('updates remaining time without issuing any power commands', () => {
      vi.useFakeTimers();
      const view = renderDetails({ device: utilityDevice({ keepAwake: { pending: false, status: awakeStatus() }, cachedHealth: powerHealth({ onAcPower: true }) }) });
      try {
        act(() => vi.advanceTimersByTime(60_000));
        expect(screen.getByRole('button', { name: /Keep Awake/ })).toHaveTextContent('14m left');
        expect(screen.getByRole('group', { name: 'Power' })).not.toHaveTextContent('14m left');
        expect(view.props.onStartDeviceKeepAwake).not.toHaveBeenCalled();
        expect(view.props.onStopDeviceKeepAwake).not.toHaveBeenCalled();
      } finally {
        view.unmount();
        vi.useRealTimers();
      }
    });
  });

  describe('Device Details explicit Clipboard sheet', () => {
    it('opens without reading and sends exactly the entered text only after an explicit operation', () => {
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      expect(screen.getByRole('dialog', { name: 'Clipboard' })).toHaveAttribute('aria-modal', 'true');
      expect(view.props.onOpenDeviceClipboard).toHaveBeenCalledWith('chan-1');
      expect(view.props.onReadDeviceClipboard).not.toHaveBeenCalled();
      expect(view.props.onWriteDeviceClipboard).not.toHaveBeenCalled();
      expect(screen.queryByLabelText('Returned laptop clipboard text')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Read laptop clipboard' }));
      expect(view.props.onReadDeviceClipboard).toHaveBeenCalledWith('chan-1');
      const exactText = '  hello 🦊\nsecond line\n';
      fireEvent.change(screen.getByLabelText('Text to send to laptop'), { target: { value: exactText } });
      expect(view.props.onWriteDeviceClipboard).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole('button', { name: 'Send to laptop' }));
      expect(view.props.onWriteDeviceClipboard).toHaveBeenCalledWith('chan-1', exactText);
      expect(screen.getByLabelText('Text to send to laptop')).toHaveValue(exactText);
    });

    it('allows the exact UTF-8 limit and blocks one byte over without changing the draft', () => {
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      const text = '🦊'.repeat(CLIPBOARD_MAX_BYTES / 4);
      const draft = screen.getByLabelText('Text to send to laptop');
      const send = screen.getByRole('button', { name: 'Send to laptop' });
      fireEvent.change(draft, { target: { value: text } });
      expect(send).toBeEnabled();
      fireEvent.click(send);
      expect(view.props.onWriteDeviceClipboard).toHaveBeenCalledWith('chan-1', text);
      fireEvent.change(draft, { target: { value: text + 'a' } });
      expect(send).toBeDisabled();
      expect(draft).toHaveValue(text + 'a');
      expect(draft).toHaveAttribute('aria-invalid', 'true');
      expect(screen.getByRole('alert')).toHaveTextContent('Text exceeds 64 KiB of UTF-8');
      fireEvent.click(send);
      expect(view.props.onWriteDeviceClipboard).toHaveBeenCalledTimes(1);
    });

    it('disables operations while pending and only displays whitelisted actionable errors', () => {
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ clipboard: { pending: true, operation: 'read', requestId: 'read-1' } })} />);
      expect(screen.getByText('Reading laptop clipboard…')).toHaveAttribute('role', 'status');
      expect(screen.getByRole('button', { name: 'Read laptop clipboard' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Send to laptop' })).toBeDisabled();
      expect(screen.getByLabelText('Text to send to laptop')).toBeDisabled();
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ clipboard: { pending: false, operation: 'read', code: 'timeout' } })} />);
      expect(screen.getByRole('alert')).toHaveTextContent('The laptop did not respond in time');
      expect(screen.getByRole('button', { name: 'Read laptop clipboard' })).toBeEnabled();
    });

    it('copies returned text only after the phone-copy action', async () => {
      const copy = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ clipboard: { pending: false, operation: 'read', code: 'ok', text: '  returned 🦊\n' } })} />);
      expect(copy).not.toHaveBeenCalled();
      expect(screen.getByLabelText('Returned laptop clipboard text')).toHaveValue('  returned 🦊\n');
      fireEvent.click(screen.getByRole('button', { name: 'Copy returned text to phone' }));
      await act(async () => Promise.resolve());
      expect(copy).toHaveBeenCalledWith('  returned 🦊\n');
      expect(screen.getByText('Copied to phone.')).toBeTruthy();
    });

    it.each(['unsupported', 'denied'])('offers explicit text selection if phone copy is %s', async (mode) => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: mode === 'unsupported' ? undefined : { writeText: vi.fn().mockRejectedValue(new Error('private native error')) },
      });
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ clipboard: { pending: false, operation: 'read', code: 'ok', text: 'select this' } })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Copy returned text to phone' }));
      await act(async () => Promise.resolve());
      const result = screen.getByLabelText<HTMLTextAreaElement>('Returned laptop clipboard text');
      expect(result).toHaveFocus();
      expect(result.selectionStart).toBe(0);
      expect(result.selectionEnd).toBe('select this'.length);
      expect(screen.getByText('Text selected. Use your phone’s Copy command.')).toBeTruthy();
      expect(screen.queryByText('private native error')).toBeNull();
    });

    it('does not show text from a write result or an oversized read', () => {
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ clipboard: { pending: false, operation: 'write', code: 'ok', text: 'must not show' } })} />);
      expect(screen.getByText('Sent to laptop.')).toBeTruthy();
      expect(screen.queryByLabelText('Returned laptop clipboard text')).toBeNull();
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ clipboard: { pending: false, operation: 'read', code: 'ok', text: 'x'.repeat(CLIPBOARD_MAX_BYTES + 1) } })} />);
      expect(screen.queryByLabelText('Returned laptop clipboard text')).toBeNull();
      expect(screen.getByRole('alert')).toHaveTextContent('Text exceeds 64 KiB');
    });

    it.each(['ok', 'timeout'] as const)('does not retain a prior %s result or error after runtime clearing and reopening', (code) => {
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ clipboard: { pending: false, operation: 'read', code, ...(code === 'ok' ? { text: 'private result' } : {}) } })} />);
      fireEvent.change(screen.getByLabelText('Text to send to laptop'), { target: { value: 'private draft' } });
      fireEvent.click(screen.getByRole('button', { name: 'Close Clipboard' }));
      expect(view.props.onCloseDeviceClipboard).toHaveBeenCalledWith('chan-1');
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice()} />);
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      expect(screen.getByLabelText('Text to send to laptop')).toHaveValue('');
      expect(screen.queryByLabelText('Returned laptop clipboard text')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(view.props.onReadDeviceClipboard).not.toHaveBeenCalled();
    });

    it.each(['close', 'escape', 'backdrop'])('clears the sheet and runtime on %s and restores trigger focus', (dismissal) => {
      const view = renderDetails({ device: utilityDevice() });
      const trigger = screen.getByRole('button', { name: /clipboard/i });
      fireEvent.click(trigger);
      const close = screen.getByRole('button', { name: 'Close Clipboard' });
      expect(close).toHaveFocus();
      fireEvent.change(screen.getByLabelText('Text to send to laptop'), { target: { value: 'private draft' } });
      if (dismissal === 'close') fireEvent.click(close);
      else if (dismissal === 'escape') fireEvent.keyDown(document, { key: 'Escape' });
      else fireEvent.click(screen.getByRole('dialog').parentElement!);
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(view.props.onCloseDeviceClipboard).toHaveBeenCalledWith('chan-1');
      expect(trigger).toHaveFocus();
      fireEvent.click(trigger);
      expect(screen.getByLabelText('Text to send to laptop')).toHaveValue('');
      expect(screen.queryByLabelText('Returned laptop clipboard text')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('traps Tab in both directions and makes the underlying screen inert', () => {
      renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      const close = screen.getByRole('button', { name: 'Close Clipboard' });
      const send = screen.getByRole('button', { name: 'Send to laptop' });
      fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
      expect(send).toHaveFocus();
      fireEvent.keyDown(document, { key: 'Tab' });
      expect(close).toHaveFocus();
      expect(screen.queryByRole('button', { name: /Start Copilot/ })).toBeNull();
      const header = document.querySelector('.status-bar') as HTMLElement;
      expect(header.inert).toBe(true);
      fireEvent.click(close);
      expect(header.inert).not.toBe(true);
      expect(screen.getByRole('button', { name: /Start Copilot/ })).toBeTruthy();
    });

    it.each(['disconnect', 'device switch', 'capability removed', 'unmount'])('clears clipboard on %s', (reason) => {
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
      fireEvent.change(screen.getByLabelText('Text to send to laptop'), { target: { value: 'private draft' } });
      if (reason === 'unmount') view.unmount();
      else {
        const device = reason === 'disconnect' ? utilityDevice({ connected: false })
          : reason === 'device switch' ? utilityDevice({ channelId: 'chan-2', deviceId: 'device-2' })
            : utilityDevice({ capabilities: [DEVICE_CAPABILITY.MONITOR_V1] });
        view.rerender(<DeviceDetailsScreen {...view.props} device={device} />);
      }
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(view.props.onCloseDeviceClipboard).toHaveBeenCalledWith('chan-1');
      if (reason !== 'unmount') {
        view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice()} />);
        expect(screen.queryByRole('dialog')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /clipboard/i }));
        expect(screen.getByLabelText('Text to send to laptop')).toHaveValue('');
      }
    });

    it.each(['backButton', 'appStateChange', 'visibilitychange'])('clears text on %s and removes native listeners', async (eventName) => {
      const listeners: Record<string, (event: unknown) => void> = {};
      const removers: Record<string, ReturnType<typeof vi.fn>> = {};
      vi.mocked(App.addListener).mockImplementation((name, listener) => {
        listeners[name] = listener as (event: unknown) => void;
        const remove = vi.fn();
        removers[name] = remove;
        return Promise.resolve({ remove });
      });
      const view = renderDetails({ device: utilityDevice() });
      const trigger = screen.getByRole('button', { name: /clipboard/i });
      fireEvent.click(trigger);
      fireEvent.change(screen.getByLabelText('Text to send to laptop'), { target: { value: 'private draft' } });
      await act(async () => Promise.resolve());
      if (eventName === 'visibilitychange') {
        vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        fireEvent(document, new Event('visibilitychange'));
      } else act(() => listeners[eventName]?.({ isActive: false }));
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(view.props.onCloseDeviceClipboard).toHaveBeenCalledWith('chan-1');
      expect(removers.backButton).toHaveBeenCalled();
      expect(removers.appStateChange).toHaveBeenCalled();
      expect(trigger).toHaveFocus();
    });
  });

  describe('Device Details station-authoritative Keep Awake sheet', () => {
    it('refreshes on open and exposes all bounded durations with an explicit start', () => {
      const view = renderDetails({ device: utilityDevice() });
      fireEvent.click(screen.getByRole('button', { name: /Keep Awake/ }));
      expect(screen.getByRole('dialog', { name: 'Keep Awake' })).toHaveAttribute('aria-modal', 'true');
      expect(screen.getByRole('button', { name: 'Close Keep Awake' })).toHaveFocus();
      expect(view.props.onRefreshDeviceKeepAwake).toHaveBeenCalledWith('chan-1');
      expect(view.props.onStartDeviceKeepAwake).not.toHaveBeenCalled();
      const duration = screen.getByRole<HTMLSelectElement>('combobox', { name: 'Keep Awake duration' });
      expect(Array.from(duration.options).map((option) => Number(option.value))).toEqual([900_000, 1_800_000, 3_600_000, 7_200_000, 14_400_000, 28_800_000]);
      expect(within(duration).getByRole('option', { name: '15 minutes' })).toBeTruthy();
      expect(within(duration).getByRole('option', { name: '8 hours' })).toBeTruthy();
      fireEvent.change(duration, { target: { value: '28800000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Start keeping awake' }));
      expect(view.props.onStartDeviceKeepAwake).toHaveBeenCalledWith('chan-1', 28_800_000);
      expect(screen.getByText(/display can still turn off/)).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Stop keeping awake' })).toBeNull();
    });

    it('extends the active station lease, disables pending actions, and explicitly stops it', () => {
      const active = { pending: false, status: awakeStatus() };
      const view = renderDetails({ device: utilityDevice({ keepAwake: active }) });
      fireEvent.click(screen.getByRole('button', { name: /Keep Awake/ }));
      fireEvent.change(screen.getByRole('combobox'), { target: { value: '3600000' } });
      fireEvent.click(screen.getByRole('button', { name: 'Extend keeping awake' }));
      expect(view.props.onStartDeviceKeepAwake).toHaveBeenCalledWith('chan-1', 3_600_000);
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ keepAwake: { ...active, pending: true } })} />);
      expect(screen.getByText('Updating Keep Awake…')).toHaveAttribute('role', 'status');
      expect(screen.getByRole('button', { name: 'Extend keeping awake' })).toBeDisabled();
      expect(screen.getByRole('button', { name: 'Stop keeping awake' })).toBeDisabled();
      expect(screen.getByRole('combobox')).toBeDisabled();
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ keepAwake: active })} />);
      fireEvent.click(screen.getByRole('button', { name: 'Stop keeping awake' }));
      expect(view.props.onStopDeviceKeepAwake).toHaveBeenCalledWith('chan-1');
      view.rerender(<DeviceDetailsScreen {...view.props} device={utilityDevice({ keepAwake: { pending: false, status: awakeStatus({ active: false, leaseId: null, expiresAt: null }) } })} />);
      expect(screen.getByText('Keep Awake is off.')).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Start keeping awake' })).toBeEnabled();
      expect(screen.queryByRole('button', { name: 'Stop keeping awake' })).toBeNull();
    });

    it('does not stop on dismissal and refreshes the still-active lease on reopen', () => {
      const view = renderDetails({ device: utilityDevice({ keepAwake: { pending: false, status: awakeStatus() } }) });
      const trigger = screen.getByRole('button', { name: /Keep Awake/ });
      fireEvent.click(trigger);
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(view.props.onStopDeviceKeepAwake).not.toHaveBeenCalled();
      expect(trigger).toHaveFocus();
      fireEvent.click(trigger);
      expect(view.props.onRefreshDeviceKeepAwake).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Extend keeping awake' })).toBeEnabled();
      expect(screen.getByText('Keeping system awake · 15m left')).toBeTruthy();
    });

    it('treats an elapsed phone countdown as awaiting station status rather than fabricating a stopped lease', () => {
      renderDetails({ device: utilityDevice({ keepAwake: { pending: false, status: awakeStatus({ expiresAt: Date.now() - 1 }) } }) });
      fireEvent.click(screen.getByRole('button', { name: /Keep Awake/ }));
      expect(screen.getByText(/Keeping system awake · Awaiting laptop status/)).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Stop keeping awake' })).toBeEnabled();
    });

    it('shows a sanitized actionable status error', () => {
      renderDetails({ device: utilityDevice({ keepAwake: { pending: false, status: awakeStatus(), code: 'lease-mismatch' } }) });
      fireEvent.click(screen.getByRole('button', { name: /Keep Awake/ }));
      expect(screen.getByRole('alert')).toHaveTextContent('Close and reopen this sheet to refresh its status');
    });

    it('closes on native Back without stopping the station lease', async () => {
      let back: (() => void) | undefined;
      vi.mocked(App.addListener).mockImplementation((eventName, listener) => {
        if (eventName === 'backButton') back = listener as () => void;
        return Promise.resolve({ remove: vi.fn() });
      });
      const view = renderDetails({ device: utilityDevice({ keepAwake: { pending: false, status: awakeStatus() } }) });
      const trigger = screen.getByRole('button', { name: /Keep Awake/ });
      fireEvent.click(trigger);
      await act(async () => Promise.resolve());
      act(() => back?.());
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(view.props.onStopDeviceKeepAwake).not.toHaveBeenCalled();
      expect(trigger).toHaveFocus();
    });
  });

  describe('Device utility responsive layout contracts', () => {
    it('keeps sheets viewport-bounded, scrollable, safe-area padded, and touch accessible', () => {
      expect(deviceStyles).toMatch(/\.device-utility-sheet\s*\{[^}]*width: min\(100%, 560px\)/);
      expect(deviceStyles).toMatch(/\.device-utility-sheet\s*\{[^}]*100dvh/);
      expect(deviceStyles).toMatch(/\.device-utility-body\s*\{[^}]*safe-area-inset-bottom[^}]*overflow-y: auto/);
      expect(deviceStyles).toMatch(/\.device-utility-actions\s*\{[^}]*flex-wrap: wrap/);
      expect(deviceStyles).toMatch(/\.device-utility-button\s*\{[^}]*min-height: 44px/);
      expect(deviceStyles).toMatch(/\.device-power-metric \.device-metric-detail\s*\{[^}]*white-space: normal/);
      expect(deviceStyles).toMatch(/\.device-metrics\s*\{[^}]*repeat\(2, minmax\(0, 1fr\)\)/);
      expect(deviceStyles).toMatch(/@media \(min-width: 768px\)[\s\S]*?\.device-metrics\s*\{[^}]*repeat\(4, minmax\(0, 1fr\)\)/);
    });
  });

describe('DeviceDetailsScreen partial monitoring snapshots', () => {
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

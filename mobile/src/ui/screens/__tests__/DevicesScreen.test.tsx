import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DevicesScreen } from '../DevicesScreen';
import type { ListenerDeviceState } from '@/session/model';

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

function renderDevices(overrides: Partial<ComponentProps<typeof DevicesScreen>> = {}) {
  const props: ComponentProps<typeof DevicesScreen> = {
    sessions: [],
    activeId: null,
    devices: [],
    onRefreshProjects: vi.fn(),
    onSetDefault: vi.fn().mockResolvedValue(undefined),
    onForget: vi.fn().mockResolvedValue(undefined),
    onStartOnDevice: vi.fn(),
    onOpenDetails: vi.fn(),
    onScanListener: vi.fn(),
    onSelectSession: vi.fn(),
    onAddSession: vi.fn(),
    onStartSession: vi.fn(),
    onOpenDevices: vi.fn(),
    onRemoveSession: vi.fn(),
    onRenameSession: vi.fn(),
    onGoHome: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<DevicesScreen {...props} />) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('DevicesScreen', () => {
  it('shows the empty state and lets the user scan a device QR', () => {
    const onScanListener = vi.fn();
    renderDevices({ onScanListener });

    fireEvent.click(screen.getByRole('button', { name: /scan to connect/i }));
    expect(onScanListener).toHaveBeenCalledTimes(1);
  });

  it('renders a device card and wires the primary actions', () => {
    const onStartOnDevice = vi.fn();
    const onForget = vi.fn().mockResolvedValue(undefined);
    const onSetDefault = vi.fn().mockResolvedValue(undefined);

    renderDevices({ devices: [makeDevice()], onSetDefault, onForget, onStartOnDevice });

    expect(screen.getByText('MacBook Pro')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /start session/i }));
    expect(onStartOnDevice).toHaveBeenCalledWith('chan-1');

    // Secondary actions (default/refresh/forget) live behind the "⋯" overflow menu.
    fireEvent.click(screen.getByRole('button', { name: /device actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /forget/i }));
    expect(onForget).toHaveBeenCalledWith('chan-1');

    // Default device has no "Make default" menu item.
    fireEvent.click(screen.getByRole('button', { name: /device actions/i }));
    expect(screen.queryByRole('menuitem', { name: /make default/i })).not.toBeInTheDocument();
  });

  it('shows a "Make default" action for non-default devices', () => {
    const onSetDefault = vi.fn().mockResolvedValue(undefined);
    renderDevices({ devices: [makeDevice({ isDefault: false })], onSetDefault });

    fireEvent.click(screen.getByRole('button', { name: /device actions/i }));
    fireEvent.click(screen.getByRole('menuitem', { name: /make default/i }));
    expect(onSetDefault).toHaveBeenCalledWith('chan-1');
  });

  it('advances relative last-seen labels on the shared clock tick', () => {
    const base = 2_000_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(base);
    renderDevices({ devices: [makeDevice({ lastSeenAt: base - 120_000 })] });

    expect(screen.getByText(/last seen 2m ago/i)).toBeInTheDocument();

    act(() => {
      vi.setSystemTime(base + 31_000);
      vi.advanceTimersByTime(30_000);
    });

    expect(screen.getByText(/last seen 3m ago/i)).toBeInTheDocument();
  });

  it('disables starting a session on an offline device with an explanation', () => {
    const onStartOnDevice = vi.fn();
    renderDevices({ devices: [makeDevice({ connected: false })], onStartOnDevice });

    const start = screen.getByRole('button', { name: /start session/i });
    expect(start).toBeDisabled();
    expect(start).toHaveAccessibleDescription(/offline/i);
    fireEvent.click(start);
    expect(onStartOnDevice).not.toHaveBeenCalled();
  });

  it('closes the overflow menu on outside tap and Escape, restoring trigger focus on Escape', () => {
    renderDevices({ devices: [makeDevice({ isDefault: false })] });
    const trigger = screen.getByRole('button', { name: /device actions/i });

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.pointerDown(document.body);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('keeps an online device online while projects are refreshing', () => {
    renderDevices({ devices: [makeDevice({ connected: true, projectsLoading: true })] });

    expect(screen.getAllByText('Online').length).toBeGreaterThan(0);
    expect(screen.queryByText(/Connecting/i)).not.toBeInTheDocument();
    expect(screen.getByText(/Refreshing projects/i)).toBeInTheDocument();
  });

  it('labels an all-offline list and shows the last tried time', () => {
    const now = 2_000_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(now);

    renderDevices({
      devices: [makeDevice({ connected: false, lastAttemptAt: now - 60_000, lastSeenAt: now - 3_600_000 })],
    });

    expect(screen.getByRole('heading', { name: /offline .* no devices reachable/i })).toBeInTheDocument();
    expect(screen.getByText(/tried 1m ago/i)).toBeInTheDocument();
  });

  it('refreshes every saved device from the header', () => {
    const onRefreshProjects = vi.fn();
    renderDevices({
      devices: [makeDevice({ channelId: 'chan-1' }), makeDevice({ channelId: 'chan-2', deviceId: 'device-2' })],
      onRefreshProjects,
    });

    fireEvent.click(screen.getByRole('button', { name: /refresh all devices/i }));
    expect(onRefreshProjects).toHaveBeenCalledWith('chan-1');
    expect(onRefreshProjects).toHaveBeenCalledWith('chan-2');
  });
});

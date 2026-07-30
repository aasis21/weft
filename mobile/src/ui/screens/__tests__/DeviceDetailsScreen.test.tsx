import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { DeviceDetailsScreen } from '../DeviceDetailsScreen';
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

    fireEvent.click(screen.getByRole('button', { name: /start session/i }));
    expect(onStartOnDevice).toHaveBeenCalledWith('chan-1');

    fireEvent.click(screen.getByRole('button', { name: /resume a session/i }));
    expect(onResumeOnDevice).toHaveBeenCalledWith('chan-1');
  });

  it('no longer carries a resumable-session list or a bare permission toggle', () => {
    renderDetails({ device: makeDevice({ sessions: [] }) });
    expect(screen.queryByLabelText(/search recent sessions/i)).toBeNull();
    expect(screen.queryByRole('radio', { name: /allow all/i })).toBeNull();
  });

  it('cannot resume from an offline device', () => {
    renderDetails({ device: makeDevice({ connected: false }) });
    expect(screen.getByRole('button', { name: /resume a session/i })).toBeDisabled();
  });
});

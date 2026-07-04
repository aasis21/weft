import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DevicesScreen } from '../DevicesScreen';
import type { ListenerDeviceState } from '@/session/model';

function makeDevice(overrides: Partial<ListenerDeviceState> = {}): ListenerDeviceState {
  return {
    channelId: 'chan-1',
    pub: 'pub-1',
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

describe('DevicesScreen', () => {
  it('shows the empty state and lets the user scan a listener QR', () => {
    const onScanListener = vi.fn();
    render(
      <DevicesScreen
        sessions={[]}
        activeId={null}
        devices={[]}
        onRefreshProjects={vi.fn()}
        onSetDefault={vi.fn()}
        onForget={vi.fn()}
        onStartOnDevice={vi.fn()}
        onOpenDetails={vi.fn()}
        onScanListener={onScanListener}
        onSelectSession={vi.fn()}
        onAddSession={vi.fn()}
        onStartSession={vi.fn()}
        onOpenDevices={vi.fn()}
        onRemoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onGoHome={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /scan a listener qr/i }));
    expect(onScanListener).toHaveBeenCalledTimes(1);
  });

  it('renders a device card and wires the primary actions', () => {
    const onStartOnDevice = vi.fn();
    const onForget = vi.fn().mockResolvedValue(undefined);
    const onSetDefault = vi.fn().mockResolvedValue(undefined);

    render(
      <DevicesScreen
        sessions={[]}
        activeId={null}
        devices={[makeDevice()]}
        onRefreshProjects={vi.fn()}
        onSetDefault={onSetDefault}
        onForget={onForget}
        onStartOnDevice={onStartOnDevice}
        onOpenDetails={vi.fn()}
        onScanListener={vi.fn()}
        onSelectSession={vi.fn()}
        onAddSession={vi.fn()}
        onStartSession={vi.fn()}
        onOpenDevices={vi.fn()}
        onRemoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onGoHome={vi.fn()}
      />,
    );

    expect(screen.getByText('MacBook Pro')).toBeInTheDocument();
    expect(screen.getByText('default')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /start session/i }));
    expect(onStartOnDevice).toHaveBeenCalledWith('chan-1');

    fireEvent.click(screen.getByRole('button', { name: /forget/i }));
    expect(onForget).toHaveBeenCalledWith('chan-1');

    // Default device has no "Make default" button.
    expect(screen.queryByRole('button', { name: /make default/i })).not.toBeInTheDocument();
  });

  it('shows a "Make default" action for non-default devices', () => {
    const onSetDefault = vi.fn().mockResolvedValue(undefined);
    render(
      <DevicesScreen
        sessions={[]}
        activeId={null}
        devices={[makeDevice({ isDefault: false })]}
        onRefreshProjects={vi.fn()}
        onSetDefault={onSetDefault}
        onForget={vi.fn()}
        onStartOnDevice={vi.fn()}
        onOpenDetails={vi.fn()}
        onScanListener={vi.fn()}
        onSelectSession={vi.fn()}
        onAddSession={vi.fn()}
        onStartSession={vi.fn()}
        onOpenDevices={vi.fn()}
        onRemoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onGoHome={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /make default/i }));
    expect(onSetDefault).toHaveBeenCalledWith('chan-1');
  });
});

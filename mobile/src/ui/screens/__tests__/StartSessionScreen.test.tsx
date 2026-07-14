import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { StartSessionScreen } from '../StartSessionScreen';
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
    projects: [{ name: 'demo', path: 'C:\\repos\\demo', isDefault: true }],
    projectsLoading: false,
    connected: true,
    events: [],
    ...overrides,
  };
}

function renderScreen(devices: ListenerDeviceState[], onScanListener = vi.fn()): void {
  render(
    <StartSessionScreen
      hasSessions={false}
      devices={devices}
      onConnectDevice={vi.fn()}
      onStart={vi.fn().mockResolvedValue(undefined)}
      onScanListener={onScanListener}
      onCancel={vi.fn()}
      sessions={[]}
      activeId={null}
      onSelectSession={vi.fn()}
      onRemoveSession={vi.fn()}
      onRenameSession={vi.fn()}
      onGoHome={vi.fn()}
    />,
  );
}

describe('StartSessionScreen', () => {
  it('explains what a device vs a session is in the empty state (#203)', () => {
    const { container } = render(
      <StartSessionScreen
        hasSessions={false}
        devices={[]}
        onConnectDevice={vi.fn()}
        onStart={vi.fn().mockResolvedValue(undefined)}
        onScanListener={vi.fn()}
        onCancel={vi.fn()}
        sessions={[]}
        activeId={null}
        onSelectSession={vi.fn()}
        onRemoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onGoHome={vi.fn()}
      />,
    );
    // The empty state must proactively resolve the devices-vs-sessions confusion.
    const explainer = container.querySelector('.start-empty-explainer');
    expect(explainer?.textContent).toMatch(/weft start/i);
    expect(explainer?.textContent).toMatch(/live Copilot runs/i);
    expect(screen.getByText(/No devices saved yet/i)).toBeInTheDocument();
  });

  it('offers "Add device" next to the Device section even when devices already exist (#205)', () => {
    const onScanListener = vi.fn();
    renderScreen([makeDevice()], onScanListener);

    const addBtn = screen.getByRole('button', { name: /add a new device/i });
    expect(addBtn).toBeInTheDocument();
    fireEvent.click(addBtn);
    expect(onScanListener).toHaveBeenCalledTimes(1);
  });
});

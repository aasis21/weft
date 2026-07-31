import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from '@/ui/settings/SettingsScreen';

const devices = [
  {
    channelId: 'ch-a',
    name: 'Work laptop',
    appVersion: '0.9.1',
    connected: true,
    lastSeenAt: Date.now(),
    projects: [],
    projectsLoading: false,
  },
  {
    channelId: 'ch-b',
    name: 'Old laptop',
    connected: false,
    lastSeenAt: 0,
    projects: [],
    projectsLoading: false,
  },
];

const snapshot = { ready: true, activeId: null, sessions: [], devices };

vi.mock('@/session/runtime/instance', () => ({
  sessionRuntime: {
    subscribe: () => () => {},
    getSnapshot: () => snapshot,
  },
}));

describe('SettingsScreen', () => {
  it('lists every paired device with its build, not just the laptop that opened Settings', () => {
    render(<SettingsScreen onClose={vi.fn()} laptopVersion="0.9.1" />);

    expect(screen.getByText('Work laptop')).toBeInTheDocument();
    expect(screen.getByText('0.9.1')).toBeInTheDocument();
    // A device that has never reported a version says so rather than borrowing another's.
    expect(screen.getByText('Old laptop')).toBeInTheDocument();
    expect(screen.getByText('Unknown')).toBeInTheDocument();
  });

  it('carries the in-session Vox controls, so the two panels cannot disagree', () => {
    render(<SettingsScreen onClose={vi.fn()} />);

    expect(screen.getByText('Keep listening')).toBeInTheDocument();
    expect(screen.getByText('Hold the mic open')).toBeInTheDocument();
    expect(screen.getByText('Pause before sending')).toBeInTheDocument();
    expect(screen.getByText('Speak as it writes')).toBeInTheDocument();
  });
});

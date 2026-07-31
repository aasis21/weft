import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SettingsScreen } from '@/ui/settings/SettingsScreen';

const devices = [
  {
    channelId: 'ch-a',
    name: 'Work laptop',
    appVersion: '0.9.1',
    transport: { kind: 'supabase' },
    connected: true,
    lastSeenAt: Date.now(),
    projects: [],
    projectsLoading: false,
  },
  {
    channelId: 'ch-b',
    name: 'Old laptop',
    transport: { kind: 'devtunnel' },
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

  it('offers the speech language here, where a set-once choice belongs', () => {
    render(<SettingsScreen onClose={vi.fn()} />);

    expect(screen.getByText('Speech language')).toBeInTheDocument();
    const group = screen.getByRole('radiogroup', { name: 'Speech language' });
    expect(within(group).getByText('English (India)')).toBeInTheDocument();
    expect(within(group).getByText('हिंदी')).toBeInTheDocument();
  });

  it('names the transport each laptop is paired over', () => {
    render(<SettingsScreen onClose={vi.fn()} />);

    expect(screen.getByText('Supabase relay')).toBeInTheDocument();
    expect(screen.getByText('Dev tunnel')).toBeInTheDocument();
  });

  it('warns when a laptop reports a different build than this phone', () => {
    render(<SettingsScreen onClose={vi.fn()} />);

    // The phone is on the dev/test build, the laptop claims 0.9.1 — the mismatch is the single most
    // common cause of "paired but nothing happens", so it is stated rather than left to be diffed.
    expect(screen.getByRole('status')).toHaveTextContent(/different build/i);
  });

  it('only offers the sessions hamburger when the host screen can open a drawer', () => {
    const onOpenDrawer = vi.fn();
    const onClose = vi.fn();
    const { unmount } = render(<SettingsScreen onClose={onClose} onOpenDrawer={onOpenDrawer} />);

    fireEvent.click(screen.getByRole('button', { name: 'Open sessions' }));
    // Settings closes first: the drawer must not slide out underneath a modal that is still up.
    expect(onClose).toHaveBeenCalled();
    expect(onOpenDrawer).toHaveBeenCalled();

    unmount();
    render(<SettingsScreen onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: 'Open sessions' })).not.toBeInTheDocument();
  });
});

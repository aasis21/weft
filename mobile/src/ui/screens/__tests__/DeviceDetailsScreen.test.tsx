import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StoredSession } from '@aasis21/weft-shared';
import { DeviceDetailsScreen } from '../DeviceDetailsScreen';
import type { ListenerDeviceState } from '@/session/model';

function storedSession(partial: Partial<StoredSession> & { sessionId: string }): StoredSession {
  return {
    title: null,
    cwd: 'C:\\CLP\\ModernOrder',
    repository: 'ModernOrder',
    branch: 'main',
    updatedAt: null,
    ...partial,
  };
}

const sessions: StoredSession[] = [
  storedSession({ sessionId: 'a', title: 'Fix the auth bug' }),
  storedSession({ sessionId: 'b', title: 'Add retries', branch: 'users/me/retry' }),
  storedSession({ sessionId: 'c', title: 'Weft pairing', cwd: '/home/me/weft', repository: 'weft' }),
];

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
    device: makeDevice({ sessions }),
    activeId: null,
    sessions: [],
    devices: [],
    onRefreshProjects: vi.fn(),
    onRefreshSessions: vi.fn(),
    onResumeSession: vi.fn(),
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

function resumeTitles(): string[] {
  const list = document.querySelector('.device-resume .device-sessions-list');
  if (!list) return [];
  return [...list.querySelectorAll('.device-card-name')].map((el) => el.textContent ?? '');
}

describe('DeviceDetailsScreen — resumable-session filters', () => {
  it('hides the controls until the list has been loaded', () => {
    renderDetails({ device: makeDevice({ sessions: undefined }) });
    expect(screen.queryByLabelText(/search recent sessions/i)).toBeNull();
    expect(screen.getByText(/tap load to fetch/i)).toBeTruthy();
  });

  it('narrows the list as you type and restores it when cleared', () => {
    renderDetails();
    expect(resumeTitles()).toEqual(['Fix the auth bug', 'Add retries', 'Weft pairing']);

    fireEvent.change(screen.getByLabelText(/search recent sessions/i), { target: { value: 'retry' } });
    expect(resumeTitles()).toEqual(['Add retries']);
    expect(screen.getByText(/showing 1 of 3/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(resumeTitles()).toEqual(['Fix the auth bug', 'Add retries', 'Weft pairing']);
    expect(screen.queryByText(/showing/i)).toBeNull();
  });

  it('offers each distinct folder with its session count and filters on it', () => {
    renderDetails();
    const picker = screen.getByLabelText(/filter recent sessions by folder/i) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toEqual(['All folders (3)', 'ModernOrder (2)', 'weft (1)']);

    fireEvent.change(picker, { target: { value: '/home/me/weft' } });
    expect(resumeTitles()).toEqual(['Weft pairing']);
  });

  it('shows a filter-specific empty state rather than the "none found" one', () => {
    renderDetails();
    fireEvent.change(screen.getByLabelText(/search recent sessions/i), { target: { value: 'zzz' } });
    expect(resumeTitles()).toEqual([]);
    expect(screen.getByText(/no sessions match this filter/i)).toBeTruthy();
    expect(screen.queryByText(/no resumable sessions found/i)).toBeNull();
  });

  it('falls back to all folders when a refresh drops the selected folder', () => {
    const { rerender, props } = renderDetails();
    fireEvent.change(screen.getByLabelText(/filter recent sessions by folder/i), { target: { value: '/home/me/weft' } });
    expect(resumeTitles()).toEqual(['Weft pairing']);

    const refreshed = sessions.filter((s) => s.cwd !== '/home/me/weft');
    rerender(<DeviceDetailsScreen {...props} device={makeDevice({ sessions: refreshed })} />);

    expect(resumeTitles()).toEqual(['Fix the auth bug', 'Add retries']);
    const picker = screen.getByLabelText(/filter recent sessions by folder/i) as HTMLSelectElement;
    expect(picker.value).toBe('all');
  });

  it('resumes the session the filtered row points at, not the one at that index unfiltered', () => {
    const onResumeSession = vi.fn();
    renderDetails({ onResumeSession });
    fireEvent.change(screen.getByLabelText(/search recent sessions/i), { target: { value: 'weft' } });

    const list = document.querySelector('.device-resume .device-sessions-list') as HTMLElement;
    fireEvent.click(within(list).getByRole('button'));

    expect(onResumeSession).toHaveBeenCalledWith('chan-1', 'c', 'allow-all', 'Weft pairing', '/home/me/weft');
  });
});

describe('DeviceDetailsScreen — the folder picker opens on the device default', () => {
  const withDefault = (path: string, sessionList: StoredSession[] | undefined = sessions): ListenerDeviceState =>
    makeDevice({
      sessions: sessionList,
      projects: [
        { path: 'C:\\CLP\\Other', name: 'Other', isDefault: false },
        { path, name: 'Default', isDefault: true },
      ],
    });

  it('preselects the configured default instead of showing every folder', () => {
    renderDetails({ device: withDefault('/home/me/weft') });

    const picker = screen.getByLabelText(/filter recent sessions by folder/i) as HTMLSelectElement;
    expect(picker.value).toBe('/home/me/weft');
    expect(resumeTitles()).toEqual(['Weft pairing']);
  });

  it('counts the preselected default as filtering, so the count line and Clear are offered', () => {
    renderDetails({ device: withDefault('/home/me/weft') });
    expect(screen.getByText(/showing 1 of 3/i)).toBeTruthy();
  });

  it('returns to the default on Clear rather than widening to all folders', () => {
    renderDetails({ device: withDefault('/home/me/weft') });
    fireEvent.change(screen.getByLabelText(/filter recent sessions by folder/i), {
      target: { value: 'C:\\CLP\\ModernOrder' },
    });
    expect(resumeTitles()).toEqual(['Fix the auth bug', 'Add retries']);

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect((screen.getByLabelText(/filter recent sessions by folder/i) as HTMLSelectElement).value).toBe(
      '/home/me/weft',
    );
  });

  it('offers a default folder with nothing in it, and shows it empty rather than showing everything', () => {
    renderDetails({ device: withDefault('C:\\CLP\\Untouched') });

    const picker = screen.getByLabelText(/filter recent sessions by folder/i) as HTMLSelectElement;
    expect([...picker.options].map((o) => o.textContent)).toContain('Untouched (0)');
    expect(picker.value).toBe('C:\\CLP\\Untouched');
    expect(resumeTitles()).toEqual([]);
  });

  it('does not yank a folder the user chose when a later projects refresh lands', () => {
    const { rerender, props } = renderDetails({ device: withDefault('/home/me/weft') });
    fireEvent.change(screen.getByLabelText(/filter recent sessions by folder/i), {
      target: { value: 'C:\\CLP\\ModernOrder' },
    });

    rerender(<DeviceDetailsScreen {...props} device={withDefault('C:\\CLP\\Other')} />);

    expect((screen.getByLabelText(/filter recent sessions by folder/i) as HTMLSelectElement).value).toBe(
      'C:\\CLP\\ModernOrder',
    );
  });

  it('leaves the picker on all folders when the device has no default configured', () => {
    renderDetails();
    expect((screen.getByLabelText(/filter recent sessions by folder/i) as HTMLSelectElement).value).toBe('all');
  });
});

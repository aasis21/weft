import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LifecycleStatusMsg, StoredSession } from '@aasis21/weft-shared';
import { StartSessionScreen } from '../StartSessionScreen';
import { sessionListScopeKey, type ListenerDeviceState } from '@/session/model';
import type { SessionView } from '@/session/view';

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

const stored: StoredSession[] = [
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
    projects: [{ name: 'demo', path: 'C:\\repos\\demo', isDefault: true }],
    projectsLoading: false,
    connected: true,
    events: [],
    ...overrides,
  };
}

type Props = ComponentProps<typeof StartSessionScreen>;

function lifecycleStatus(
  overrides: Partial<LifecycleStatusMsg> = {},
): LifecycleStatusMsg {
  return {
    operationId: 'open-1',
    fingerprint: 'fingerprint-1',
    state: 'launching',
    revision: 1,
    ...overrides,
  };
}

function renderScreen(overrides: Partial<Props> = {}) {
  const props: Props = {
    devices: [makeDevice()],
    onConnectDevice: vi.fn(),
    onOpen: vi.fn().mockResolvedValue(lifecycleStatus()),
    onConfirmTakeover: vi.fn().mockResolvedValue(lifecycleStatus({ action: 'takeover' })),
    onRefreshSessions: vi.fn(),
    onScanListener: vi.fn(),
    sessions: [],
    activeId: null,
    onSelectSession: vi.fn(),
    onRemoveSession: vi.fn(),
    onRenameSession: vi.fn(),
    onGoHome: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<StartSessionScreen {...props} />) };
}

/** A device whose store list is loaded and whose configured default is `defaultPath`. */
function resumeDevice(defaultPath: string, sessions: StoredSession[] | null = stored): ListenerDeviceState {
  const device = makeDevice({
    projects: [
      { path: 'C:\\CLP\\Other', name: 'Other', isDefault: false },
      { path: defaultPath, name: 'Default', isDefault: true },
    ],
  });
  return sessions === null
    ? device
    : {
        ...device,
        sessionLists: {
          [sessionListScopeKey(defaultPath, 'activity')]: {
            sessions,
            receivedAt: Date.now(),
            loading: false,
          },
          [sessionListScopeKey(defaultPath, 'created')]: {
            sessions,
            receivedAt: Date.now(),
            loading: false,
          },
        },
      };
}

function rowTitles(): string[] {
  return [...document.querySelectorAll('.start-continue-title')].map((el) => el.textContent ?? '');
}

const folderPicker = (): HTMLSelectElement => screen.getByLabelText(/^folder$/i) as HTMLSelectElement;
const send = (): HTMLButtonElement => document.querySelector('.start-composer .send-btn') as HTMLButtonElement;
const composer = (): HTMLTextAreaElement => screen.getByLabelText(/first message/i) as HTMLTextAreaElement;

const controllerConflict = lifecycleStatus({
  state: 'activating',
  failure: {
    code: 'controller-conflict',
    actions: ['confirm-takeover', 'cancel'],
    message: 'That session is already running on this laptop and connected to a phone.',
  },
  challenge: {
    challengeId: 'challenge-1',
    operationId: 'open-1',
    revision: 1,
    storeAuthority: null,
    sessionId: 'a',
    runtimeInstanceId: 'runtime-1',
    generation: 1,
    pid: 42,
    processStartedAt: 10,
    responsive: true,
  },
});

describe('StartSessionScreen', () => {
  it('explains what a device vs a session is in the empty state (#203)', () => {
    const { container } = renderScreen({ devices: [] });
    const explainer = container.querySelector('.start-empty-explainer');
    expect(explainer?.textContent).toMatch(/weft start/i);
    expect(explainer?.textContent).toMatch(/live Copilot runs/i);
    expect(screen.getByText(/No devices saved yet/i)).toBeInTheDocument();
  });

  it('shows one page with device and folder pickers, a composer and no name, tabs or add-device', () => {
    renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder')] });
    expect(screen.getByLabelText(/^device$/i)).toBeInTheDocument();
    expect(folderPicker().value).toBe('Default');
    expect(composer()).toBeInTheDocument();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByLabelText(/name/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /add device/i })).toBeNull();
  });

  it('preselects the device it was opened for', () => {
    renderScreen({
      devices: [makeDevice(), makeDevice({ channelId: 'chan-2', name: 'Studio', isDefault: false })],
      initialChannelId: 'chan-2',
    });
    expect((screen.getByLabelText(/^device$/i) as HTMLSelectElement).value).toBe('chan-2');
  });

  it('keeps Weft navigation on the shared header and lets plus focus the existing draft', () => {
    const onOpenExplore = vi.fn();
    renderScreen({
      initialMessage: 'Keep this draft',
      onOpenExplore,
      onManageDevices: vi.fn(),
    });

    expect(screen.getByText('Weft')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open sessions/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open explore/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /scan to connect/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open explore/i }));
    expect(onOpenExplore).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: /write a new session prompt/i }));
    expect(composer()).toHaveValue('Keep this draft');
    expect(composer()).toHaveFocus();
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /more/i }));
    const devicesItem = screen.getByRole('menuitem', { name: /^devices$/i });
    const settingsItem = screen.getByRole('menuitem', { name: /^settings$/i });
    expect(devicesItem).toBeInTheDocument();
    expect(settingsItem).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /about weft/i })).toBeInTheDocument();
    devicesItem.focus();
    fireEvent.keyDown(devicesItem, { key: 'ArrowDown' });
    expect(settingsItem).toHaveFocus();
    fireEvent.keyDown(settingsItem, { key: 'ArrowUp' });
    expect(devicesItem).toHaveFocus();
  });

  it('offers a tap-to-fill starter prompt without pre-filling the composer', () => {
    const onDraftChange = vi.fn();
    renderScreen({ onDraftChange });

    expect(composer()).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /try: summarize this repository/i }));
    expect(composer()).toHaveValue('Summarize this repository');
    expect(onDraftChange).toHaveBeenLastCalledWith('Summarize this repository');
    expect(composer()).toHaveFocus();
  });

  it('labels send by whether there is a message, and keeps it inert while the device is offline', () => {
    renderScreen();
    expect(send()).toHaveAccessibleName('Start session');
    fireEvent.change(composer(), { target: { value: 'Fix the flaky test' } });
    expect(send()).toHaveAccessibleName('Start & send');

    renderScreen({ devices: [makeDevice({ channelId: 'chan-off', connected: false })] });
    expect(document.querySelectorAll('.start-composer .send-btn')[1]).toBeDisabled();
  });

  it('starts a new session with no name, the first message and the chosen permission', async () => {
    const { props } = renderScreen();
    fireEvent.change(composer(), { target: { value: '  Fix the flaky test  ' } });
    fireEvent.click(screen.getByRole('button', { name: /permissions: ask first/i }));
    expect(screen.getByRole('button', { name: /permissions: allow all/i })).toHaveClass('auto');
    fireEvent.click(send());

    await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith({
      deviceChannelId: 'chan-1',
      target: { kind: 'new', projectName: 'demo' },
      mode: 'allow-all',
      name: null,
      initialPrompt: 'Fix the flaky test',
    }));
  });

  it('starts from the device default permission mode', () => {
    renderScreen({ devices: [makeDevice({ defaultPermissionMode: 'allow-all' })] });
    expect(screen.getByRole('button', { name: /permissions: allow all/i })).toBeInTheDocument();
  });

  it('keeps the draft when the launch is refused', async () => {
    const onOpen = vi.fn().mockResolvedValue(lifecycleStatus({
      state: 'failed',
      failure: { code: 'directory-not-found', actions: ['cancel'], message: 'The folder no longer exists: /gone' },
    }));
    renderScreen({ onOpen });
    fireEvent.change(composer(), { target: { value: 'Keep me' } });
    fireEvent.click(send());

    await waitFor(() => expect(screen.getByText(/no longer exists/i)).toBeTruthy());
    expect(composer().value).toBe('Keep me');
    expect(send()).not.toBeDisabled();
  });

  it('loads the folder\'s sessions on its own, scoped to the selected folder', () => {
    const onRefreshSessions = vi.fn();
    renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder', null)], onRefreshSessions });
    expect(onRefreshSessions).toHaveBeenCalledTimes(1);
    expect(onRefreshSessions).toHaveBeenCalledWith('chan-1', 'C:\\CLP\\ModernOrder', 'activity');
    expect(screen.getByRole('list', { name: /loading sessions/i })).toBeInTheDocument();
  });

  it('keeps cached sessions visible and announces a slow refresh after one second', () => {
    vi.useFakeTimers();
    try {
      const base = resumeDevice('C:\\CLP\\ModernOrder');
      const key = sessionListScopeKey('C:\\CLP\\ModernOrder', 'activity');
      const cached = base.sessionLists?.[key];
      const view = renderScreen({
        devices: [{
          ...base,
          sessionLists: {
            ...base.sessionLists,
            [key]: { ...cached, loading: true },
          },
        }],
      });

      expect(rowTitles()).toEqual(['Fix the auth bug', 'Add retries']);
      expect(screen.queryByText('Updating…')).toBeNull();
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getByRole('status')).toHaveTextContent('Updating…');
      expect(rowTitles()).toEqual(['Fix the auth bug', 'Add retries']);
      view.unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps cached results and exposes retry after a failed refresh', () => {
    const onRefreshSessions = vi.fn();
    const base = resumeDevice('C:\\CLP\\ModernOrder');
    const key = sessionListScopeKey('C:\\CLP\\ModernOrder', 'activity');
    const cached = base.sessionLists?.[key];
    renderScreen({
      devices: [{
        ...base,
        sessionLists: {
          ...base.sessionLists,
          [key]: { ...cached, error: 'request-failed', loading: false },
        },
      }],
      onRefreshSessions,
    });

    expect(rowTitles()).toEqual(['Fix the auth bug', 'Add retries']);
    expect(screen.getByRole('status')).toHaveTextContent('Showing saved results.');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRefreshSessions).toHaveBeenLastCalledWith('chan-1', 'C:\\CLP\\ModernOrder', 'activity');
  });

  it('shows a retryable failure instead of an empty-list message on the first failed fetch', () => {
    const base = resumeDevice('C:\\CLP\\ModernOrder', null);
    const key = sessionListScopeKey('C:\\CLP\\ModernOrder', 'activity');
    renderScreen({
      devices: [{
        ...base,
        sessionLists: { [key]: { loading: false, error: 'session-store-unavailable' } },
      }],
    });
    expect(screen.getByText('Couldn’t load recent sessions.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
    expect(screen.queryByText(/no sessions in default yet/i)).toBeNull();
  });

  it('does not fetch while the device is offline', () => {
    const onRefreshSessions = vi.fn();
    renderScreen({ devices: [makeDevice({ connected: false })], onRefreshSessions });
    expect(onRefreshSessions).not.toHaveBeenCalled();
    expect(screen.getByText(/sessions appear when macbook pro is online/i)).toBeInTheDocument();
  });

  it('does not ask again when the folder genuinely has no sessions', () => {
    const onRefreshSessions = vi.fn();
    const { rerender, props } = renderScreen({ devices: [resumeDevice('C:\\CLP\\Empty', null)], onRefreshSessions });
    rerender(<StartSessionScreen {...props} devices={[resumeDevice('C:\\CLP\\Empty', [])]} />);
    expect(onRefreshSessions).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/no sessions in default yet/i)).toBeInTheDocument();
  });

  it('refetches on reconnect, on a new attempt and when the page becomes visible', () => {
    const onRefreshSessions = vi.fn();
    const base = resumeDevice('C:\\CLP\\ModernOrder');
    const { rerender, props } = renderScreen({ devices: [base], onRefreshSessions });
    expect(onRefreshSessions).toHaveBeenCalledTimes(1);

    rerender(<StartSessionScreen {...props} devices={[{ ...base, connected: false }]} />);
    rerender(<StartSessionScreen {...props} devices={[{ ...base, connected: true }]} />);
    expect(onRefreshSessions).toHaveBeenCalledTimes(2);

    rerender(<StartSessionScreen {...props} devices={[{ ...base, lastAttemptAt: 99 }]} />);
    expect(onRefreshSessions).toHaveBeenCalledTimes(3);

    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(onRefreshSessions).toHaveBeenCalledTimes(4);
  });

  it('follows the folder picker: refetches and lists only that folder\'s sessions', () => {
    const onRefreshSessions = vi.fn();
    renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder')], onRefreshSessions });
    expect(screen.getByRole('heading', { name: /continue in default/i })).toBeInTheDocument();
    expect(rowTitles()).toEqual(['Fix the auth bug', 'Add retries']);

    fireEvent.change(folderPicker(), { target: { value: 'Other' } });
    expect(onRefreshSessions).toHaveBeenLastCalledWith('chan-1', 'C:\\CLP\\Other', 'activity');
    expect(rowTitles()).toEqual([]);
    // Placeholders, not "No sessions", until the laptop answers for the new folder.
    expect(screen.getByRole('list', { name: /loading sessions/i })).toBeInTheDocument();
    expect(screen.queryByText(/no sessions in/i)).toBeNull();
  });

  it('filters the folder\'s sessions by search', () => {
    renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder')] });
    fireEvent.click(screen.getByRole('button', { name: /search sessions/i }));
    fireEvent.change(screen.getByLabelText(/search recent sessions/i), { target: { value: 'retry' } });
    expect(rowTitles()).toEqual(['Add retries']);
  });

  it('sorts by latest activity or creation and requests the corresponding folder page', () => {
    const sessions = [
      storedSession({ sessionId: 'old', title: 'Older creation, recent activity', createdAt: 100, updatedAt: 400 }),
      storedSession({ sessionId: 'new', title: 'Newest creation', createdAt: 300, updatedAt: 300 }),
    ];
    const { props } = renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder', sessions)] });
    expect(rowTitles()).toEqual(['Older creation, recent activity', 'Newest creation']);
    fireEvent.change(screen.getByLabelText('Sort sessions'), { target: { value: 'created' } });
    expect(rowTitles()).toEqual(['Newest creation', 'Older creation, recent activity']);
    expect(props.onRefreshSessions).toHaveBeenLastCalledWith('chan-1', 'C:\\CLP\\ModernOrder', 'created');
    expect(sessions.map((session) => session.sessionId)).toEqual(['old', 'new']);
  });

  it('opens with search showing when sent from "Continue session"', () => {
    renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder')], initialMode: 'resume' });
    expect(screen.getByLabelText(/search recent sessions/i)).toBeInTheDocument();
  });

  it('opens a past session in one tap', async () => {
    const { props } = renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder')] });
    fireEvent.click(screen.getByRole('button', { name: /add retries/i }));
    await waitFor(() => expect(props.onOpen).toHaveBeenCalledWith(expect.objectContaining({
      deviceChannelId: 'chan-1',
      target: { kind: 'existing', storeAuthority: null, sessionId: 'b' },
      title: 'Add retries',
      cwd: 'C:\\CLP\\ModernOrder',
    })));
  });

  it('marks a session that is already open on this phone', () => {
    renderScreen({
      devices: [resumeDevice('C:\\CLP\\ModernOrder')],
      sessions: [{ meta: { sessionId: 'a' } } as unknown as SessionView],
    });
    expect(screen.getByRole('button', { name: /fix the auth bug/i }).textContent).toMatch(/open on this phone/i);
  });

  it('offers the takeover when the session is already attached elsewhere', async () => {
    const onOpen = vi.fn().mockResolvedValue(controllerConflict);
    const onConfirmTakeover = vi.fn().mockResolvedValue(lifecycleStatus({ action: 'takeover' }));
    renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder')], onOpen, onConfirmTakeover });

    fireEvent.click(screen.getByRole('button', { name: /fix the auth bug/i }));
    await waitFor(() => expect(screen.getByText(/already running/i)).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /close it and open here/i }));
    await waitFor(() => expect(onConfirmTakeover).toHaveBeenCalledWith('open-1'));
  });

  it('does not offer the takeover for an ordinary failure', async () => {
    const onOpen = vi.fn().mockResolvedValue(lifecycleStatus({
      state: 'failed',
      failure: { code: 'directory-not-found', actions: ['choose-directory', 'cancel'], message: "The session's folder no longer exists: /gone" },
    }));
    renderScreen({ devices: [resumeDevice('C:\\CLP\\ModernOrder')], onOpen });
    fireEvent.click(screen.getByRole('button', { name: /fix the auth bug/i }));
    await waitFor(() => expect(screen.getByText(/no longer exists/i)).toBeTruthy());
    expect(screen.queryByRole('button', { name: /close it and open here/i })).toBeNull();
  });
});
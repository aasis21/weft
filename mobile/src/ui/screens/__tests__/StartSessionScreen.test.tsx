import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { StoredSession } from '@aasis21/weft-shared';
import { StartSessionScreen } from '../StartSessionScreen';
import type { ListenerDeviceState } from '@/session/model';
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

function renderScreen(overrides: Partial<Props> = {}) {
  const props: Props = {
    hasSessions: false,
    devices: [makeDevice()],
    onConnectDevice: vi.fn(),
    onStart: vi.fn().mockResolvedValue(undefined),
    onRefreshSessions: vi.fn(),
    onResume: vi.fn().mockResolvedValue(undefined),
    onOpenSession: vi.fn(),
    onScanListener: vi.fn(),
    onCancel: vi.fn(),
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
function resumeDevice(defaultPath: string, sessions: StoredSession[] | undefined = stored): ListenerDeviceState {
  return makeDevice({
    sessions,
    projects: [
      { path: 'C:\\CLP\\Other', name: 'Other', isDefault: false },
      { path: defaultPath, name: 'Default', isDefault: true },
    ],
  });
}

function rowTitles(): string[] {
  const list = document.querySelector('.device-sessions-list');
  if (!list) return [];
  return [...list.querySelectorAll('.device-card-name')].map((el) => el.textContent ?? '');
}

const folderPicker = (): HTMLSelectElement => screen.getByLabelText(/^folder$/i) as HTMLSelectElement;
const cta = (): HTMLButtonElement =>
  document.querySelector('.start-footer .session-primary-action') as HTMLButtonElement;

describe('StartSessionScreen', () => {
  it('explains what a device vs a session is in the empty state (#203)', () => {
    const { container } = renderScreen({ devices: [] });
    const explainer = container.querySelector('.start-empty-explainer');
    expect(explainer?.textContent).toMatch(/weft start/i);
    expect(explainer?.textContent).toMatch(/live Copilot runs/i);
    expect(screen.getByText(/No devices saved yet/i)).toBeInTheDocument();
  });

  it('offers "Add device" next to the Device section even when devices already exist (#205)', () => {
    const onScanListener = vi.fn();
    renderScreen({ onScanListener });

    const addBtn = screen.getByRole('button', { name: /add a new device/i });
    expect(addBtn).toBeInTheDocument();
    fireEvent.click(addBtn);
    expect(onScanListener).toHaveBeenCalledTimes(1);
  });
});

describe('StartSessionScreen — new and resume are two shapes of one flow', () => {
  it('opens on New, and swaps only the middle step when you switch to Resume', () => {
    renderScreen({ devices: [resumeDevice('/home/me/weft')] });

    // Device and Options are shared; only the folder step differs.
    expect(screen.getByRole('tab', { name: /new session/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText(/^2\. Folder$/)).toBeTruthy();
    expect(screen.getByLabelText(/session name/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /^resume$/i }));
    expect(screen.getByText(/2\. Folder & session/)).toBeTruthy();
    // A resumed session already has a name — the CLI's own title wins once it pairs.
    expect(screen.queryByLabelText(/session name/i)).toBeNull();
    expect(screen.getByRole('radiogroup', { name: /^device$/i })).toBeTruthy();
  });

  it('can open straight onto the Resume tab', () => {
    renderScreen({ devices: [resumeDevice('/home/me/weft')], initialMode: 'resume' });
    expect(screen.getByRole('tab', { name: /^resume$/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('labels the permission toggle and opens on the safe mode in both tabs', () => {
    // It used to sit bare and unlabelled next to a folder filter, reading as another filter chip
    // pair — and the resume copy reset to allow-all on every visit.
    renderScreen({ devices: [resumeDevice('/home/me/weft')], initialMode: 'resume' });
    expect(screen.getByRole('radiogroup', { name: /permissions/i })).toBeTruthy();
    expect(screen.getByRole('radio', { name: /^default$/i })).toHaveAttribute('aria-checked', 'true');
  });

  it('names the device in the call to action, and says which thing it will do', () => {
    renderScreen({ devices: [resumeDevice('/home/me/weft')] });
    expect(cta().textContent).toMatch(/start on macbook pro/i);

    fireEvent.click(screen.getByRole('tab', { name: /^resume$/i }));
    fireEvent.click(screen.getByRole('radio', { name: /weft pairing/i }));
    expect(cta().textContent).toMatch(/resume on macbook pro/i);
  });
});

describe('StartSessionScreen — the resumable list', () => {
  it('asks before loading, because the store is large and the reply is asynchronous', () => {
    const onRefreshSessions = vi.fn();
    renderScreen({ devices: [makeDevice({ sessions: undefined })], initialMode: 'resume', onRefreshSessions });

    expect(screen.getByText(/tap load to fetch/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^load$/i }));
    expect(onRefreshSessions).toHaveBeenCalledWith('chan-1');
  });

  it('narrows the list as you type and restores it when cleared', () => {
    renderScreen({ devices: [makeDevice({ sessions: stored, projects: [] })], initialMode: 'resume' });
    expect(rowTitles()).toEqual(['Fix the auth bug', 'Add retries', 'Weft pairing']);

    fireEvent.change(screen.getByLabelText(/search recent sessions/i), { target: { value: 'retry' } });
    expect(rowTitles()).toEqual(['Add retries']);
    expect(screen.getByText(/showing 1 of 3/i)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(rowTitles()).toEqual(['Fix the auth bug', 'Add retries', 'Weft pairing']);
    expect(screen.queryByText(/showing/i)).toBeNull();
  });

  it('offers registered projects above folders the store merely happens to know about', () => {
    // The two sets diverge: the store knows every cwd a session ever ran in, registered or not.
    // Resume needs the union, or the folder you are most likely to want is missing whenever it has
    // nothing resumable in it yet.
    renderScreen({ devices: [resumeDevice('C:\\CLP\\Untouched')], initialMode: 'resume' });

    expect([...folderPicker().options].map((o) => o.textContent)).toEqual([
      'All folders (3)',
      'Other (0)',
      'Untouched (0)',
      'ModernOrder (2)',
      'weft (1)',
    ]);
  });

  it('opens on the device default and shows it empty rather than widening to everything', () => {
    renderScreen({ devices: [resumeDevice('C:\\CLP\\Untouched')], initialMode: 'resume' });
    expect(folderPicker().value).toBe('C:\\CLP\\Untouched');
    expect(rowTitles()).toEqual([]);
  });

  it('returns to the default on Clear rather than widening to all folders', () => {
    renderScreen({ devices: [resumeDevice('/home/me/weft')], initialMode: 'resume' });
    expect(folderPicker().value).toBe('/home/me/weft');
    expect(rowTitles()).toEqual(['Weft pairing']);

    fireEvent.change(folderPicker(), { target: { value: 'C:\\CLP\\ModernOrder' } });
    expect(rowTitles()).toEqual(['Fix the auth bug', 'Add retries']);

    fireEvent.click(screen.getByRole('button', { name: /^clear$/i }));
    expect(folderPicker().value).toBe('/home/me/weft');
  });

  it('does not yank a folder the user chose when a later projects refresh lands', () => {
    const { rerender, props } = renderScreen({ devices: [resumeDevice('/home/me/weft')], initialMode: 'resume' });
    fireEvent.change(folderPicker(), { target: { value: 'C:\\CLP\\ModernOrder' } });

    rerender(<StartSessionScreen {...props} devices={[resumeDevice('C:\\CLP\\Other')]} />);

    expect(folderPicker().value).toBe('C:\\CLP\\ModernOrder');
  });

  it('resumes the session the filtered row points at, not the one at that index unfiltered', async () => {
    const onResume = vi.fn().mockResolvedValue(undefined);
    renderScreen({ devices: [makeDevice({ sessions: stored, projects: [] })], initialMode: 'resume', onResume });

    fireEvent.change(screen.getByLabelText(/search recent sessions/i), { target: { value: 'weft' } });
    fireEvent.click(screen.getByRole('radio', { name: /weft pairing/i }));
    fireEvent.click(cta());

    await waitFor(() =>
      expect(onResume).toHaveBeenCalledWith('chan-1', {
        sessionId: 'c',
        mode: 'default',
        title: 'Weft pairing',
        cwd: '/home/me/weft',
      }),
    );
  });

  it('opens a session the phone already holds instead of forking a second copy of it', () => {
    const onOpenSession = vi.fn();
    const onResume = vi.fn();
    const live = {
      meta: { channelId: 'chan-live', sessionId: 'b', title: 'Add retries' },
      timeline: { busy: false },
    } as unknown as SessionView;
    renderScreen({
      devices: [makeDevice({ sessions: stored, projects: [] })],
      sessions: [live],
      initialMode: 'resume',
      onOpenSession,
      onResume,
    });

    fireEvent.click(screen.getByRole('radio', { name: /add retries/i }));
    expect(cta().textContent).toMatch(/open add retries/i);
    fireEvent.click(cta());

    expect(onOpenSession).toHaveBeenCalledWith('chan-live');
    expect(onResume).not.toHaveBeenCalled();
  });

  it('offers the override when the laptop refuses because the session is already attached', async () => {
    // The laptop refuses to fork a second CLI onto a healthy attachment. But if weft over there has
    // broken, resuming is the only route back — so the refusal has to be recoverable, and the retry
    // has to be the user's own second, deliberate tap.
    const onResume = vi
      .fn()
      .mockRejectedValueOnce(new Error('That session is already running on this laptop and connected to a phone.'))
      .mockResolvedValueOnce(undefined);
    renderScreen({ devices: [makeDevice({ sessions: stored, projects: [] })], initialMode: 'resume', onResume });

    fireEvent.click(screen.getByRole('radio', { name: /fix the auth bug/i }));
    fireEvent.click(cta());

    await waitFor(() => expect(cta().textContent).toMatch(/close it and resume anyway/i));
    expect(screen.getByText(/already running/i)).toBeTruthy();
    expect(onResume.mock.calls[0]?.[1]).not.toHaveProperty('force');

    fireEvent.click(cta());
    await waitFor(() => expect(onResume).toHaveBeenCalledTimes(2));
    expect(onResume.mock.calls[1]?.[1]).toMatchObject({ sessionId: 'a', force: true });
  });

  it('does not offer the override for an ordinary failure', async () => {
    const onResume = vi.fn().mockRejectedValue(new Error("The session's folder no longer exists: /gone"));
    renderScreen({ devices: [makeDevice({ sessions: stored, projects: [] })], initialMode: 'resume', onResume });

    fireEvent.click(screen.getByRole('radio', { name: /fix the auth bug/i }));
    fireEvent.click(cta());

    await waitFor(() => expect(screen.getByText(/no longer exists/i)).toBeTruthy());
    expect(cta().textContent).not.toMatch(/anyway/i);
  });

  it('keeps the call to action inert until a session is picked', () => {
    renderScreen({ devices: [makeDevice({ sessions: stored, projects: [] })], initialMode: 'resume' });
    expect(cta()).toBeDisabled();

    fireEvent.click(screen.getByRole('radio', { name: /add retries/i }));
    expect(cta()).not.toBeDisabled();
  });

  it('drops a selection that the filter has scrolled out from under', () => {
    renderScreen({ devices: [makeDevice({ sessions: stored, projects: [] })], initialMode: 'resume' });
    fireEvent.click(screen.getByRole('radio', { name: /add retries/i }));
    expect(cta()).not.toBeDisabled();

    fireEvent.change(screen.getByLabelText(/search recent sessions/i), { target: { value: 'weft' } });
    expect(cta()).toBeDisabled();
  });
});

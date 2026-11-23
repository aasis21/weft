import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionScreen } from '@/ui/screens/SessionScreen';
import type { ListenerDeviceState } from '@/session/model';
import type { LifecycleStatusMsg } from '@aasis21/weft-shared';

const composerProps = vi.hoisted(() => ({ latest: null as null | { disabled: boolean; disabledReason?: string } }));
const drawerProps = vi.hoisted(() => ({ latest: null as null | { onRemove: (id: string) => void } }));
const statusProps = vi.hoisted(() => ({ latest: null as null | { onRemove: () => void } }));

vi.mock('@/ui/composer/Composer', () => ({
  Composer: (props: { disabled: boolean; disabledReason?: string }) => {
    composerProps.latest = props;
    return (
      <textarea
        aria-label="mock composer"
        disabled={props.disabled}
        placeholder={props.disabledReason === 'offline' ? 'Reconnecting… — hold on' : 'Message your Copilot session…'}
      />
    );
  },
}));

vi.mock('@/ui/thread/ChatThread', () => ({
  ChatThread: () => <div data-testid="thread" />,
}));

vi.mock('@/ui/diagnostics/DebugPanel', () => ({
  DebugPanel: () => null,
}));

vi.mock('@/ui/prompts/ElicitationCard', () => ({
  ElicitationCard: () => <div data-testid="elicitation" />,
}));

vi.mock('@/ui/sessions/WeftDrawer', () => ({
  WeftDrawer: (props: { onRemove: (id: string) => void }) => {
    drawerProps.latest = props;
    return (
      <div data-testid="drawer">
        <button type="button" data-testid="drawer-remove" onClick={() => props.onRemove('session-a')}>
          drawer remove
        </button>
      </div>
    );
  },
}));

vi.mock('@/ui/sessions/StatusBar', () => ({
  StatusBar: (props: { onRemove: () => void }) => {
    statusProps.latest = props;
    return (
      <div data-testid="status">
        <button type="button" data-testid="status-remove" onClick={() => props.onRemove()}>
          status remove
        </button>
      </div>
    );
  },
}));

function makeSession(status: 'live' | 'connecting' | 'idle' | 'ended' = 'live') {
  return {
    id: 'session-a',
    status,
    settling: false,
    error: null,
    meta: { kind: 'paired', title: 'Weft', cwd: 'C:\\Users\\akash\\weft' },
    timeline: {
      items: [],
      history: [],
      historyHasMore: false,
      historyLoading: false,
      approvals: [],
      approvalErrors: {},
      elicitations: [],
      elicitationErrors: {},
      busy: false,
      abortable: false,
      mode: 'interactive',
      endedReason: null,
    },
  };
}

function renderScreen(status: 'live' | 'connecting' | 'idle' | 'ended') {
  const active = makeSession(status);
  return renderActive(active);
}

it('reports the mounted chat as detail-visible, but not Explore or a replacing modal', () => {
  const visible = vi.fn();
  const view = renderActive(makeSession('live'), { onChatVisibilityChange: visible });
  expect(visible).toHaveBeenLastCalledWith('session-a');
  fireEvent.click(screen.getByTestId('status-remove'));
  expect(visible).toHaveBeenLastCalledWith(null);
  view.unmount();
  visible.mockClear();
  renderActive(makeSession('live'), { exploreOpen: true, onChatVisibilityChange: visible });
  expect(visible).toHaveBeenLastCalledWith(null);
});

function renderActive(active: ReturnType<typeof makeSession>, overrides: Partial<Parameters<typeof SessionScreen>[0]> = {}) {
  return render(
    <SessionScreen
      active={active as never}
      sessions={[active] as never}
      activeId="session-a"
      onPrompt={vi.fn()}
      onApprove={vi.fn()}
      onElicitationRespond={vi.fn()}
      onInterrupt={vi.fn()}
      onModeChange={vi.fn()}
      onCommand={vi.fn()}
      onRetry={vi.fn()}
      onSelectSession={vi.fn()}
      onAddSession={vi.fn()}
      onRemoveSession={vi.fn()}
      onRenameSession={vi.fn()}
      onReconnect={vi.fn()}
      onGoHome={vi.fn()}
      onLoadEarlier={vi.fn()}
      {...overrides}
    />,
  );
}

describe('SessionScreen composer liveness', () => {
  const device: ListenerDeviceState = {
    channelId: 'station-1',
    deviceId: 'laptop-1',
    name: 'Laptop',
    pub: 'pub',
    publicKeyB64: 'phone-pub',
    privateKeyJwk: {},
    transport: { kind: 'local' },
    savedAt: 1,
    projects: [],
    projectsLoading: false,
    connected: true,
    defaultPermissionMode: 'allow-all',
    events: [],
  };
  const closedSession = (status: 'ended' | 'idle' = 'ended', extra: Record<string, unknown> = {}) => ({
    ...makeSession(status === 'ended' ? 'ended' : 'idle'),
    ...(status === 'idle' ? { status: 'error' } : {}),
    meta: {
      ...makeSession().meta,
      kind: 'live',
      channelId: 'session-a',
      sessionId: 'saved-conversation',
      spawnedFromDeviceId: 'laptop-1',
    },
    ...extra,
  }) as never;

  it('replaces the offline banner and its buttons with one recovery bar on the composer', () => {
    const onRecover = vi.fn();
    const onReconnect = vi.fn();
    renderActive(closedSession('idle'), { devices: [device], onRecover, onReconnect });
    expect(screen.queryByRole('button', { name: 'Resume on laptop' })).toBeNull();
    expect(screen.queryByText(/reconnect to pick it back up/i)).toBeNull();
    const bar = screen.getByRole('status');
    expect(bar).toHaveAttribute('data-reason', 'offline');
    expect(within(bar).getByRole('button', { name: 'This session is offline' })).toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'Reconnect' }));
    expect(onRecover).toHaveBeenCalledWith('session-a');
    expect(onReconnect).not.toHaveBeenCalled();
  });

  it('offers Resume for an ended session with a known Station, through the same recover()', () => {
    const onRecover = vi.fn();
    renderActive(closedSession('ended'), { devices: [device], onRecover });
    const bar = screen.getByRole('status');
    expect(bar).toHaveAttribute('data-reason', 'ended');
    fireEvent.click(within(bar).getByRole('button', { name: 'Resume' }));
    expect(onRecover).toHaveBeenCalledWith('session-a');
  });

  it('streams recovery progress with a ✕ that cancels, and Take over that confirms', () => {
    const onCancelRecovery = vi.fn();
    const onConfirmRecoveryTakeover = vi.fn();
    const view = renderActive(
      closedSession('idle', { recovery: { phase: 'resuming', startedAt: 1, updatedAt: 1, deviceName: 'Laptop' } }),
      { devices: [device], onCancelRecovery, onConfirmRecoveryTakeover },
    );
    expect(screen.getByRole('status')).toHaveAttribute('data-reason', 'resuming');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelRecovery).toHaveBeenCalledWith('session-a');
    view.unmount();

    renderActive(
      closedSession('idle', { recovery: { phase: 'controller-conflict', startedAt: 1, updatedAt: 1, challengeId: 'c-1' } }),
      { devices: [device], onCancelRecovery, onConfirmRecoveryTakeover },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(onConfirmRecoveryTakeover).toHaveBeenCalledWith('session-a');
  });

  it('shows no recovery bar for a linked session', () => {
    renderScreen('live');
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('keeps the explicit takeover confirmation for a launch placeholder', async () => {
    const blocked: LifecycleStatusMsg = {
      requestId: 'resume-1',
      revision: 2,
      stage: 'awaiting-confirmation',
      outcome: null,
      reason: 'controller-conflict',
      result: { challenge: { challengeId: 'challenge-1', runtimeId: 'runtime-1', controllerRevision: 3 } },
    };
    const onConfirmTakeover = vi.fn().mockResolvedValue({ ...blocked, stage: 'preparing-link', reason: null, result: null });
    renderActive(
      { ...makeSession('connecting'), status: 'initializing', meta: { ...makeSession().meta, kind: 'spawning', channelId: 'session-a' } } as never,
      { devices: [device], sessionOperation: blocked, onConfirmTakeover },
    );
    expect(screen.getByText('Another phone is using this session.')).toBeInTheDocument();
    expect(onConfirmTakeover).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close it and open here' }));
    await waitFor(() => expect(onConfirmTakeover).toHaveBeenCalledWith('resume-1'));
  });

  it('pull-to-refresh hands the gesture to refresh (recent turns when linked, recover otherwise)', async () => {
    const onRefresh = vi.fn();
    const { container } = renderActive(closedSession('idle'), { devices: [device], onRefresh });
    const thread = container.querySelector('.thread-scroll') as HTMLElement;
    fireEvent.touchStart(thread, { touches: [{ clientX: 100, clientY: 100 }] });
    fireEvent.touchMove(thread, { touches: [{ clientX: 100, clientY: 140 }] });
    fireEvent.touchMove(thread, { touches: [{ clientX: 100, clientY: 400 }] });
    fireEvent.touchEnd(thread, { touches: [] });
    await waitFor(() => expect(onRefresh).toHaveBeenCalledWith('session-a'));
  });

  it('disables the composer while connecting and keeps it enabled when live', () => {
    const rendered = renderScreen('connecting');
    expect(composerProps.latest).toMatchObject({ disabled: true, disabledReason: 'offline' });
    expect(screen.getByRole('textbox', { name: 'mock composer' })).toBeDisabled();
    expect(screen.getByRole('textbox', { name: 'mock composer' })).toHaveAttribute(
      'placeholder',
      'Reconnecting… — hold on',
    );

    rendered.unmount();
    renderScreen('live');
    expect(composerProps.latest).toMatchObject({ disabled: false });
    expect(composerProps.latest?.disabledReason).toBeUndefined();
  });
});

describe('SessionScreen approvals', () => {
  it('renders all three plan-exit approval options and marks the recommended choice', () => {
    const active = makeSession('live');
    (active.timeline.approvals as unknown[]) = [
      {
        requestId: 'plan-1',
        toolName: 'Exit Plan Mode',
        toolArgs: { summary: 'Plan ready for review' },
        options: [
          { id: 'exit_only', label: 'Exit plan mode' },
          { id: 'autopilot', label: 'Accept plan and build', recommended: true },
          { id: 'suggest_changes', label: 'Suggest changes' },
        ],
      },
    ];

    renderActive(active);

    expect(screen.getByRole('button', { name: /^Exit plan mode:/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Accept plan and build:/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Suggest changes:/i })).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
  });

  it('uses a neutral preview for bookkeeping-only approval args instead of raw JSON', () => {
    const active = makeSession('live');
    (active.timeline.approvals as unknown[]) = [
      {
        requestId: 'shell-1',
        toolName: 'shell',
        toolArgs: { kind: 'shell', toolCallId: 'toolu_123' },
        options: [{ id: 'approved', label: 'Approve' }],
      },
    ];

    renderActive(active);

    expect(screen.getByText('No command preview available')).toBeInTheDocument();
    expect(screen.queryByText(/toolu_123/)).not.toBeInTheDocument();
  });
});

describe('SessionScreen desktop docked sidebar (#183)', () => {
  it('docks the session list inline on wide desktop viewports without needing the drawer opened, and leaves narrow viewports on the overlay-only mobile layout', () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('min-width'),
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      const { container, unmount } = renderActive(makeSession('live'));
      // Wide viewport: docked layout class applied and the session list renders inline —
      // it must not depend on the mobile `drawerOpen` state (which starts false).
      expect(container.querySelector('.weft-session.desktop-docked')).toBeInTheDocument();
      expect(screen.getByTestId('drawer')).toBeInTheDocument();
      unmount();
    } finally {
      matchMediaSpy.mockRestore();
    }

    // Narrow/mobile viewport (default stub: matches always false): no docked class, and the
    // overlay drawer stays closed until the user opens it — mobile behavior is unchanged.
    const { container } = renderActive(makeSession('live'));
    expect(container.querySelector('.weft-session.desktop-docked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer')).not.toBeInTheDocument();
  });
});

describe('SessionScreen desktop keyboard shortcuts', () => {
  it('switches sessions with Ctrl/Cmd+1..9 in docked-list order, only on desktop input', () => {
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: true, // desktop input (hover+fine pointer) AND wide viewport
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      const active = makeSession('live');
      const second = { ...makeSession('live'), id: 'session-b', meta: { ...active.meta, channelId: 'b' } };
      const first = { ...active, meta: { ...active.meta, channelId: 'a' } };
      const onSelectSession = vi.fn();
      render(
        <SessionScreen
          active={first as never}
          sessions={[
            { ...first, meta: { channelId: 'a', title: 'A', kind: 'paired', addedAt: 1, scannedAt: 2 } },
            { ...second, meta: { channelId: 'b', title: 'B', kind: 'paired', addedAt: 1, scannedAt: 5 } },
          ] as never}
          activeId="a"
          onPrompt={vi.fn()}
          onApprove={vi.fn()}
          onElicitationRespond={vi.fn()}
          onInterrupt={vi.fn()}
          onModeChange={vi.fn()}
          onCommand={vi.fn()}
          onRetry={vi.fn()}
          onSelectSession={onSelectSession}
          onAddSession={vi.fn()}
          onRemoveSession={vi.fn()}
          onRenameSession={vi.fn()}
          onReconnect={vi.fn()}
          onGoHome={vi.fn()}
          onLoadEarlier={vi.fn()}
        />,
      );

      // "b" was scanned more recently, so it's first in docked order — Ctrl+1 selects it.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '1', ctrlKey: true, bubbles: true }));
      expect(onSelectSession).toHaveBeenCalledWith('b');

      onSelectSession.mockClear();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: '2', ctrlKey: true, bubbles: true }));
      expect(onSelectSession).toHaveBeenCalledWith('a');
    } finally {
      matchMediaSpy.mockRestore();
    }
  });
});

describe('SessionScreen direct Discover gesture', () => {
  it('commits a horizontally dominant left swipe from the right edge', () => {
    const onOpenDiscover = vi.fn();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(500);
    const { container } = renderActive(makeSession('live'), { onOpenDiscover });
    const root = container.querySelector('.weft-session') as HTMLElement;

    fireEvent.touchStart(root, { touches: [{ clientX: window.innerWidth - 4, clientY: 200 }] });
    fireEvent.touchMove(root, { touches: [{ clientX: window.innerWidth - 280, clientY: 205 }] });
    expect(container.querySelector('.discover-edge-preview')).toBeInTheDocument();
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: window.innerWidth - 280, clientY: 205 }] });

    expect(onOpenDiscover).toHaveBeenCalledOnce();
  });

  it('cancels short or vertically dominant gestures and springs the preview away', () => {
    vi.useFakeTimers();
    const onOpenDiscover = vi.fn();
    const now = vi.spyOn(performance, 'now');
    now.mockReturnValueOnce(0).mockReturnValueOnce(1_000);
    const { container } = renderActive(makeSession('live'), { onOpenDiscover });
    const root = container.querySelector('.weft-session') as HTMLElement;

    fireEvent.touchStart(root, { touches: [{ clientX: window.innerWidth - 4, clientY: 200 }] });
    fireEvent.touchMove(root, { touches: [{ clientX: window.innerWidth - 36, clientY: 201 }] });
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: window.innerWidth - 36, clientY: 201 }] });
    expect(container.querySelector('.discover-edge-preview')).toHaveClass('settling');
    expect(onOpenDiscover).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(190));
    expect(container.querySelector('.discover-edge-preview')).not.toBeInTheDocument();

    fireEvent.touchStart(root, { touches: [{ clientX: window.innerWidth - 4, clientY: 200 }] });
    fireEvent.touchMove(root, { touches: [{ clientX: window.innerWidth - 44, clientY: 100 }] });
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: window.innerWidth - 200, clientY: 100 }] });
    expect(onOpenDiscover).not.toHaveBeenCalled();

    fireEvent.touchStart(root, { touches: [{ clientX: window.innerWidth - 20, clientY: 200 }] });
    fireEvent.touchMove(root, { touches: [{ clientX: window.innerWidth - 2, clientY: 200 }] });
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: window.innerWidth - 2, clientY: 200 }] });
    expect(onOpenDiscover).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('does not start outside the edge or while an approval overlay needs attention', () => {
    const onOpenDiscover = vi.fn();
    const { container, rerender } = renderActive(makeSession('live'), { onOpenDiscover });
    const root = container.querySelector('.weft-session') as HTMLElement;

    fireEvent.touchStart(root, { touches: [{ clientX: 100, clientY: 200 }] });
    fireEvent.touchMove(root, { touches: [{ clientX: 0, clientY: 200 }] });
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: 0, clientY: 200 }] });
    expect(onOpenDiscover).not.toHaveBeenCalled();

    const blocked = makeSession('live');
    blocked.timeline.approvals = [{
      requestId: 'approval-1',
      toolName: 'powershell',
      toolArgs: {},
      options: [{ id: 'approve', label: 'Approve' }],
    }] as never;
    rerender(
      <SessionScreen
        active={blocked as never}
        sessions={[blocked] as never}
        activeId="session-a"
        onPrompt={vi.fn()}
        onApprove={vi.fn()}
        onElicitationRespond={vi.fn()}
        onInterrupt={vi.fn()}
        onModeChange={vi.fn()}
        onCommand={vi.fn()}
        onRetry={vi.fn()}
        onSelectSession={vi.fn()}
        onAddSession={vi.fn()}
        onOpenDiscover={onOpenDiscover}
        onRemoveSession={vi.fn()}
        onRenameSession={vi.fn()}
        onReconnect={vi.fn()}
        onGoHome={vi.fn()}
        onLoadEarlier={vi.fn()}
      />,
    );
    const blockedRoot = container.querySelector('.weft-session') as HTMLElement;
    fireEvent.touchStart(blockedRoot, { touches: [{ clientX: window.innerWidth - 4, clientY: 200 }] });
    fireEvent.touchMove(blockedRoot, { touches: [{ clientX: 20, clientY: 200 }] });
    fireEvent.touchEnd(blockedRoot, { changedTouches: [{ clientX: 20, clientY: 200 }] });
    expect(onOpenDiscover).not.toHaveBeenCalled();
  });

  it('stays disabled while the keyboard is active and skips spatial preview for reduced motion', () => {
    const onOpenDiscover = vi.fn();
    const matchMedia = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    const { container } = renderActive(makeSession('live'), { onOpenDiscover });
    const root = container.querySelector('.weft-session') as HTMLElement;
    screen.getByRole('textbox', { name: 'mock composer' }).focus();

    fireEvent.touchStart(root, { touches: [{ clientX: window.innerWidth - 4, clientY: 200 }] });
    fireEvent.touchMove(root, { touches: [{ clientX: 20, clientY: 200 }] });
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: 20, clientY: 200 }] });
    expect(onOpenDiscover).not.toHaveBeenCalled();

    screen.getByRole('textbox', { name: 'mock composer' }).blur();
    fireEvent.touchStart(root, { touches: [{ clientX: window.innerWidth - 4, clientY: 200 }] });
    fireEvent.touchMove(root, { touches: [{ clientX: 20, clientY: 200 }] });
    expect(container.querySelector('.discover-edge-preview')).not.toBeInTheDocument();
    fireEvent.touchEnd(root, { changedTouches: [{ clientX: 20, clientY: 200 }] });
    expect(onOpenDiscover).toHaveBeenCalledOnce();
    matchMedia.mockRestore();
  });
});

describe('SessionScreen leave-session confirmation (#one-click-delete)', () => {
  it('deletes directly from the drawer inline ✓ without popping a second "Remove from this phone?" dialog', () => {
    // The drawer row already shows its own inline "Delete?" ✓/✕ confirm, so its ✓ must remove
    // the session in one tap — not re-open the top-bar Leave dialog and ask again.
    const matchMediaSpy = vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('min-width'), // wide viewport so the docked drawer renders
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    try {
      const onRemoveSession = vi.fn();
      renderActive(makeSession('live'), { onRemoveSession });

      fireEvent.click(screen.getByTestId('drawer-remove'));

      expect(onRemoveSession).toHaveBeenCalledTimes(1);
      expect(onRemoveSession).toHaveBeenCalledWith('session-a');
      expect(screen.queryByText('Remove from this phone?')).not.toBeInTheDocument();
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it('guards the top-bar "Remove from this phone" behind a confirm that says the laptop keeps it', () => {
    const onRemoveSession = vi.fn();
    renderActive(makeSession('live'), { onRemoveSession });

    fireEvent.click(screen.getByTestId('status-remove'));

    // The ⋯ item has no inline confirm, so it must open the dialog first, not delete.
    const dialog = screen.getByRole('dialog', { name: 'Remove from this phone?' });
    expect(dialog).toHaveTextContent('The session keeps running on the laptop.');
    expect(onRemoveSession).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Remove from this phone?' })).not.toBeInTheDocument();
    expect(onRemoveSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('status-remove'));
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(onRemoveSession).toHaveBeenCalledWith('session-a');
  });
});

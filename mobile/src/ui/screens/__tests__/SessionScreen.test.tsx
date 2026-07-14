import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionScreen } from '@/ui/screens/SessionScreen';

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

describe('SessionScreen leave-session confirmation (#one-click-delete)', () => {
  it('deletes directly from the drawer inline ✓ without popping a second "Leave this session?" dialog', () => {
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
      expect(screen.queryByText('Leave this session?')).not.toBeInTheDocument();
    } finally {
      matchMediaSpy.mockRestore();
    }
  });

  it('still guards the top-bar StatusBar "Leave" (no inline confirm) behind the dialog', () => {
    const onRemoveSession = vi.fn();
    renderActive(makeSession('live'), { onRemoveSession });

    fireEvent.click(screen.getByTestId('status-remove'));

    // The bar's Leave has no inline confirm, so it must open the dialog first, not delete.
    expect(screen.getByText('Leave this session?')).toBeInTheDocument();
    expect(onRemoveSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    expect(onRemoveSession).toHaveBeenCalledWith('session-a');
  });
});

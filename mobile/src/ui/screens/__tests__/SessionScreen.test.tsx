import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SessionScreen } from '@/ui/screens/SessionScreen';

const composerProps = vi.hoisted(() => ({ latest: null as null | { disabled: boolean; disabledReason?: string } }));

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

vi.mock('@/ui/sessions/SessionDrawer', () => ({
  SessionDrawer: () => <div data-testid="drawer" />,
}));

vi.mock('@/ui/sessions/StatusBar', () => ({
  StatusBar: () => <div data-testid="status" />,
}));

function makeSession(status: 'live' | 'connecting' | 'idle' | 'ended' = 'live') {
  return {
    id: 'session-a',
    status,
    settling: false,
    error: null,
    meta: { kind: 'paired', title: 'Helm', cwd: 'C:\\Users\\akash\\helm' },
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
      expect(container.querySelector('.helm-session.desktop-docked')).toBeInTheDocument();
      expect(screen.getByTestId('drawer')).toBeInTheDocument();
      unmount();
    } finally {
      matchMediaSpy.mockRestore();
    }

    // Narrow/mobile viewport (default stub: matches always false): no docked class, and the
    // overlay drawer stays closed until the user opens it — mobile behavior is unchanged.
    const { container } = renderActive(makeSession('live'));
    expect(container.querySelector('.helm-session.desktop-docked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('drawer')).not.toBeInTheDocument();
  });
});

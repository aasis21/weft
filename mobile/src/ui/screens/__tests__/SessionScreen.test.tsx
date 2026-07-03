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
      onReconnect={vi.fn()}
      onGoHome={vi.fn()}
      onLoadEarlier={vi.fn()}
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

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import {
  RECOVERY_COPY,
  RecoveryBar,
  middleTruncate,
  recoveryReason,
  type RecoveryReason,
} from '@/ui/recovery/RecoveryBar';
import type { SessionView } from '@/session/view';

const NOW = 1_700_000_000_000;

function view(patch: Partial<SessionView> = {}): SessionView {
  return {
    meta: { channelId: 'c1', sessionId: 's1', title: 'Work', cwd: null, kind: 'live', addedAt: 0 },
    status: 'live',
    timeline: {} as SessionView['timeline'],
    events: [],
    ...patch,
  };
}

const ROWS: Array<[RecoveryReason, string, string | null, string]> = [
  ['quiet', 'Waiting for the laptop to reply…', null, "The connection is open but the laptop hasn't answered for a while. Weft keeps checking."],
  ['connecting', 'Connecting to your session…', null, 'Setting up the secure link to the laptop.'],
  ['offline', 'This session is offline', 'Reconnect', 'Last seen 5m ago on Studio. Reconnect tries again and, if needed, asks the laptop to reopen it.'],
  ['retrying', 'Trying to reconnect…', 'Cancel', 'Retrying the link from your phone.'],
  ['asking', 'Asking your laptop to reopen the session…', 'Cancel', 'Request sent to Studio through Station.'],
  ['repairing', 'Reconnecting to the running session…', 'Cancel', 'The session is still open on the laptop. Reconnecting to it.'],
  ['resuming', 'Opening the session in a new terminal…', 'Cancel', 'Its terminal was closed. A new one is starting with this session resumed.'],
  ['linking', 'Connecting your phone to the session…', 'Cancel', 'The laptop is ready. Finishing the secure link.'],
  ['done', 'Back online and ready', null, 'Reconnected to the running session.'],
  ['unreachable', "Your laptop isn't reachable right now", 'Try again', 'Wake the laptop and start Station: run weft, then Control → Start Station.'],
  ['controller-conflict', 'Another phone is using this session', 'Take over', 'Taking over disconnects the other phone.'],
  ['not-found', "This session isn't on the laptop anymore", 'New session', 'It was removed or belongs to another account.'],
  ['update-required', 'Weft on your laptop needs an update', 'How?', 'Run weft update on the laptop, then restart Station.'],
  ['no-station', 'This session is offline', 'Try again', 'If its terminal was closed, run /weft there and scan the new QR.'],
  ['ended', 'This session ended on the laptop', 'Resume', 'Resume reopens it in a new terminal. Without Station, run /weft and scan.'],
  ['owner-unknown', "Can't tell which process owns this session", 'Details', 'Close other Copilot windows using it, then Try again.'],
  ['needs-attention', "Your laptop can't reconnect this session", 'Reconnect', 'Station tried twice. See Control Center → Sessions.'],
];

describe('RecoveryBar', () => {
  it('has exactly the 17 rows of the LLD copy table', () => {
    expect(Object.keys(RECOVERY_COPY).sort()).toEqual(ROWS.map(([reason]) => reason).sort());
  });

  it.each(ROWS)('renders the %s row: bar text, one action and its details', (reason, bar, action, details) => {
    const onAction = vi.fn();
    render(
      <RecoveryBar reason={reason} deviceName="Studio" lastSeenAt={NOW - 5 * 60_000} now={NOW} compact={false} onAction={onAction} />,
    );
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('data-reason', reason);
    const text = screen.getByRole('button', { name: bar });
    const actions = screen.queryAllByRole('button').filter((button) => button !== text);
    expect(actions).toHaveLength(action ? 1 : 0);
    if (action) expect(actions[0]).toHaveAccessibleName(action);

    fireEvent.click(text);
    expect(screen.getByRole('dialog', { name: 'Connection details' })).toHaveTextContent(details);
    expect(screen.getByRole('dialog')).toHaveTextContent('Studio');
  });

  it('shows the 2px progress edge and the step list only while working', () => {
    const { container, rerender } = render(<RecoveryBar reason="asking" deviceName="Studio" compact={false} onAction={vi.fn()} />);
    expect(container.querySelector('.recovery-progress')).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Asking your laptop to reopen the session…' }));
    const steps = screen.getAllByRole('listitem');
    expect(steps.map((step) => step.className)).toEqual(['is-done', 'is-active', 'is-pending', 'is-pending']);
    expect(steps[1]).toHaveTextContent('Ask Station on Studio');

    rerender(<RecoveryBar reason="offline" deviceName="Studio" compact={false} onAction={vi.fn()} />);
    expect(container.querySelector('.recovery-progress')).toBeNull();
  });

  it('fades the done row and says how the session came back', () => {
    const { container } = render(<RecoveryBar reason="done" doneVia="resume" compact={false} onAction={vi.fn()} />);
    expect(container.querySelector('.recovery-bar')).toHaveClass('is-done');
    fireEvent.click(screen.getByRole('button', { name: 'Back online and ready' }));
    expect(screen.getByRole('dialog')).toHaveTextContent('Opened in a new terminal.');
  });

  it('routes actions: ✕ cancels, Take over confirms, How? opens the details instead of acting', () => {
    const onAction = vi.fn();
    const { rerender } = render(<RecoveryBar reason="retrying" compact={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onAction).toHaveBeenLastCalledWith('cancel');

    rerender(<RecoveryBar reason="controller-conflict" compact={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    expect(onAction).toHaveBeenLastCalledWith('take-over');

    onAction.mockClear();
    rerender(<RecoveryBar reason="update-required" compact={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'How?' }));
    expect(onAction).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toHaveTextContent('Run weft update on the laptop, then restart Station.');
  });

  it('offers Scan QR for an ended session without Station', () => {
    const onAction = vi.fn();
    render(<RecoveryBar reason="ended" canResume={false} compact={false} onAction={onAction} />);
    fireEvent.click(screen.getByRole('button', { name: 'Scan QR' }));
    expect(onAction).toHaveBeenCalledWith('scan');
  });

  it('at 320px the action becomes an icon button that keeps its label for assistive tech', () => {
    const onAction = vi.fn();
    const { container } = render(<RecoveryBar reason="offline" compact onAction={onAction} />);
    const action = screen.getByRole('button', { name: 'Reconnect' });
    expect(action).toHaveClass('recovery-action-icon');
    expect(action).not.toHaveTextContent('Reconnect');
    expect(container.querySelector('.recovery-bar')).toHaveClass('is-narrow');
    fireEvent.click(action);
    expect(onAction).toHaveBeenCalledWith('reconnect');
  });

  it('middle-truncates long device names', () => {
    expect(middleTruncate('Akash-Laptop-With-A-Very-Long-Name', 15)).toBe('Akash-L…ng-Name');
    expect(middleTruncate('Studio')).toBe('Studio');
  });
});

describe('recoveryReason', () => {
  const station = { known: true, reachable: true };

  it('shows nothing for a linked session, even when the phone is away', () => {
    expect(recoveryReason(view({ health: { label: 'linked', reason: 'phone-away', freshAt: 1, receivedAt: 1 } }), station)).toBeNull();
  });

  it('derives the idle rows from the connection and Station', () => {
    expect(recoveryReason(view({ status: 'connecting' }), station)).toBe('connecting');
    expect(recoveryReason(view({ status: 'idle' }), station)).toBe('quiet');
    expect(recoveryReason(view({ status: 'idle', cold: true }), station)).toBe('offline');
    expect(recoveryReason(view({ status: 'error' }), { known: true, reachable: false })).toBe('unreachable');
    expect(recoveryReason(view({ status: 'error' }), { known: false, reachable: false })).toBe('no-station');
    expect(recoveryReason(view({ status: 'ended' }), station)).toBe('ended');
  });

  it('maps Station health reasons; phone-away is not an error', () => {
    const health = (reason: NonNullable<SessionView['health']>['reason']) =>
      view({ status: 'error', health: { label: 'stalled', reason, freshAt: 1, receivedAt: 1 } });
    expect(recoveryReason(health('owner-unknown'), station)).toBe('owner-unknown');
    expect(recoveryReason(health('needs-attention'), station)).toBe('needs-attention');
    expect(recoveryReason(health('config-error'), station)).toBe('needs-attention');
    expect(recoveryReason(health('update-required'), station)).toBe('update-required');
    expect(recoveryReason(health('controller-conflict'), station)).toBe('controller-conflict');
    expect(recoveryReason(health('phone-away'), station)).toBe('offline');
  });

  it('prefers an active recover() run, then update-required on the link', () => {
    expect(recoveryReason(view({ status: 'error', recovery: { phase: 'resuming', startedAt: 1, updatedAt: 1 } }), station))
      .toBe('resuming');
    expect(recoveryReason(view({ status: 'error', link: { generation: 1, ready: false, updateRequired: 'laptop' } }), station))
      .toBe('update-required');
  });

  it('never shows the bar for launch placeholders', () => {
    expect(recoveryReason(view({ status: 'error', meta: { channelId: 'x', title: 'x', cwd: null, kind: 'spawning', addedAt: 0 } }), station))
      .toBeNull();
  });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionDrawer } from '@/ui/sessions/SessionDrawer';
import { emptyTimeline, type TimelineState } from '@/lib/timeline';
import type { SessionView } from '@/session/view';

function session(
  channelId: string,
  title: string,
  addedAt: number,
  opts: Partial<SessionView> & { cwd?: string | null } = {},
): SessionView {
  return {
    meta: {
      channelId,
      title,
      cwd: opts.cwd ?? `C:\\repos\\${title}`,
      kind: 'live',
      addedAt,
    },
    status: opts.status ?? 'live',
    timeline: opts.timeline ?? emptyTimeline(),
    unread: opts.unread,
    lastEventAt: opts.lastEventAt,
    events: opts.events ?? [],
    error: opts.error,
  };
}

describe('SessionDrawer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders sessions newest-first using activity, highlights the active row, and shows badges', () => {
    const olderTimeline: TimelineState = {
      ...emptyTimeline(),
      items: [{ kind: 'user', id: 'u1', text: 'hello', ts: 1_200 }],
    };
    render(
      <SessionDrawer
        sessions={[
          session('old', 'Older', 1_000, { timeline: olderTimeline }),
          session('new', 'Newest', 3_000),
          session('busy', 'Needs approval', 2_000, { timeline: { ...emptyTimeline(), approvals: [{} as never] }, unread: true }),
        ]}
        activeId="busy"
        onSelect={vi.fn()}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onGoHome={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const rows = screen.getAllByRole('button').filter((row) => row.classList.contains('session-row'));
    expect(rows.map((row) => row.querySelector('.session-title')?.textContent)).toEqual([
      'Newest',
      'Needs approval1 approval',
      'Older',
    ]);
    expect(within(rows[1]).getByText('Needs approval').closest('.session-row')).toHaveClass('current');
    expect(within(rows[1]).getByText('1 approval')).toHaveClass('tag', 'alert');
  });

  it('renders last active from real activity and ignores heartbeat-only pings', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const activeTimeline: TimelineState = {
      ...emptyTimeline(),
      items: [{ kind: 'user', id: 'u1', text: 'hello', ts: 700_000 }],
      lastHeartbeat: 999_000,
    };
    const heartbeatOnlyTimeline: TimelineState = {
      ...emptyTimeline(),
      lastHeartbeat: 999_000,
    };

    render(
      <SessionDrawer
        sessions={[
          session('active', 'Active', 2_000, { timeline: activeTimeline, cwd: '' }),
          session('heartbeat', 'Heartbeat Only', 1_000, { timeline: heartbeatOnlyTimeline, cwd: '' }),
        ]}
        activeId={null}
        onSelect={vi.fn()}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onGoHome={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText('Active').closest('.session-row')?.textContent).toContain('· 5m');
    expect(screen.getByText('Heartbeat Only').closest('.session-row')?.textContent).not.toContain('· now');
  });

  it('selects a session row and removes via the row leave button without selecting', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const onRemove = vi.fn();
    render(
      <SessionDrawer
        sessions={[session('a', 'Alpha', 1), session('b', 'Beta', 2)]}
        activeId="a"
        onSelect={onSelect}
        onAddSession={vi.fn()}
        onRemove={onRemove}
        onGoHome={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const betaRow = screen.getByText('Beta').closest('.session-row');
    expect(betaRow).toBeInTheDocument();
    await user.click(betaRow!);
    expect(onSelect).toHaveBeenCalledWith('b');

    await user.click(within(betaRow as HTMLElement).getByRole('button', { name: '✕' }));
    expect(onRemove).toHaveBeenCalledWith('b');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('filters sessions and fires add and close controls', async () => {
    const user = userEvent.setup();
    const onAddSession = vi.fn();
    const onClose = vi.fn();
    render(
      <SessionDrawer
        sessions={[session('a', 'Alpha', 1), session('b', 'Beta', 2)]}
        activeId={null}
        onSelect={vi.fn()}
        onAddSession={onAddSession}
        onRemove={vi.fn()}
        onGoHome={vi.fn()}
        onClose={onClose}
      />,
    );

    await user.type(screen.getByRole('textbox', { name: 'Filter sessions' }), 'alp');
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();

    await user.click(screen.getByTitle('Join another session'));
    expect(onAddSession).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('navigates to the landing page from the About Helm link', async () => {
    const user = userEvent.setup();
    const onGoHome = vi.fn();
    render(
      <SessionDrawer
        sessions={[session('a', 'Alpha', 1)]}
        activeId={null}
        onSelect={vi.fn()}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onGoHome={onGoHome}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: '⌂ About Helm' }));
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });
});

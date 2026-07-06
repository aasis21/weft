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
    unreadCount: opts.unreadCount,
    lastEventAt: opts.lastEventAt,
    events: opts.events ?? [],
    error: opts.error,
    cold: opts.cold,
    pinned: opts.pinned,
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
          session('active', 'Worker', 2_000, { timeline: activeTimeline, cwd: '' }),
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

    expect(screen.getByText('Worker').closest('.session-row')?.textContent).toContain('· 5m');
    expect(screen.getByText('Heartbeat Only').closest('.session-row')?.textContent).not.toContain('· now');
  });

  it('selects a session row and removes via the row delete button (with confirm) without selecting', async () => {
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

    await user.click(within(betaRow as HTMLElement).getByRole('button', { name: 'Delete session' }));
    await user.click(
      within(betaRow as HTMLElement).getByRole('button', { name: 'Confirm delete session' }),
    );
    expect(onRemove).toHaveBeenCalledWith('b');
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('groups sessions into Active/Archived, shows a status pill per row, and marks pinned rows (#163)', async () => {
    const user = userEvent.setup();
    const onPin = vi.fn();
    const onArchive = vi.fn();
    render(
      <SessionDrawer
        sessions={[
          session('live', 'Live One', 3_000, { status: 'live' }),
          session('cold', 'Cold One', 2_000, { status: 'idle', cold: true, pinned: true }),
          session('err', 'Broken One', 1_000, { status: 'live', error: 'unreachable' }),
        ]}
        activeId={null}
        onSelect={vi.fn()}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onGoHome={vi.fn()}
        onClose={vi.fn()}
        onPin={onPin}
        onArchive={onArchive}
      />,
    );

    // Two group headers with counts: 1 Active (Live One), 2 not-Active (Cold One archived, Broken One offline).
    const activeHead = screen.getByText('Active', { selector: '.drawer-group-head' });
    const archivedHead = screen.getByText('Archived', { selector: '.drawer-group-head' });
    expect(activeHead.textContent).toContain('1');
    expect(archivedHead.textContent).toContain('2');

    // Per-row pills reflect deriveStatus.
    expect(screen.getByText('Live One').closest('.session-row')?.querySelector('.session-pill')?.textContent).toBe('Live');
    const coldRow = screen.getByText('Cold One').closest('.session-row') as HTMLElement;
    expect(coldRow.querySelector('.session-pill')?.textContent).toBe('Archived');
    expect(screen.getByText('Broken One').closest('.session-row')?.querySelector('.session-pill')?.textContent).toBe('Offline');

    // Pinned row shows the marker; pin/archive/rename live behind the row's "⋮" menu.
    expect(within(coldRow).getByLabelText('Pinned')).toBeInTheDocument();
    await user.click(within(coldRow).getByRole('button', { name: 'More actions' }));
    await user.click(within(coldRow).getByRole('menuitem', { name: 'Unpin session' }));
    expect(onPin).toHaveBeenCalledWith('cold', false);
  });

  it('fires add and close controls', async () => {
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

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();

    await user.click(screen.getByText('＋ Join another Copilot session'));
    expect(onAddSession).toHaveBeenCalledTimes(1);
    await user.click(screen.getByTitle('Close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the new-message count on an unread non-active row and hides it on the active row', () => {
    const withNew: TimelineState = {
      ...emptyTimeline(),
      items: [
        { kind: 'user', id: 'u1', text: 'hi', ts: 1_000 },
        { kind: 'assistant', id: 'a1', text: 'reply', ts: 1_100 },
      ],
    };
    render(
      <SessionDrawer
        sessions={[
          session('bg', 'Background', 2_000, { timeline: withNew, unread: true, unreadCount: 12 }),
          session('cur', 'Current', 1_000, { timeline: withNew, unreadCount: 5 }),
        ]}
        activeId="cur"
        onSelect={vi.fn()}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onGoHome={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    const bgRow = screen.getByText('Background').closest('.session-row') as HTMLElement;
    expect(within(bgRow).getByText(/12 new/)).toHaveClass('unread-new');
    expect(bgRow.textContent).toContain('2 msg');

    // The active session never shows a "new" count even if a stale count lingers.
    const curRow = screen.getByText('Current').closest('.session-row') as HTMLElement;
    expect(within(curRow).queryByText(/new/)).not.toBeInTheDocument();
  });

  it('navigates to the landing page from the About Weft link', async () => {
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

    await user.click(screen.getByRole('button', { name: '⌂ About Weft' }));
    expect(onGoHome).toHaveBeenCalledTimes(1);
  });

  it('renames a session inline and commits the new title on Enter (#37)', async () => {
    const user = userEvent.setup();
    const onRename = vi.fn();
    const onSelect = vi.fn();
    render(
      <SessionDrawer
        sessions={[session('a', 'Alpha', 1)]}
        activeId="a"
        onSelect={onSelect}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onRename={onRename}
        onGoHome={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: 'Rename session' }));
    const input = screen.getByRole('textbox', { name: 'Rename session' });
    await user.clear(input);
    await user.type(input, 'Deploy Box{Enter}');

    expect(onRename).toHaveBeenCalledWith('a', 'Deploy Box');
  });

  it('collapses the docked sidebar on Escape only when focus is inside it, and not for the mobile overlay', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { rerender } = render(
      <SessionDrawer
        sessions={[session('a', 'Alpha', 1)]}
        activeId="a"
        onSelect={vi.fn()}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onGoHome={vi.fn()}
        onClose={onClose}
        docked
      />,
    );

    // Escape fired outside the drawer (e.g. while typing in the composer) must not collapse it.
    await user.keyboard('{Escape}');
    expect(onClose).not.toHaveBeenCalled();

    await user.click(screen.getByTitle('Collapse sidebar'));
    // Clicking the collapse button itself calls onClose once via its own onClick, not via Escape.
    expect(onClose).toHaveBeenCalledTimes(1);
    onClose.mockClear();

    // Escape fired with focus inside the docked drawer should collapse it.
    screen.getByTitle('Collapse sidebar').focus();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);

    onClose.mockClear();
    rerender(
      <SessionDrawer
        sessions={[session('a', 'Alpha', 1)]}
        activeId="a"
        onSelect={vi.fn()}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onGoHome={vi.fn()}
        onClose={onClose}
      />,
    );
    // Mobile overlay drawer already closes on any Escape (existing modal focus-trap behavior).
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

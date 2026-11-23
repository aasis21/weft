import { act, fireEvent, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { StatusBar } from '@/ui/sessions/StatusBar';
import { noteChatVisit } from '@/ui/sessions/chatSwitcher';
import { emptyTimeline } from '@/lib/timeline';
import { setDebugModeEnabled } from '@/lib/debugSettings';

const mockEmptySnapshot = { ready: true, activeId: null as string | null, sessions: [] as unknown[], devices: [] as unknown[] };
let mockSnapshot: typeof mockEmptySnapshot = mockEmptySnapshot;
vi.mock('@/session/runtime/instance', () => ({
  sessionRuntime: {
    subscribe: () => () => {},
    getSnapshot: () => mockSnapshot,
  },
}));

afterEach(() => {
  mockSnapshot = mockEmptySnapshot;
});

function renderStatusBar(props: Partial<ComponentProps<typeof StatusBar>> = {}) {
  const defaults: ComponentProps<typeof StatusBar> = {
    title: 'weft',
    cwd: 'C:\\Users\\akash\\weft',
    status: 'live',
    busy: false,
    onOpenDrawer: vi.fn(),
    onAddSession: vi.fn(),
    onRemove: vi.fn(),
    onGoHome: vi.fn(),
    onOpenDebug: vi.fn(),
  };
  return {
    ...render(<StatusBar {...defaults} {...props} />),
    props: { ...defaults, ...props },
  };
}

describe('StatusBar', () => {
  it('adds decorative icons to file actions without changing menu names or callbacks', async () => {
    const user = userEvent.setup();
    const onOpenFiles = vi.fn(), onOpenChanges = vi.fn();
    renderStatusBar({ onOpenFiles, onOpenChanges });
    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    const files = screen.getByRole('menuitem', { name: 'Files' });
    const changes = screen.getByRole('menuitem', { name: 'Changes' });
    expect(files.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(changes.querySelector('svg')).toHaveAttribute('focusable', 'false');
    await user.click(files);
    expect(onOpenFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Changes' }));
    expect(onOpenChanges).toHaveBeenCalledTimes(1);
  });

  it('renders title, cwd title attribute, and status line classes', () => {
    const { container } = renderStatusBar({ status: 'connecting' });

    expect(screen.getByText('weft')).toHaveAttribute('title', 'C:\\Users\\akash\\weft');
    const statusLine = screen.getByText('Connecting…').closest('.status-line');
    expect(statusLine).toHaveClass('connecting');
    expect(statusLine?.querySelector('.status-dot')).toBeInTheDocument();
    expect(statusLine).toHaveTextContent('Connecting… · weft');
    expect(container.querySelector('.session-count')).not.toBeInTheDocument();
  });

  it('uses the busy affordance only for a live working session', () => {
    const { rerender } = renderStatusBar({ status: 'live', busy: true });

    expect(screen.getByText('Working…').closest('.status-line')).toHaveClass('busy');

    rerender(
      <StatusBar
        title="weft"
        cwd={null}
        status="idle"
        busy
        onOpenDrawer={vi.fn()}
        onAddSession={vi.fn()}
        onRemove={vi.fn()}
        onGoHome={vi.fn()}
        onOpenDebug={vi.fn()}
      />,
    );
    expect(screen.getByText('Quiet').closest('.status-line')).toHaveClass('idle');
  });

  it('never shows "Live" while the active session carries a connection error — shows Offline instead (#185)', () => {
    mockSnapshot = {
      ready: true,
      activeId: 'ch-err',
      sessions: [{ meta: { channelId: 'ch-err' }, status: 'live', error: 'Couldn’t reach your session — the terminal may be closed.', cold: false }],
      devices: [],
    };
    renderStatusBar({ status: 'live', busy: true });

    expect(screen.queryByText('Live')).not.toBeInTheDocument();
    expect(screen.queryByText('Working…')).not.toBeInTheDocument();
    const statusLine = screen.getByText('Offline').closest('.status-line');
    expect(statusLine).toHaveClass('error');
  });

  it('opens the drawer, start session button, menu actions, and direct remove callback', async () => {
    const user = userEvent.setup();
    const onOpenDrawer = vi.fn();
    const onStartSession = vi.fn();
    const onAddSession = vi.fn();
    const onRemove = vi.fn();
    // status 'ended' is not live; recovery lives on the banner above the composer, not in this menu.
    renderStatusBar({ status: 'ended', onOpenDrawer, onStartSession, onAddSession, onRemove });

    await user.click(screen.getByRole('button', { name: 'Open sessions' }));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    // Start (＋) stays in the header; Scan moved into the ⋯ menu (and the drawer).
    await user.click(screen.getByRole('button', { name: 'Start another session' }));
    expect(onStartSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: /Scan/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /Start another session/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Join another session/ })).not.toBeInTheDocument();
    // Reconnect/Rejoin were removed: the offline banner above the composer is the single recovery path.
    expect(within(menu).queryByRole('menuitem', { name: /Reconnect/ })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: /Rejoin/ })).not.toBeInTheDocument();

    await user.click(within(menu).getByRole('menuitem', { name: 'Scan QR to connect' }));
    expect(onAddSession).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    // The caller (SessionScreen) owns the "Remove from this phone?" confirmation.
    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    const remove = within(screen.getByRole('menu')).getByRole('menuitem', { name: 'Remove from this phone' });
    expect(remove).toHaveClass('danger');
    await user.click(remove);
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('lists the ⋯ items in groups with line icons, Debug only in Debug mode, and no history reload', async () => {
    const user = userEvent.setup();
    mockSnapshot = {
      ready: true,
      activeId: 'ch-live',
      sessions: [{ meta: { channelId: 'ch-live' }, status: 'live', cold: false }],
      devices: [],
    };
    renderStatusBar({ onRename: vi.fn(), onPin: vi.fn(), onArchive: vi.fn() });

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual(['Rename', 'Pin to top', 'Archive', 'Scan QR to connect', 'Remove from this phone']);
    expect(within(menu).getAllByRole('separator')).toHaveLength(2);
    for (const item of within(menu).getAllByRole('menuitem')) {
      expect(item.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    }
    expect(within(menu).queryByRole('menuitem', { name: /Load recent turns|Reload/ })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: 'Debug events' })).toBeNull();
  });

  it('labels Pin as Unpin for a pinned session', async () => {
    const user = userEvent.setup();
    const onPin = vi.fn();
    renderStatusBar({ onPin, pinned: true });
    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    await user.click(screen.getByRole('menuitem', { name: 'Unpin' }));
    expect(onPin).toHaveBeenCalledWith(false);
  });

  it('uses the folder, never the brand, as the session title', () => {
    renderStatusBar({ title: 'Weft', cwd: 'C:\\code\\orchard' });
    expect(document.querySelector('.status-title')).toHaveTextContent(/^orchard$/);
  });

  it('keeps Explore as a permanent action without changing the read-only status subtitle', async () => {
    const user = userEvent.setup();
    const onOpenExplore = vi.fn();
    const rendered = renderStatusBar({ status: 'live', busy: false, onOpenExplore });

    const explore = screen.getByRole('button', { name: 'Open Explore' });
    expect(explore).toBeInTheDocument();
    expect(screen.getByText('Live')).toBeInTheDocument();

    await user.click(explore);
    expect(onOpenExplore).toHaveBeenCalledTimes(1);

    rendered.rerender(
      <StatusBar
        {...rendered.props}
        busy
        onOpenExplore={onOpenExplore}
      />,
    );
    expect(screen.getByRole('button', { name: 'Open Explore' })).toBeInTheDocument();
    expect(screen.getByText('Working…')).toBeInTheDocument();
  });

  it('never renders an ambiguous hamburger badge (neither unread nor session count)', () => {
    const { container } = renderStatusBar();
    // The ambiguous rollup badge was removed (#161); the drawer conveys unread per-session instead.
    expect(container.querySelector('.session-count')).not.toBeInTheDocument();
    expect(container.querySelector('.unread-badge')).not.toBeInTheDocument();
    expect(container.querySelector('.decision-waiting-dot')).not.toBeInTheDocument();
  });

  it('marks the menu button when another session is waiting for a decision', () => {
    mockSnapshot = {
      ready: true,
      activeId: 'current',
      sessions: [
        { meta: { channelId: 'current' }, needsAttention: 1 },
        { meta: { channelId: 'other' }, needsAttention: 2, unread: true },
      ],
      devices: [],
    };
    renderStatusBar();
    const button = screen.getByRole('button', { name: 'Open sessions, 1 waiting for your decision' });
    // The Weft mark tile is the trigger; the approval dot sits on the tile's corner.
    const tile = button.querySelector('.weft-menu-tile');
    expect(tile?.querySelector('svg')).toBeInTheDocument();
    expect(tile?.querySelector('.decision-waiting-dot')).toBeInTheDocument();
  });

  it('uses the Weft mark tile, without a dot, as the plain "Open sessions" button', () => {
    renderStatusBar();
    const button = screen.getByRole('button', { name: 'Open sessions' });
    expect(button).toHaveClass('drawer-btn');
    expect(button.querySelector('.weft-menu-tile svg')).toHaveAttribute('aria-hidden', 'true');
    expect(button.querySelector('.decision-waiting-dot')).not.toBeInTheDocument();
  });

  it('swaps the hamburger for a static Weft mark when the sidebar is already docked (#183)', async () => {
    const user = userEvent.setup();
    const onOpenDrawer = vi.fn();
    const onGoHome = vi.fn();
    renderStatusBar({ desktopDocked: true, onOpenDrawer, onGoHome });

    expect(screen.queryByRole('button', { name: 'Open sessions' })).not.toBeInTheDocument();
    const weftMark = screen.getByRole('button', { name: 'About Weft' });
    expect(weftMark).toBeInTheDocument();

    await user.click(weftMark);
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });

  it('opens the debug panel from the overflow menu when Debug mode is on', async () => {
    await setDebugModeEnabled(true);
    const user = userEvent.setup();
    const onOpenDebug = vi.fn();
    renderStatusBar({ onOpenDebug });

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    const debug = await screen.findByRole('menuitem', { name: 'Debug events' });
    expect(screen.getAllByRole('menuitem').map((item) => item.textContent))
      .toEqual(['Scan QR to connect', 'Debug events', 'Remove from this phone']);
    await user.click(debug);
    expect(onOpenDebug).toHaveBeenCalledTimes(1);
  });

  it('closes the session menu on Escape and returns focus to the menu button', async () => {
    const user = userEvent.setup();
    renderStatusBar();

    const menuButton = screen.getByRole('button', { name: 'Session menu' });
    await user.click(menuButton);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(menuButton).toHaveFocus();
  });

  it('opens the menu and moves focus to the first item on ArrowDown', async () => {
    const user = userEvent.setup();
    renderStatusBar({ status: 'ended' });

    const menuButton = screen.getByRole('button', { name: 'Session menu' });
    menuButton.focus();
    await user.keyboard('{ArrowDown}');

    await waitFor(() => {
      const items = screen.getAllByRole('menuitem');
      expect(items[0]).toHaveFocus();
    });
  });

  describe('title gestures', () => {
    const chat = (id: string, title: string, scannedAt: number) => ({
      meta: { channelId: id, title, scannedAt, cwd: `C:\\code\\${id}` },
      status: 'live',
      cold: false,
      timeline: emptyTimeline(),
      events: [],
    });
    const useChats = (activeId: string) => {
      mockSnapshot = {
        ready: true,
        activeId,
        // Drawer order is newest scan first: a, b, c, d, e, f.
        sessions: [chat('f', 'Fox', 1), chat('e', 'Echo', 2), chat('d', 'Delta', 3), chat('c', 'Charlie', 4), chat('b', 'Bravo', 5), chat('a', 'Alpha', 6)],
        devices: [],
      };
    };
    const title = () => document.querySelector('.status-id') as HTMLElement;
    const pointer = (type: 'pointerDown' | 'pointerMove' | 'pointerUp', x: number, y = 20) =>
      fireEvent[type](title(), { clientX: x, clientY: y, pointerId: 1, pointerType: 'touch', button: 0 });

    afterEach(() => {
      vi.useRealTimers();
      localStorage.clear();
    });

    it('swipes the title left to the next chat and right to the previous one', () => {
      useChats('c');
      const onSwitchSession = vi.fn();
      renderStatusBar({ title: 'Charlie', onSwitchSession });

      pointer('pointerDown', 200);
      pointer('pointerMove', 150);
      expect(document.querySelector('.status-peek.next')).toHaveTextContent('Delta');
      pointer('pointerMove', 100);
      pointer('pointerUp', 100);
      expect(onSwitchSession).toHaveBeenLastCalledWith('d');

      pointer('pointerDown', 100);
      pointer('pointerMove', 200);
      pointer('pointerUp', 200);
      expect(onSwitchSession).toHaveBeenLastCalledWith('b');
    });

    it('ignores swipes that start in the drawer edge zone and short drags', () => {
      useChats('c');
      const onSwitchSession = vi.fn();
      renderStatusBar({ title: 'Charlie', onSwitchSession });

      pointer('pointerDown', 20);
      pointer('pointerMove', 200);
      pointer('pointerUp', 200);
      pointer('pointerDown', 200);
      pointer('pointerMove', 180);
      pointer('pointerUp', 180);
      expect(onSwitchSession).not.toHaveBeenCalled();
    });

    it('long-press opens a card of up to four recent chats without the current one', async () => {
      vi.useFakeTimers();
      useChats('a');
      noteChatVisit('e');
      noteChatVisit('a');
      const onSwitchSession = vi.fn();
      renderStatusBar({ title: 'Alpha', onSwitchSession });

      pointer('pointerDown', 200);
      act(() => { vi.advanceTimersByTime(500); });
      pointer('pointerUp', 200);

      const card = screen.getByRole('dialog', { name: 'Switch chat' });
      const rows = within(card).getAllByRole('button').filter((b) => b.hasAttribute('data-switch-id'));
      expect(rows.map((r) => r.dataset.switchId)).toEqual(['e', 'b', 'c', 'd']);
      fireEvent.click(rows[1]!);
      expect(onSwitchSession).toHaveBeenCalledWith('b');
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    it('double-tap jumps back to the last visited chat', () => {
      useChats('a');
      noteChatVisit('d');
      noteChatVisit('a');
      const onSwitchSession = vi.fn();
      renderStatusBar({ title: 'Alpha', onSwitchSession });

      pointer('pointerDown', 200);
      pointer('pointerUp', 200);
      pointer('pointerDown', 200);
      pointer('pointerUp', 200);
      expect(onSwitchSession).toHaveBeenCalledWith('d');
    });
  });
});

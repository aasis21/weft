import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { StatusBar } from '@/ui/sessions/StatusBar';

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
    title: 'helm',
    cwd: 'C:\\Users\\akash\\helm',
    status: 'live',
    busy: false,
    onOpenDrawer: vi.fn(),
    onAddSession: vi.fn(),
    onReconnect: vi.fn(),
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
  it('renders title, cwd title attribute, and status line classes', () => {
    const { container } = renderStatusBar({ status: 'connecting' });

    expect(screen.getByText('helm')).toHaveAttribute('title', 'C:\\Users\\akash\\helm');
    const statusLine = screen.getByText('Connecting…').closest('.status-line');
    expect(statusLine).toHaveClass('connecting');
    expect(statusLine?.querySelector('.status-dot')).toBeInTheDocument();
    expect(container.querySelector('.session-count')).not.toBeInTheDocument();
  });

  it('uses the busy affordance only for a live working session', () => {
    const { rerender } = renderStatusBar({ status: 'live', busy: true });

    expect(screen.getByText('Working…').closest('.status-line')).toHaveClass('busy');

    rerender(
      <StatusBar
        title="helm"
        cwd={null}
        status="idle"
        busy
        onOpenDrawer={vi.fn()}
        onAddSession={vi.fn()}
        onReconnect={vi.fn()}
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

  it('opens the drawer, start session button, menu actions, reconnect, and direct leave callback', async () => {
    const user = userEvent.setup();
    const onOpenDrawer = vi.fn();
    const onStartSession = vi.fn();
    const onAddSession = vi.fn();
    const onReconnect = vi.fn();
    const onRemove = vi.fn();
    // status 'ended' is not live, so Rejoin + Reconnect surface in the menu.
    renderStatusBar({ status: 'ended', onOpenDrawer, onStartSession, onAddSession, onReconnect, onRemove });

    await user.click(screen.getByRole('button', { name: 'Open sessions' }));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Start another session' }));
    expect(onStartSession).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    let menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '＋ Join another session' }));
    expect(onAddSession).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '↻ Reconnect this session' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '✕ Leave this session' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('never renders an ambiguous hamburger badge (neither unread nor session count)', () => {
    const { container } = renderStatusBar();
    // The ambiguous rollup badge was removed (#161); the drawer conveys unread per-session instead.
    expect(container.querySelector('.session-count')).not.toBeInTheDocument();
    expect(container.querySelector('.unread-badge')).not.toBeInTheDocument();
  });

  it('swaps the hamburger for a static Helm mark when the sidebar is already docked (#183)', async () => {
    const user = userEvent.setup();
    const onOpenDrawer = vi.fn();
    const onGoHome = vi.fn();
    renderStatusBar({ desktopDocked: true, onOpenDrawer, onGoHome });

    expect(screen.queryByRole('button', { name: 'Open sessions' })).not.toBeInTheDocument();
    const helmMark = screen.getByRole('button', { name: 'About Helm' });
    expect(helmMark).toBeInTheDocument();

    await user.click(helmMark);
    expect(onGoHome).toHaveBeenCalledTimes(1);
    expect(onOpenDrawer).not.toHaveBeenCalled();
  });

  it('exposes a visible New session button that calls onAddSession', async () => {
    const user = userEvent.setup();
    const onAddSession = vi.fn();
    renderStatusBar({ onAddSession });

    await user.click(screen.getByRole('button', { name: 'New session' }));
    expect(onAddSession).toHaveBeenCalledTimes(1);
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

  it('opens the debug panel from the { } header button', async () => {
    const user = userEvent.setup();
    const onOpenDebug = vi.fn();
    renderStatusBar({ onOpenDebug });

    await user.click(screen.getByRole('button', { name: 'Debug events' }));
    expect(onOpenDebug).toHaveBeenCalledTimes(1);
  });
});

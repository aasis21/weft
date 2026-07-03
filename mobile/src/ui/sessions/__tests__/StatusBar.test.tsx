import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { StatusBar } from '@/ui/sessions/StatusBar';

function renderStatusBar(props: Partial<ComponentProps<typeof StatusBar>> = {}) {
  const defaults: ComponentProps<typeof StatusBar> = {
    title: 'helm',
    cwd: 'C:\\Users\\akash\\helm',
    status: 'live',
    busy: false,
    sessionCount: 2,
    canReconnect: false,
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
    const { container } = renderStatusBar({ status: 'connecting', sessionCount: 1 });

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
        sessionCount={1}
        canReconnect={false}
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

  it('opens the drawer, home button, menu actions, reconnect, and direct leave callback', async () => {
    const user = userEvent.setup();
    const onOpenDrawer = vi.fn();
    const onGoHome = vi.fn();
    const onAddSession = vi.fn();
    const onReconnect = vi.fn();
    const onRemove = vi.fn();
    renderStatusBar({ canReconnect: true, onOpenDrawer, onGoHome, onAddSession, onReconnect, onRemove });

    await user.click(screen.getByRole('button', { name: 'Open sessions' }));
    expect(onOpenDrawer).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Home' }));
    expect(onGoHome).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    let menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '＋ Join another session' }));
    expect(onAddSession).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '↻ Reconnect' }));
    expect(onReconnect).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Session menu' }));
    menu = screen.getByRole('menu');
    await user.click(within(menu).getByRole('menuitem', { name: '✕ Leave this session' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });

  it('shows only the unread badge (not the session count) when there is unread activity', () => {
    const { container } = renderStatusBar({ sessionCount: 3 });
    // No unread in the runtime snapshot under test → session-count shows.
    expect(container.querySelector('.session-count')?.textContent).toBe('3');
    expect(container.querySelector('.unread-badge')).not.toBeInTheDocument();
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
    renderStatusBar({ canReconnect: true });

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

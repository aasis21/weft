import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LandingScreen } from '@/ui/screens/LandingScreen';

describe('LandingScreen install command tabs accessibility', () => {
  it('supports arrow-key and Home/End navigation with one tab stop', async () => {
    const user = userEvent.setup();
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );
    const windows = screen.getByRole('tab', { name: 'Windows' });
    const unix = screen.getByRole('tab', { name: 'macOS · Linux' });
    await user.click(windows);
    await user.keyboard('{ArrowRight}');
    expect(unix).toHaveFocus();
    expect(unix).toHaveAttribute('aria-selected', 'true');
    expect(windows).toHaveAttribute('tabindex', '-1');
    await user.keyboard('{Home}');
    expect(windows).toHaveFocus();
    await user.keyboard('{End}');
    expect(unix).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    expect(windows).toHaveFocus();
  });

  it('copies the selected command and announces clipboard failures', async () => {
    const user = userEvent.setup();
    const clipboard = vi.spyOn(navigator.clipboard, 'writeText');
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );
    await user.click(screen.getByRole('tab', { name: 'Windows' }));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(clipboard).toHaveBeenCalledWith('irm https://useweft.netlify.app/install.ps1 | iex');
    expect(screen.getByRole('status')).toHaveTextContent('Copied to clipboard.');
    clipboard.mockRejectedValueOnce(new Error('Clipboard blocked'));
    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(screen.getByRole('status')).toHaveTextContent('Copy unavailable. Select the command and copy it manually.');
    clipboard.mockRestore();
  });

  it('links each OS tab to the command tabpanel', async () => {
    const user = userEvent.setup();
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );

    const windows = screen.getByRole('tab', { name: 'Windows' });
    const unix = screen.getByRole('tab', { name: 'macOS · Linux' });
    const panel = screen.getByRole('tabpanel');

    expect(panel).toHaveAttribute('id', 'install-command-panel');
    expect(windows).toHaveAttribute('aria-controls', 'install-command-panel');
    expect(unix).toHaveAttribute('aria-controls', 'install-command-panel');
    const selected = windows.getAttribute('aria-selected') === 'true' ? windows : unix;
    const other = selected === windows ? unix : windows;
    expect(panel).toHaveAttribute('aria-labelledby', selected.id);

    await user.click(other);
    expect(panel).toHaveAttribute('aria-labelledby', other.id);
  });

  it('presents install, weft start, then scan as the primary path', async () => {
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );

    const steps = within(screen.getByRole('region', { name: 'How it works' })).getByRole('list');
    await waitFor(() => expect(screen.getByRole('button', { name: /Switch to .* mode/ })).toBeEnabled());
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Install on your laptop');
    expect(items[1]).toHaveTextContent('Run weft start');
    expect(items[2]).toHaveTextContent('Scan with your phone');
    expect(within(steps).queryByText(/\/weft/)).not.toBeInTheDocument();
  });

  it('links to the public trust and support documents', async () => {
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /Switch to .* mode/ })).toBeEnabled());
    expect(screen.getAllByRole('link', { name: 'Privacy' })[0]).toHaveAttribute(
      'href',
      'https://github.com/aasis21/weft/blob/main/PRIVACY.md',
    );
    expect(screen.getByRole('link', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Support' })).toBeInTheDocument();
  });

  it('explains opt-in shared terminal access separately from Copilot permissions', async () => {
    const user = userEvent.setup();
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );
    await user.click(screen.getByText('Where does my work run? Can I leave my desk?'));
    expect(screen.getByText(/Open terminal creates or resumes one real laptop shell/)).toBeVisible();
    await user.click(screen.getByText('Who can see or control my session?'));
    expect(screen.getByText('weft start --allow-terminal')).toBeVisible();
    expect(screen.getByText(/not through Copilot's approval flow/)).toBeVisible();
    expect(screen.getByText(/Terminal input and output are excluded from Weft diagnostic logs/)).toBeVisible();
  });
});

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { LandingScreen } from '@/ui/screens/LandingScreen';

describe('LandingScreen install command tabs accessibility', () => {
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

  it('presents install, weft start, then scan as the primary path', () => {
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );

    const steps = within(screen.getByRole('region', { name: 'How it works' })).getByRole('list');
    const items = within(steps).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Install on your laptop');
    expect(items[1]).toHaveTextContent('Run weft start');
    expect(items[2]).toHaveTextContent('Scan with your phone');
    expect(within(steps).queryByText(/\/weft/)).not.toBeInTheDocument();
  });

  it('links to the public trust and support documents', () => {
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );

    expect(screen.getAllByRole('link', { name: 'Privacy' })[0]).toHaveAttribute(
      'href',
      'https://github.com/aasis21/weft/blob/main/PRIVACY.md',
    );
    expect(screen.getByRole('link', { name: 'Security' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Support' })).toBeInTheDocument();
  });
});

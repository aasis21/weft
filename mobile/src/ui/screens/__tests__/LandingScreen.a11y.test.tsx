import { render, screen } from '@testing-library/react';
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
    expect(panel).toHaveAttribute('aria-labelledby', windows.id);

    await user.click(unix);
    expect(panel).toHaveAttribute('aria-labelledby', unix.id);
  });
});

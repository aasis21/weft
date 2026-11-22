import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import * as notifications from '@/lib/notifications';
import { ALERTS_PROMPT_KEY } from '@/lib/firstRun';
import { AlertsOptIn } from '../AlertsOptIn';

const permission = notifications.notificationPermission as unknown as Mock;
const request = notifications.ensureNotificationPermission as unknown as Mock;

describe('AlertsOptIn', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('asks only after the user taps Allow, and does not return once answered', async () => {
    permission.mockResolvedValue('prompt');
    const user = userEvent.setup();
    const { unmount } = render(<AlertsOptIn />);

    await user.click(await screen.findByRole('button', { name: 'Allow' }));
    expect(request).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('region', { name: 'Approval alerts' })).not.toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(ALERTS_PROMPT_KEY)).toBe('done'));
    unmount();

    render(<AlertsOptIn />);
    await waitFor(() => expect(permission).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('region', { name: 'Approval alerts' })).not.toBeInTheDocument();
  });

  it('Not now dismisses without requesting permission', async () => {
    permission.mockResolvedValue('prompt');
    const user = userEvent.setup();
    render(<AlertsOptIn />);
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    expect(request).not.toHaveBeenCalled();
  });

  it('stays hidden when permission is already decided', async () => {
    permission.mockResolvedValue('granted');
    render(<AlertsOptIn />);
    await waitFor(() => expect(permission).toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Approval alerts' })).not.toBeInTheDocument();
  });
});

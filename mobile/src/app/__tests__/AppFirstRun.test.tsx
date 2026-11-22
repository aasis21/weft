import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/app/App';
import { ONBOARDING_KEY } from '@/lib/firstRun';

vi.mock('@/session/runtime/instance', () => {
  const snapshot = { ready: true, activeId: null, sessions: [], devices: [] };
  return {
    sessionAccess: { init: () => Promise.resolve() },
    sessionRuntime: {
      setChatVisible: vi.fn(),
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      init: () => Promise.resolve(),
    },
  };
});

vi.mock('@/ui/hooks/usePairing', () => ({ isNativeRuntime: () => true }));

vi.mock('@/ui/screens/ConnectScreen', () => ({
  ConnectScreen: ({ showIntro, onIntroDone }: { showIntro?: boolean; onIntroDone?(): void }) => (
    <main data-testid="connect">
      {showIntro ? <button type="button" onClick={onIntroDone}>Got it</button> : <span>Compact connect</span>}
    </main>
  ),
}));

describe('App first run', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('welcomes a fresh install once and remembers Got it locally', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Got it' }));
    expect(screen.getByText('Compact connect')).toBeInTheDocument();
    await waitFor(() => expect(localStorage.getItem(ONBOARDING_KEY)).toBe('done'));
    unmount();

    render(<App />);
    expect(await screen.findByText('Compact connect')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Got it' })).not.toBeInTheDocument();
  });
});

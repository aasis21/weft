import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import App from '@/app/App';

const runtime = vi.hoisted(() => {
  const active = {
    meta: {
      kind: 'paired',
      channelId: 'channel-1',
      title: 'Mounted session',
      cwd: 'C:\\repo',
      addedAt: 1,
      scannedAt: 1,
    },
    status: 'live',
    timeline: {
      items: [],
      history: [],
      historyHasMore: false,
      historyLoading: false,
      approvals: [],
      approvalErrors: {},
      elicitations: [],
      elicitationErrors: {},
      busy: false,
      abortable: false,
      mode: 'interactive',
      endedReason: null,
    },
    events: [],
  };
  return {
    snapshot: {
      ready: true,
      activeId: 'channel-1',
      sessions: [active],
      devices: [],
    },
  };
});

vi.mock('@/session/runtime/instance', () => {
  const noOp = vi.fn();
  return {
    sessionAccess: {
      init: () => Promise.resolve(),
      cancel: noOp,
      open: noOp,
      confirmTakeover: noOp,
      retry: noOp,
    },
    sessionRuntime: {
      subscribe: () => () => {},
      getSnapshot: () => runtime.snapshot,
      init: () => Promise.resolve(),
      remove: noOp,
      setActive: noOp,
      sendPrompt: noOp,
      sendApproval: noOp,
      sendElicitation: noOp,
      sendInterrupt: noOp,
      sendMode: noOp,
      sendCommand: noOp,
      retryPrompt: noOp,
      setVoiceMode: noOp,
      renameSession: noOp,
      pin: noOp,
      reloadHistory: noOp,
      archive: noOp,
      reconnect: noOp,
    },
  };
});

vi.mock('@/ui/hooks/usePairing', () => ({
  isNativeRuntime: () => false,
}));

vi.mock('@/ui/screens/SessionScreen', () => ({
  SessionScreen: ({ onOpenExplore }: { onOpenExplore(): void }) => {
    const [count, setCount] = useState(0);
    return (
      <main data-testid="session-screen">
        <span>Local state {count}</span>
        <button type="button" onClick={() => setCount((value) => value + 1)}>Increment local state</button>
        <button type="button" onClick={onOpenExplore}>Open Explore</button>
      </main>
    );
  },
}));

vi.mock('@/ui/explore/ExploreScreen', () => ({
  ExploreScreen: () => <main data-testid="explore-screen">Explore overlay</main>,
}));

beforeEach(() => {
  window.history.replaceState(null, '');
});

describe('App Explore layering', () => {
  it('keeps the active SessionScreen mounted and inert beneath Explore, then restores it on Back', async () => {
    render(<App />);
    const session = await screen.findByTestId('session-screen');
    fireEvent.click(screen.getByRole('button', { name: 'Increment local state' }));
    expect(screen.getByText('Local state 1')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Open Explore' }));
    expect(await screen.findByTestId('explore-screen')).toBeInTheDocument();
    expect(session).toBeInTheDocument();
    expect(session.parentElement).toHaveAttribute('aria-hidden', 'true');
    expect(session.parentElement).toHaveAttribute('inert');

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });

    expect(screen.queryByTestId('explore-screen')).not.toBeInTheDocument();
    expect(screen.getByText('Local state 1')).toBeInTheDocument();
    expect(session.parentElement).not.toHaveAttribute('aria-hidden');
    expect(session.parentElement).not.toHaveAttribute('inert');
  });
});

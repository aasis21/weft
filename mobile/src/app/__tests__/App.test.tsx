import { act, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

vi.mock('@/ui/screens/LandingScreen', () => ({
  LandingScreen: () => <main data-testid="landing-screen">Landing</main>,
}));

vi.mock('@/ui/screens/SessionScreen', () => ({
  SessionScreen: ({
    onOpenExplore,
    onOpenDiscover,
    exploreOpen,
    exploreInitialView,
    exploreDirectFromChat,
    onCloseExplore,
    onGoHome,
  }: {
    onOpenExplore(): void;
    onOpenDiscover(): void;
    exploreOpen: boolean;
    exploreInitialView?: string;
    exploreDirectFromChat?: boolean;
    onCloseExplore(): void;
    onGoHome(): void;
  }) => {
    const [count, setCount] = useState(0);
    return (
      <>
        <main
          data-testid="session-screen"
          aria-hidden={exploreOpen || undefined}
          {...(exploreOpen ? { inert: '' as unknown as boolean } : {})}
        >
          <span>Local state {count}</span>
          <button type="button" onClick={() => setCount((value) => value + 1)}>Increment local state</button>
          <button type="button" onClick={onOpenExplore}>Open Explore</button>
          <button type="button" onClick={onOpenDiscover}>Open Discover directly</button>
        </main>
        {exploreOpen ? (
          <main data-testid="explore-screen">
            Explore overlay {exploreInitialView ?? 'home'} {exploreDirectFromChat ? 'from chat' : ''}
            <button type="button" onClick={onCloseExplore}>Back to chat</button>
            <button type="button" onClick={onGoHome}>Go Home</button>
          </main>
        ) : null}
      </>
    );
  },
}));

beforeEach(() => {
  window.history.replaceState(null, '');
});

afterEach(() => {
  vi.restoreAllMocks();
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
    expect(session).toHaveAttribute('aria-hidden', 'true');
    expect(session).toHaveAttribute('inert');

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    });

    expect(screen.queryByTestId('explore-screen')).not.toBeInTheDocument();
    expect(screen.getByText('Local state 1')).toBeInTheDocument();
    expect(session).not.toHaveAttribute('aria-hidden');
    expect(session).not.toHaveAttribute('inert');
  });

  it('collapses both Explore history entries when going Home from a category', async () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    render(<App />);
    await screen.findByTestId('session-screen');
    fireEvent.click(screen.getByRole('button', { name: 'Open Explore' }));
    window.history.pushState({ weftView: 'explore', exploreView: 'discover' }, '');

    fireEvent.click(screen.getByRole('button', { name: 'Go Home' }));

    expect(go).toHaveBeenCalledWith(-2);
  });

  it('opens Discover directly with one history entry and returns to Chat in one Back action', async () => {
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    render(<App />);
    await screen.findByTestId('session-screen');

    fireEvent.click(screen.getByRole('button', { name: 'Open Discover directly' }));

    expect(await screen.findByTestId('explore-screen')).toHaveTextContent('discover from chat');
    expect(window.history.state).toEqual({
      weftView: 'explore',
      exploreView: 'discover',
      entry: 'direct-discover',
    });

    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(go).toHaveBeenCalledWith(-1);
  });
});

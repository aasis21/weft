import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyTimeline } from '@/lib/timeline';
import type { SessionView } from '@/session/view';
import {
  ExploreScreen,
  buildDiscoverDeck,
  countThreadlineCrossings,
  createSignalSequence,
  createThreadlinePoints,
  deriveLiveDock,
  deriveLiveDockActivity,
} from '@/ui/explore/ExploreScreen';
import { DISCOVER_CARDS } from '@/ui/explore/discoverCards';

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    meta: {
      kind: 'live',
      channelId: 'channel-1',
      title: 'Explore session',
      cwd: 'C:\\repo',
      addedAt: 1,
      scannedAt: 1,
    },
    status: 'live',
    timeline: emptyTimeline(),
    events: [],
    ...overrides,
  } as SessionView;
}

function renderExplore(active = session()) {
  return render(
    <ExploreScreen
      active={active}
      onOpenSessions={vi.fn()}
      onOpenChat={vi.fn()}
      onGoHome={vi.fn()}
    />,
  );
}

function useReducedMotion(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query === '(prefers-reduced-motion: reduce)',
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

beforeEach(() => {
  localStorage.clear();
  window.history.replaceState(null, '');
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('Explore catalog', () => {
  it('ships exactly 50 unique, bounded starter cards', () => {
    expect(DISCOVER_CARDS).toHaveLength(50);
    expect(new Set(DISCOVER_CARDS.map((card) => card.id)).size).toBe(50);
    for (const card of DISCOVER_CARDS) {
      expect(card.title.length).toBeGreaterThan(8);
      expect(card.title.length).toBeLessThanOrEqual(52);
      expect(card.summary.length).toBeGreaterThan(40);
      expect(card.summary.length).toBeLessThanOrEqual(170);
      expect(card.insight.length).toBeGreaterThan(40);
      expect(card.insight.length).toBeLessThanOrEqual(190);
      expect(card.minutes).toBeGreaterThan(0);
    }
  });
});

describe('Live Copilot Dock', () => {
  it('prioritizes attention over working state', () => {
    const active = session({
      timeline: {
        ...emptyTimeline(),
        busy: true,
        approvals: [{
          requestId: 'approval-1',
          toolName: 'Run tests',
          toolArgs: {},
          options: [{ id: 'approve', label: 'Approve' }],
        }],
      },
    });

    expect(deriveLiveDock(active)).toMatchObject({
      tone: 'attention',
      label: 'Approval needed',
      text: 'Run tests',
    });
  });

  it('projects streamed assistant text into the fixed dock and opens chat', async () => {
    const onOpenChat = vi.fn();
    const active = session({
      timeline: {
        ...emptyTimeline(),
        busy: true,
        busyFrom: Date.now() - 4_000,
        items: [{
          kind: 'assistant',
          id: 'reply-1',
          text: 'I am checking the focused mobile tests now.',
          ts: Date.now(),
          final: false,
        }],
      },
    });
    const user = userEvent.setup();
    render(
      <ExploreScreen
        active={active}
        onOpenSessions={vi.fn()}
        onOpenChat={onOpenChat}
        onGoHome={vi.fn()}
      />,
    );

    const dock = screen.getByRole('button', { name: /Copilot is writing/ });
    expect(dock).toHaveTextContent('I am checking the focused mobile tests now.');
    await user.click(dock);
    expect(onOpenChat).toHaveBeenCalledOnce();
  });

  it('shows ordered real assistant and tool activity without inventing extra steps', () => {
    const active = session({
      intent: 'Validate the Explore redesign',
      timeline: {
        ...emptyTimeline(),
        busy: true,
        busyFrom: 50,
        items: [
          {
            kind: 'tool',
            id: 'read-tool',
            name: 'view',
            args: { description: 'Read ExploreScreen.tsx' },
            status: 'success',
            startedAt: 60,
            finishedAt: 70,
            ts: 60,
          },
          {
            kind: 'assistant',
            id: 'streaming-reply',
            text: 'I am tightening the card layout.',
            ts: 80,
            final: false,
          },
          {
            kind: 'tool',
            id: 'test-tool',
            name: 'powershell',
            args: { description: 'Run focused Explore tests' },
            status: 'running',
            startedAt: 90,
            ts: 90,
          },
        ],
      },
    });
    const dock = deriveLiveDock(active);
    const activity = deriveLiveDockActivity(active, dock);

    expect(activity.map((item) => item.text)).toEqual([
      'View: Read ExploreScreen.tsx',
      'Run Command: Run focused Explore tests',
      'I am tightening the card layout.',
    ]);
    renderExplore(active);
    expect(document.querySelectorAll('.live-copilot-current')).toHaveLength(1);
    expect(document.querySelectorAll('.live-copilot-previous')).toHaveLength(1);
    expect(document.querySelectorAll('.live-copilot-stream')).toHaveLength(1);
    expect(document.querySelector('.live-copilot-feed')).toHaveTextContent(
      'Run focused Explore tests',
    );

    const quiet = session({
      intent: 'Thinking through the safest change',
      timeline: { ...emptyTimeline(), busy: true, busyFrom: 100 },
    });
    expect(deriveLiveDockActivity(quiet, deriveLiveDock(quiet))).toEqual([
      expect.objectContaining({ text: 'Thinking through the safest change' }),
    ]);
  });

  it('shows a newly completed active-session reply without relying on unread state', () => {
    const props = {
      onOpenSessions: vi.fn(),
      onOpenChat: vi.fn(),
      onGoHome: vi.fn(),
    };
    const { rerender } = render(
      <ExploreScreen
        {...props}
        active={session({
          timeline: {
            ...emptyTimeline(),
            busy: true,
            items: [{
              kind: 'assistant',
              id: 'active-reply',
              text: 'Finishing the implementation.',
              ts: 100,
              final: false,
            }],
          },
        })}
      />,
    );

    rerender(
      <ExploreScreen
        {...props}
        active={session({
          unread: false,
          unreadCount: 0,
          timeline: {
            ...emptyTimeline(),
            items: [{
              kind: 'assistant',
              id: 'active-reply',
              text: 'The implementation is complete.',
              ts: 100,
              final: true,
            }],
          },
        })}
      />,
    );

    expect(screen.getByRole('button', { name: /Reply ready/ })).toHaveTextContent(
      'The implementation is complete.',
    );
  });

  it('handles final-before-idle ordering and resets completion tracking across sessions', () => {
    const props = {
      onOpenSessions: vi.fn(),
      onOpenChat: vi.fn(),
      onGoHome: vi.fn(),
    };
    const streaming = (busy: boolean, final: boolean, channelId = 'channel-1') => session({
      meta: {
        kind: 'live',
        channelId,
        title: 'Explore session',
        cwd: 'C:\\repo',
        addedAt: 1,
        scannedAt: 1,
      },
      timeline: {
        ...emptyTimeline(),
        busy,
        items: [{
          kind: 'assistant',
          id: channelId === 'channel-1' ? 'ordered-reply' : 'other-reply',
          text: final ? 'Ordered reply complete.' : 'Writing ordered reply.',
          ts: 100,
          final,
        }],
      },
    });
    const { rerender } = render(<ExploreScreen {...props} active={streaming(true, false)} />);
    rerender(<ExploreScreen {...props} active={streaming(true, true)} />);
    expect(screen.getByRole('button', { name: /Copilot is working/ })).toBeInTheDocument();
    rerender(<ExploreScreen {...props} active={streaming(false, true)} />);
    expect(screen.getByRole('button', { name: /Reply ready/ })).toBeInTheDocument();

    rerender(<ExploreScreen {...props} active={streaming(false, true, 'channel-2')} />);
    expect(screen.getByRole('button', { name: /Copilot ready/ })).toBeInTheDocument();
  });

  it('falls back through intent, running tool, reply, and idle states', () => {
    expect(deriveLiveDock(session({
      intent: 'Running focused checks',
      timeline: { ...emptyTimeline(), busy: true, busyFrom: 100 },
    }))).toMatchObject({ tone: 'working', text: 'Running focused checks' });

    expect(deriveLiveDock(session({
      timeline: {
        ...emptyTimeline(),
        busy: true,
        items: [{
          kind: 'tool',
          id: 'tool-1',
          name: 'powershell',
          args: { description: 'Run mobile tests' },
          status: 'running',
          startedAt: 100,
          ts: 100,
        }],
      },
    }))).toMatchObject({ tone: 'working', text: 'Run Command: Run mobile tests' });

    expect(deriveLiveDock(session({
      unread: true,
      timeline: {
        ...emptyTimeline(),
        items: [{
          kind: 'assistant',
          id: 'reply-1',
          text: 'The implementation is ready.',
          ts: 100,
          final: true,
        }],
      },
    }))).toMatchObject({ tone: 'ready', text: 'The implementation is ready.' });

    expect(deriveLiveDock(session())).toMatchObject({ tone: 'idle', label: 'Copilot ready' });
  });

  it('collapses adjacent duplicate tools and never exposes raw compact arguments', () => {
    const active = session({
      timeline: {
        ...emptyTimeline(),
        busy: true,
        items: [
          {
            kind: 'tool',
            id: 'search-1',
            name: 'rg',
            args: { pattern: 'private first query', paths: 'C:\\private\\repo' },
            status: 'success',
            startedAt: 10,
            finishedAt: 11,
            ts: 10,
          },
          {
            kind: 'tool',
            id: 'search-2',
            name: 'rg',
            args: { pattern: 'private second query', paths: 'C:\\private\\repo' },
            status: 'running',
            startedAt: 12,
            ts: 12,
          },
        ],
      },
    });

    expect(deriveLiveDockActivity(active, deriveLiveDock(active))).toEqual([
      expect.objectContaining({ text: 'Search', count: 2, state: 'live' }),
    ]);
    renderExplore(active);
    expect(screen.getByRole('button', { name: /Search/ })).toHaveTextContent('Search ×2');
    expect(document.body).not.toHaveTextContent('private first query');
    expect(document.body).not.toHaveTextContent('C:\\private\\repo');
  });

  it('hides short elapsed times and presents attention as one chat action', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T00:00:03Z'));
    const short = session({
      timeline: { ...emptyTimeline(), busy: true, busyFrom: Date.parse('2026-09-26T00:00:00Z') },
    });
    const { unmount } = renderExplore(short);
    expect(document.querySelector('.live-copilot-status time')).not.toBeInTheDocument();
    unmount();

    vi.setSystemTime(new Date('2026-09-26T00:00:08Z'));
    const elapsed = renderExplore(short);
    expect(document.querySelector('.live-copilot-status time')).toHaveTextContent('8s');
    elapsed.unmount();

    const attention = session({
      timeline: {
        ...emptyTimeline(),
        approvals: [{
          requestId: 'approval-1',
          toolName: 'powershell',
          toolArgs: {},
          options: [{ id: 'approve', label: 'Approve' }],
        }],
      },
    });
    renderExplore(attention);
    expect(screen.getByRole('button', { name: /Approval needed/ })).toHaveTextContent('Review in chat');
    expect(document.querySelector('.live-copilot-feed')).not.toBeInTheDocument();
  });
});

describe('Explore navigation and Discover deck', () => {
  it('opens direct Discover with one Back to chat affordance', async () => {
    const onOpenChat = vi.fn();
    const user = userEvent.setup();
    render(
      <ExploreScreen
        active={session()}
        onOpenSessions={vi.fn()}
        onOpenChat={onOpenChat}
        onGoHome={vi.fn()}
        initialView="discover"
        directFromChat
      />,
    );

    expect(screen.getByRole('region', { name: 'Discover card deck' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(onOpenChat).toHaveBeenCalledOnce();
  });

  it('uses the shared navigation affordance and compact four-choice home', async () => {
    const onOpenSessions = vi.fn();
    const user = userEvent.setup();
    render(
      <ExploreScreen
        active={session()}
        onOpenSessions={onOpenSessions}
        onOpenChat={vi.fn()}
        onGoHome={vi.fn()}
      />,
    );

    expect(screen.getByRole('heading', { name: 'What do you feel like?' })).toBeInTheDocument();
    expect(screen.queryByText(/Pick something useful/)).not.toBeInTheDocument();
    expect(document.querySelectorAll('.explore-header-nav button')).toHaveLength(4);
    expect(document.querySelector('.explore-tabs')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open sessions' }));
    expect(onOpenSessions).toHaveBeenCalledOnce();
  });

  it('keeps the header, flexible content, and live dock as one bounded shell', () => {
    renderExplore();
    const content = document.querySelector('.explore-content');
    expect(content?.firstElementChild).toHaveClass('explore-header');
    expect(content?.lastElementChild).toHaveClass('live-copilot-dock');
    expect(document.querySelector('.agent-pulse')).not.toBeInTheDocument();
    expect(document.querySelector('.agent-activity-view')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Play: Puzzles and mini-games' }));
    expect(screen.getByRole('button', { name: 'Show Play' })).toHaveClass('active');
    expect(document.querySelector('.explore-header')?.nextElementSibling).toHaveClass('explore-category-body');
    expect(document.querySelector('.explore-category-body')?.nextElementSibling).toHaveClass('live-copilot-dock');
  });

  it('integrates category detail with browser history without adding card entries', () => {
    useReducedMotion();
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Discover: Read something worth knowing' }));
    expect(window.history.state).toEqual({ weftView: 'explore', exploreView: 'discover' });
    const before = window.history.length;
    fireEvent.click(screen.getByRole('button', { name: 'Next Discover card' }));
    expect(window.history.length).toBe(before);

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { weftView: 'explore' } }));
    });
    expect(screen.getByRole('heading', { name: 'What do you feel like?' })).toBeInTheDocument();
  });

  it('builds a deterministic balanced deck with no repeats', () => {
    const first = buildDiscoverDeck(DISCOVER_CARDS, 12345);
    const second = buildDiscoverDeck(DISCOVER_CARDS, 12345);
    expect(first.map((card) => card.id)).toEqual(second.map((card) => card.id));
    expect(new Set(first.map((card) => card.id)).size).toBe(DISCOVER_CARDS.length);
    expect(first).toHaveLength(DISCOVER_CARDS.length);
    for (let index = 1; index < first.length; index += 1) {
      expect(first[index].topic).not.toBe(first[index - 1].topic);
    }
  });

  it('shows one complete card, advances with controls and keyboard, and persists position', () => {
    useReducedMotion();
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Discover: Read something worth knowing' }));
    const deck = screen.getByRole('region', { name: 'Discover card deck' });
    expect(document.querySelectorAll('.discover-deck-card')).toHaveLength(1);
    const firstTitle = document.querySelector('.discover-deck-card h1')?.textContent;
    expect(document.querySelector('.discover-deck-illustration')).not.toBeInTheDocument();
    expect(document.querySelector('.discover-deck-actions')).not.toBeInTheDocument();
    expect(document.querySelector('.discover-deck-topline > span:last-child')).toHaveTextContent(
      new RegExp(`1 / ${DISCOVER_CARDS.length}·\\d+ min`),
    );
    expect(screen.getByRole('button', { name: 'Previous Discover card' })).toHaveClass(
      'discover-edge-nav',
    );

    fireEvent.click(screen.getByRole('button', { name: 'Next Discover card' }));
    expect(document.querySelector('.discover-deck-card h1')?.textContent).not.toBe(firstTitle);
    expect(JSON.parse(localStorage.getItem('weft.explore.v1') ?? '{}').discoverIndex).toBe(1);

    fireEvent.keyDown(deck, { key: 'ArrowLeft' });
    expect(document.querySelector('.discover-deck-card h1')?.textContent).toBe(firstTitle);
  });

  it('follows dominant horizontal swipes, reveals the next card, and commits after exit', () => {
    vi.useFakeTimers();
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Discover: Read something worth knowing' }));
    const deck = screen.getByRole('region', { name: 'Discover card deck' });
    const firstTitle = document.querySelector('.discover-deck-card h1')?.textContent;

    fireEvent.pointerDown(deck, { clientX: 10, clientY: 100 });
    fireEvent.pointerMove(deck, { clientX: 30, clientY: 20 });
    fireEvent.pointerUp(deck, { clientX: 30, clientY: 20 });
    expect(document.querySelector('.discover-deck-card h1')?.textContent).toBe(firstTitle);

    fireEvent.pointerDown(deck, { clientX: 100, clientY: 100 });
    fireEvent.pointerMove(deck, { clientX: 20, clientY: 98 });
    expect(document.querySelector('.discover-deck-card-current')).toHaveClass(
      'discover-deck-card-dragging',
    );
    expect(document.querySelector('.discover-deck-card-underlay')).toBeInTheDocument();
    fireEvent.pointerUp(deck, { clientX: 20, clientY: 98 });
    expect(document.querySelector('.discover-deck-card-current')).toHaveClass(
      'discover-deck-card-exiting',
    );
    act(() => vi.advanceTimersByTime(240));
    expect(document.querySelector('.discover-deck-card h1')?.textContent).not.toBe(firstTitle);
    expect(screen.queryByRole('group', { name: 'Discover topics' })).not.toBeInTheDocument();
  });

  it('removes the legacy per-card preference from Explore storage', async () => {
    const legacyKey = 'savedCardIds';
    localStorage.setItem('weft.explore.v1', JSON.stringify({
      [legacyKey]: ['legacy-card'],
      lastCategory: 'discover',
    }));
    const user = userEvent.setup();
    renderExplore();
    await user.click(screen.getByRole('button', { name: 'Discover: Read something worth knowing' }));
    expect(localStorage.getItem('weft.explore.v1')).not.toContain(legacyKey);
    expect(document.querySelectorAll('.discover-edge-nav')).toHaveLength(2);
  });

  it('starts a new shuffled cycle only after the current deck is exhausted', () => {
    useReducedMotion();
    const today = new Date();
    const day = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    localStorage.setItem('weft.explore.v1', JSON.stringify({
      lastCategory: 'discover',
      completedCardIds: [],
      discoverDay: day,
      discoverCycle: 2,
      discoverIndex: DISCOVER_CARDS.length - 1,
      threadlineCompleted: 0,
      signalBest: 0,
      vibration: false,
    }));
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Discover: Read something worth knowing' }));
    expect(screen.getByText(`50 / ${DISCOVER_CARDS.length}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next Discover card' }));
    expect(JSON.parse(localStorage.getItem('weft.explore.v1') ?? '{}')).toMatchObject({
      discoverCycle: 3,
      discoverIndex: 0,
    });
    expect(screen.getByText(`1 / ${DISCOVER_CARDS.length}`)).toBeInTheDocument();
  });

  it('loads configured Watch content only after consent and keeps it isolated', () => {
    vi.stubEnv('VITE_EXPLORE_WIDGET_URL', 'https://videos.example.test/embed');
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Watch: Short visual content' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load video feed' }));
    const frame = screen.getByTitle('External short video feed');
    expect(frame).toHaveAttribute('src', 'https://videos.example.test/embed');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation',
    );
    fireEvent.load(frame);
    expect(screen.getByRole('status')).toHaveTextContent('Display readiness cannot be verified yet.');
  });
});

describe('Threadline logic', () => {
  it('generates deterministic boards and counts crossings consistently', () => {
    const first = createThreadlinePoints(42);
    const second = createThreadlinePoints(42);
    expect(first).toEqual(second);
    expect(countThreadlineCrossings(first)).toBe(countThreadlineCrossings(second));
    expect(countThreadlineCrossings(first)).toBeGreaterThan(0);
  });

  it('uses a planar graph that has a legitimate zero-crossing solution', () => {
    expect(countThreadlineCrossings([
      { id: 0, x: 50, y: 10 },
      { id: 1, x: 85, y: 30 },
      { id: 2, x: 85, y: 70 },
      { id: 3, x: 50, y: 90 },
      { id: 4, x: 15, y: 70 },
      { id: 5, x: 15, y: 30 },
    ])).toBe(0);
  });

  it('rejects coincident nodes and nodes on unrelated edges', () => {
    const planar = [
      { id: 0, x: 50, y: 10 },
      { id: 1, x: 85, y: 30 },
      { id: 2, x: 85, y: 70 },
      { id: 3, x: 50, y: 90 },
      { id: 4, x: 15, y: 70 },
      { id: 5, x: 15, y: 30 },
    ];
    expect(countThreadlineCrossings(planar.map((point) =>
      point.id === 5 ? { ...point, x: 15, y: 70 } : point,
    ))).toBeGreaterThan(0);
    expect(countThreadlineCrossings(planar.map((point) =>
      point.id === 5 ? { ...point, x: 67.5, y: 20 } : point,
    ))).toBeGreaterThan(0);
  });

  it('supports free play and keyboard point movement', () => {
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Play: Puzzles and mini-games' }));
    fireEvent.click(screen.getByRole('button', { name: 'Free play' }));
    fireEvent.click(screen.getByRole('button', { name: /Threadline/ }));

    expect(screen.getByText('Threadline · Free play')).toBeInTheDocument();
    const point = screen.getByRole('button', { name: 'Move point 1' });
    const before = point.getAttribute('transform');
    fireEvent.keyDown(point, { key: 'ArrowRight' });
    expect(point.getAttribute('transform')).not.toBe(before);
  });
});

describe('Signal Steps and Unwind', () => {
  it('advances Signal Steps after the deterministic sequence is repeated', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Play: Puzzles and mini-games' }));
    fireEvent.click(screen.getByRole('button', { name: /Signal Steps/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Show sequence' }));
    act(() => vi.advanceTimersByTime(2_700));

    const expected = createSignalSequence(20_250_192, 3);
    for (const cell of expected) {
      fireEvent.click(screen.getByRole('button', { name: `Signal tile ${cell + 1}` }));
    }

    expect(screen.getByText('Correct.')).toBeInTheDocument();
    expect(localStorage.getItem('weft.explore.v1')).toContain('"signalBest":3');
  });

  it('uses elapsed deadlines for sparse callbacks while preserving pause and restart', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2025-01-01T12:00:00Z'));
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Unwind: Breathe, reset, and rest' }));
    fireEvent.click(screen.getByRole('button', { name: /Weave Breath/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
    vi.setSystemTime(new Date('2025-01-01T12:00:45Z'));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByText('0:15')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    vi.setSystemTime(new Date('2025-01-01T12:01:45Z'));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByText('0:15')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Begin' }));
    vi.setSystemTime(new Date('2025-01-01T12:02:01Z'));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByRole('heading', { name: 'Complete' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '‹ Unwind' }));
    fireEvent.click(screen.getByRole('button', { name: /Eye Horizon/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start 20 seconds' }));
    vi.setSystemTime(new Date('2025-01-01T12:02:26Z'));
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(screen.getByRole('heading', { name: 'Welcome back' })).toBeInTheDocument();
    expect(screen.getByText('0s')).toBeInTheDocument();
  });
});

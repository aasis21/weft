import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyTimeline } from '@/lib/timeline';
import type { SessionView } from '@/session/view';
import {
  ExploreScreen,
  countThreadlineCrossings,
  createSignalSequence,
  createThreadlinePoints,
  deriveAgentPulse,
} from '@/ui/explore/ExploreScreen';
import { DISCOVER_CARDS } from '@/ui/explore/discoverCards';

function session(overrides: Partial<SessionView> = {}): SessionView {
  return {
    meta: {
      kind: 'paired',
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
      onBack={vi.fn()}
      onOpenChat={vi.fn()}
      onApprove={vi.fn()}
      onElicitationRespond={vi.fn()}
    />,
  );
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
  it('ships exactly 50 unique, readable starter cards', () => {
    expect(DISCOVER_CARDS).toHaveLength(50);
    expect(new Set(DISCOVER_CARDS.map((card) => card.id)).size).toBe(50);
    for (const card of DISCOVER_CARDS) {
      expect(card.title.length).toBeGreaterThan(8);
      expect(card.summary.length).toBeGreaterThan(40);
      expect(card.insight.length).toBeGreaterThan(40);
      expect(card.minutes).toBeGreaterThan(0);
    }
  });
});

describe('Agent Pulse', () => {
  it('prioritizes approvals over working state and does not alter the session status', () => {
    const timeline = {
      ...emptyTimeline(),
      busy: true,
      busyFrom: 1_000,
      approvals: [
        {
          requestId: 'approval-1',
          toolName: 'powershell',
          toolArgs: { command: 'npm test' },
          options: [{ id: 'approve', label: 'Approve' }],
        },
      ],
    };
    const active = session({ timeline });

    expect(deriveAgentPulse(active)).toMatchObject({
      tone: 'attention',
      label: 'Approval needed',
    });
    expect(active.status).toBe('live');
  });

  it('uses live agent intent and timing while work is in flight', () => {
    const active = session({
      intent: 'running focused mobile tests',
      thinkingSince: 5_000,
      timeline: { ...emptyTimeline(), busy: true, busyFrom: 4_000 },
    });

    expect(deriveAgentPulse(active)).toEqual({
      tone: 'working',
      label: 'running focused mobile tests',
      detail: 'Work is continuing in the active session',
      startedAt: 5_000,
    });
  });

  it('opens current activity without replacing the chat status', async () => {
    const user = userEvent.setup();
    const onOpenChat = vi.fn();
    const active = session({
      intent: 'Checking the mobile release',
      timeline: { ...emptyTimeline(), busy: true, busyFrom: Date.now() - 4_000 },
    });
    render(
      <ExploreScreen
        active={active}
        onBack={vi.fn()}
        onOpenChat={onOpenChat}
        onApprove={vi.fn()}
        onElicitationRespond={vi.fn()}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Checking the mobile release/ }));
    expect(screen.getByRole('heading', { name: 'Explore session' })).toBeInTheDocument();
    expect(screen.getAllByText('Checking the mobile release')).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Return to conversation' }));
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(active.status).toBe('live');
  });
});

describe('Explore navigation and content', () => {
  it('opens with Agent Pulse and four choices, then replaces choices with category tabs', async () => {
    const user = userEvent.setup();
    renderExplore();

    expect(screen.getByRole('button', { name: /Agent ready/ })).toBeInTheDocument();
    const discoverChoice = screen.getByRole('button', { name: 'Discover: Read something worth knowing' });
    expect(discoverChoice).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Watch: Short visual content' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Play: Puzzles and mini-games' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Unwind: Breathe, reset, and rest' })).toBeInTheDocument();

    await user.click(discoverChoice);

    expect(screen.getByRole('navigation', { name: 'Explore categories' })).toBeInTheDocument();
    expect(screen.queryByText('What do you feel like?')).not.toBeInTheDocument();
    expect(screen.getByText('How QR codes survive scratches')).toBeInTheDocument();
  });

  it('integrates category and agent detail state with browser history', () => {
    const onBack = vi.fn();
    render(
      <ExploreScreen
        active={session()}
        onBack={onBack}
        onOpenChat={vi.fn()}
        onApprove={vi.fn()}
        onElicitationRespond={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Unwind: Breathe, reset, and rest' }));
    expect(window.history.state).toEqual({ weftView: 'explore', exploreView: 'unwind' });

    fireEvent.click(screen.getByRole('button', { name: 'Discover' }));
    expect(window.history.state).toEqual({ weftView: 'explore', exploreView: 'discover' });

    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', {
        state: { weftView: 'explore' },
      }));
    });
    expect(screen.getByRole('heading', { name: 'What do you feel like?' })).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Back to chat' }));
    expect(onBack).toHaveBeenCalledOnce();
  });

  it('keeps bundled Discover cards readable while offline', () => {
    vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Discover: Read something worth knowing' }));
    expect(screen.getByRole('button', { name: 'Read How QR codes survive scratches' })).toBeInTheDocument();
  });

  it('opens a readable card and persists its saved state locally', async () => {
    const user = userEvent.setup();
    renderExplore();
    await user.click(screen.getByRole('button', { name: 'Discover: Read something worth knowing' }));
    await user.click(screen.getByRole('button', { name: 'Read How QR codes survive scratches' }));

    expect(screen.getByRole('heading', { name: 'How QR codes survive scratches' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save for later' }));
    expect(screen.getByRole('button', { name: 'Saved' })).toBeInTheDocument();
    expect(localStorage.getItem('weft.explore.v1')).toContain('qr-error-correction');
  });

  it('keeps approval decisions actionable above Explore content', async () => {
    const onApprove = vi.fn();
    const active = session({
      timeline: {
        ...emptyTimeline(),
        approvals: [
          {
            requestId: 'approval-1',
            toolName: 'Run tests',
            toolArgs: { command: 'npm test' },
            options: [
              { id: 'approve', label: 'Approve' },
              { id: 'deny', label: 'Deny' },
            ],
          },
        ],
      },
    });
    render(
      <ExploreScreen
        active={active}
        onBack={vi.fn()}
        onOpenChat={vi.fn()}
        onApprove={onApprove}
        onElicitationRespond={vi.fn()}
      />,
    );

    expect(screen.getByRole('dialog', { name: 'Agent needs your attention' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('approval-1', 'approve');
  });

  it('loads configured Watch content only after consent and keeps it isolated', () => {
    vi.stubEnv('VITE_EXPLORE_WIDGET_URL', 'https://videos.example.test/embed');
    renderExplore();

    fireEvent.click(screen.getByRole('button', { name: 'Watch: Short visual content' }));
    expect(screen.queryByTitle('External short video feed')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load video feed' }));

    const frame = screen.getByTitle('External short video feed');
    expect(frame).toHaveAttribute('src', 'https://videos.example.test/embed');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame).toHaveAttribute(
      'sandbox',
      'allow-scripts allow-forms allow-popups allow-popups-to-escape-sandbox allow-presentation',
    );
    expect(frame.getAttribute('src')).not.toContain('channel-1');
    fireEvent.load(frame);
    expect(screen.getByRole('status')).toHaveTextContent(
      'Provider navigation completed. Display readiness cannot be verified yet.',
    );
    expect(screen.queryByText('The provider reported that its content is ready.')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open provider directly' })).toHaveAttribute(
      'href',
      'https://videos.example.test/embed',
    );
  });

  it('times out to truthful unverified guidance without claiming the provider failed', () => {
    vi.useFakeTimers();
    vi.stubEnv('VITE_EXPLORE_WIDGET_URL', 'https://videos.example.test/embed');
    renderExplore();

    fireEvent.click(screen.getByRole('button', { name: 'Watch: Short visual content' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load video feed' }));
    const frame = screen.getByTitle('External short video feed');
    fireEvent.load(frame);
    act(() => vi.advanceTimersByTime(12_000));

    expect(screen.getByRole('alert')).toHaveTextContent('Weft could not verify the embedded display');
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(frame).toBeInTheDocument();
  });

  it('accepts optional readiness only from the configured provider origin and sends no context', () => {
    vi.stubEnv('VITE_EXPLORE_WIDGET_URL', 'https://videos.example.test/embed');
    renderExplore();
    fireEvent.click(screen.getByRole('button', { name: 'Watch: Short visual content' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load video feed' }));
    const frame = screen.getByTitle('External short video feed') as HTMLIFrameElement;
    fireEvent.load(frame);

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'https://attacker.example.test',
        source: frame.contentWindow,
        data: { type: 'weft:explore-ready', channelId: 'leak' },
      }));
    });
    expect(screen.queryByText('The provider reported that its content is ready.')).not.toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        origin: 'https://videos.example.test',
        source: frame.contentWindow,
        data: { type: 'weft:explore-ready' },
      }));
    });
    expect(screen.getByRole('status')).toHaveTextContent('The provider reported that its content is ready.');
    expect(frame.src).toBe('https://videos.example.test/embed');
    expect(frame.src).not.toContain('channel-1');
  });

  it('keeps an arriving approval operable above a loaded Watch frame', () => {
    vi.stubEnv('VITE_EXPLORE_WIDGET_URL', 'https://videos.example.test/embed');
    const onApprove = vi.fn();
    const props = {
      onBack: vi.fn(),
      onOpenChat: vi.fn(),
      onApprove,
      onElicitationRespond: vi.fn(),
    };
    const { rerender } = render(<ExploreScreen active={session()} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch: Short visual content' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load video feed' }));
    fireEvent.load(screen.getByTitle('External short video feed'));

    rerender(
      <ExploreScreen
        active={session({
          timeline: {
            ...emptyTimeline(),
            approvals: [{
              requestId: 'watch-approval',
              toolName: 'Publish release',
              toolArgs: {},
              options: [{ id: 'approve', label: 'Approve' }],
            }],
          },
        })}
        {...props}
      />,
    );

    expect(screen.getByTitle('External short video feed')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Agent needs your attention' })).toBeInTheDocument();
    const content = document.querySelector('.explore-content');
    expect(content).toHaveAttribute('aria-hidden', 'true');
    expect(content).toHaveAttribute('inert');
    expect(screen.getByRole('button', { name: 'Approve' })).toHaveFocus();
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledWith('watch-approval', 'approve');
  });

  it('traps interruption focus and restores the prior Watch focus after dismissal', () => {
    vi.stubEnv('VITE_EXPLORE_WIDGET_URL', 'https://videos.example.test/embed');
    const props = {
      onBack: vi.fn(),
      onOpenChat: vi.fn(),
      onApprove: vi.fn(),
      onElicitationRespond: vi.fn(),
    };
    const { rerender } = render(<ExploreScreen active={session()} {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Watch: Short visual content' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load video feed' }));
    const frame = screen.getByTitle('External short video feed');
    frame.focus();

    rerender(
      <ExploreScreen
        active={session({
          timeline: {
            ...emptyTimeline(),
            approvals: [{
              requestId: 'focus-approval',
              toolName: 'Publish release',
              toolArgs: {},
              options: [
                { id: 'approve', label: 'Approve' },
                { id: 'deny', label: 'Deny' },
              ],
            }],
          },
        })}
        {...props}
      />,
    );

    const approve = screen.getByRole('button', { name: 'Approve' });
    const deny = screen.getByRole('button', { name: 'Deny' });
    expect(approve).toHaveFocus();
    deny.focus();
    fireEvent.keyDown(deny, { key: 'Tab' });
    expect(approve).toHaveFocus();
    fireEvent.keyDown(approve, { key: 'Tab', shiftKey: true });
    expect(deny).toHaveFocus();

    rerender(<ExploreScreen active={session()} {...props} />);
    expect(frame).toHaveFocus();
    expect(document.querySelector('.explore-content')).not.toHaveAttribute('aria-hidden');
    expect(document.querySelector('.explore-content')).not.toHaveAttribute('inert');
  });

  it('focuses the dialog when a disconnected interruption has no enabled actions', () => {
    const props = {
      onBack: vi.fn(),
      onOpenChat: vi.fn(),
      onApprove: vi.fn(),
      onElicitationRespond: vi.fn(),
    };
    const { rerender } = render(<ExploreScreen active={session()} {...props} />);
    const underlying = screen.getByRole('button', { name: 'Back to chat' });
    underlying.focus();
    expect(underlying).toHaveFocus();

    rerender(
      <ExploreScreen
        active={session({
          status: 'connecting',
          timeline: {
            ...emptyTimeline(),
            approvals: [{
              requestId: 'disabled-approval',
              toolName: 'Waiting for reconnection',
              toolArgs: {},
              options: [{ id: 'approve', label: 'Approve' }],
            }],
          },
        })}
        {...props}
      />,
    );

    const dialog = screen.getByRole('dialog', { name: 'Agent needs your attention' });
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(document.querySelector('.explore-content')).toHaveAttribute('inert');
    expect(underlying).not.toHaveFocus();
    expect(dialog).toHaveAttribute('tabindex', '-1');
    expect(dialog).toHaveFocus();
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

  it('rejects coincident nodes, overlaps, endpoint touches, and nodes on unrelated edges', () => {
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
    expect(countThreadlineCrossings([
      { id: 0, x: 10, y: 10 },
      { id: 1, x: 30, y: 10 },
      { id: 2, x: 50, y: 10 },
      { id: 3, x: 80, y: 80 },
      { id: 4, x: 10, y: 80 },
      { id: 5, x: 80, y: 30 },
    ])).toBeGreaterThan(0);
    expect(countThreadlineCrossings([
      { id: 0, x: 10, y: 10 },
      { id: 1, x: 40, y: 40 },
      { id: 2, x: 40, y: 40 },
      { id: 3, x: 70, y: 10 },
      { id: 4, x: 80, y: 80 },
      { id: 5, x: 10, y: 80 },
    ])).toBeGreaterThan(0);
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

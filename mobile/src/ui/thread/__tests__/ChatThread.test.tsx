import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChatThread } from '@/ui/thread/ChatThread';
import type { TimelineItem } from '@/lib/timeline';

const now = Date.UTC(2026, 6, 1, 12, 0);

/** A freshly-opened thread deliberately ignores scroll position while it settles at the newest
 *  message, so anything asserting read-anywhere behaviour has to wait that window out first. */
async function settleThread(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 320));
  });
}

describe('ChatThread', () => {
  it('renders user and assistant bubbles on their real row sides with device chips', () => {
    const items: TimelineItem[] = [
      { kind: 'user', id: 'u-phone', text: 'from phone', ts: now, origin: 'phone' },
      { kind: 'user', id: 'u-terminal', text: 'from laptop', ts: now + 1, origin: 'terminal' },
      { kind: 'assistant', id: 'a1', text: 'assistant reply', ts: now + 2 },
    ];
    const { container } = render(<ChatThread items={items} />);

    expect(screen.getByText('from phone').closest('.row')).toHaveClass('user');
    expect(screen.getByText('from phone')).toHaveClass('bubble', 'user-bubble');
    expect(screen.getByText('This phone')).toHaveClass('device-chip', 'phone');
    expect(screen.getByText('from laptop').closest('.row')).toHaveClass('user');
    expect(screen.getByText('Laptop')).toHaveClass('device-chip', 'laptop');
    expect(screen.getByText('assistant reply').closest('.row')).toHaveClass('assistant', 'turn-start');
    expect(screen.getByText('assistant reply').closest('.bubble')).toHaveClass('assistant-bubble');
    expect(container.querySelector('.avatar.copilot')).toBeInTheDocument();
  });

  it('labels queued phone prompts', () => {
    render(
      <ChatThread
        items={[
          {
            kind: 'user',
            id: 'u-queued',
            text: 'run the integration tests next',
            ts: now,
            origin: 'phone',
            delivery: 'enqueue',
          },
        ]}
      />,
    );

    expect(screen.getByText('Queued')).toHaveClass('user-queued');
  });

  it('ignores deprecated paginated history props', () => {
    const { container } = render(
      <ChatThread
        items={[{ kind: 'assistant', id: 'live', text: 'live answer', ts: now + 3 }]}
        history={[
          { turnIndex: 1, role: 'user', text: 'old question', ts: now },
          { turnIndex: 1, role: 'assistant', text: 'old answer', ts: now + 1 },
        ]}
      />,
    );

    expect(screen.queryByText('old question')).not.toBeInTheDocument();
    expect(screen.queryByText('old answer')).not.toBeInTheDocument();
    expect(container.querySelector('.history-divider')).not.toBeInTheDocument();
    expect(container.querySelector('.thread-load-earlier')).not.toBeInTheDocument();
    expect(screen.getByText('live answer')).toBeInTheDocument();
  });

  it('renders a tool card and expands details on click', async () => {
    const user = userEvent.setup();
    render(
      <ChatThread
        items={[
          {
            kind: 'tool',
            id: 'tool-1',
            name: 'powershell',
            args: { command: 'npm test' },
            status: 'success',
            resultPreview: 'passed',
            startedAt: now,
            finishedAt: now + 42,
            ts: now,
          },
        ]}
      />,
    );

    const toolButton = screen.getByRole('button', { name: /Runnpm test42ms/i });
    expect(toolButton.closest('.tool-card')).toHaveClass('success');
    expect(toolButton).toHaveAttribute('aria-expanded', 'false');

    await user.click(toolButton);
    expect(toolButton).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('ARGUMENTS')).toBeInTheDocument();
    expect(screen.getByText('RESULT')).toBeInTheDocument();
    expect(screen.getByText(/"command": "npm test"/)).toBeInTheDocument();
    expect(screen.getByText('passed')).toBeInTheDocument();
  });

  it('renders attached images for user items', () => {
    render(
      <ChatThread
        items={[
          {
            kind: 'user',
            id: 'u-img',
            text: '',
            ts: now,
            attachments: [{ data: 'aW1n', mimeType: 'image/jpeg', name: 'screenshot.jpg' }],
          },
        ]}
      />,
    );

    const img = screen.getByRole('img', { name: 'screenshot.jpg' });
    expect(img).toHaveClass('msg-attachment');
    expect(img).toHaveAttribute('src', 'data:image/jpeg;base64,aW1n');
    expect(screen.queryByText('screenshot.jpg')).not.toBeInTheDocument();
  });

  it('does not render an empty user bubble when attachments are absent', () => {
    const { container } = render(<ChatThread items={[{ kind: 'user', id: 'u-empty', text: '', ts: now }]} />);

    expect(container.querySelector('.row.user')).toBeInTheDocument();
    expect(container.querySelector('.user-bubble')).not.toBeInTheDocument();
  });

  it('does not show the working row for a failed latest send', () => {
    render(
      <ChatThread
        streaming
        busy
        items={[{ kind: 'user', id: 'u-failed', text: 'send me', ts: now, failed: true }]}
      />,
    );

    expect(screen.getByText('Not delivered')).toBeInTheDocument();
    expect(screen.queryByText('working…')).not.toBeInTheDocument();
  });

  it('shows the working row for a trailing running tool even before busy arrives', () => {
    render(
      <ChatThread
        streaming
        items={[
          {
            kind: 'tool',
            id: 'tool-running',
            name: 'powershell',
            args: { command: 'npm test' },
            status: 'running',
            startedAt: now,
            ts: now,
          },
        ]}
      />,
    );

    expect(screen.getByText('working…')).toBeInTheDocument();
  });

  it('only shows the assistant caret while the agent is busy', () => {
    const { container, rerender } = render(
      <ChatThread streaming items={[{ kind: 'assistant', id: 'a1', text: 'reply', ts: now }]} />,
    );

    expect(container.querySelector('.caret')).not.toBeInTheDocument();

    rerender(<ChatThread streaming busy items={[{ kind: 'assistant', id: 'a1', text: 'reply', ts: now }]} />);

    expect(container.querySelector('.caret')).toBeInTheDocument();
  });

  it('does not render empty assistant rows between tool cards', () => {
    const items: TimelineItem[] = [
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'powershell',
        args: { command: 'npm test' },
        status: 'success',
        startedAt: now,
        finishedAt: now + 1,
        ts: now,
      },
      { kind: 'assistant', id: 'empty-assistant', text: '  \n', ts: now + 1 },
      {
        kind: 'tool',
        id: 'tool-2',
        name: 'view',
        args: { path: 'src/app.tsx' },
        status: 'success',
        startedAt: now + 2,
        finishedAt: now + 3,
        ts: now + 2,
      },
    ];
    const { container } = render(<ChatThread items={items} />);

    expect(container.querySelectorAll('.row.tool')).toHaveLength(2);
    expect(container.querySelector('.row.assistant')).not.toBeInTheDocument();
  });

  it('only marks the first assistant-side row after a user prompt as a turn start', () => {
    const items: TimelineItem[] = [
      { kind: 'user', id: 'u1', text: 'make edits', ts: now },
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'edit',
        args: { path: 'src/app.tsx', old_string: 'old', new_string: 'new' },
        status: 'success',
        startedAt: now + 1,
        finishedAt: now + 2,
        ts: now + 1,
      },
      {
        kind: 'tool',
        id: 'tool-2',
        name: 'view',
        args: { path: 'src/app.tsx' },
        status: 'success',
        startedAt: now + 3,
        finishedAt: now + 4,
        ts: now + 3,
      },
      { kind: 'assistant', id: 'a1', text: 'done', ts: now + 5 },
    ];
    const { container } = render(<ChatThread items={items} />);

    const toolRows = container.querySelectorAll('.row.tool');
    expect(toolRows[0]).toHaveClass('turn-start');
    expect(toolRows[1]).not.toHaveClass('turn-start');
    expect(screen.getByText('done').closest('.row')).not.toHaveClass('turn-start');
  });

  it('marks a user row that directly follows a rendered tool card', () => {
    const items: TimelineItem[] = [
      {
        kind: 'tool',
        id: 'tool-1',
        name: 'powershell',
        args: { command: 'npm test' },
        status: 'success',
        startedAt: now,
        finishedAt: now + 1,
        ts: now,
      },
      { kind: 'assistant', id: 'empty-assistant', text: '', ts: now + 1 },
      { kind: 'user', id: 'u-next', text: 'next prompt', ts: now + 2 },
    ];

    render(<ChatThread items={items} />);

    expect(screen.getByText('next prompt').closest('.row')).toHaveClass('user', 'after-tool');
  });

  it('renders the jump-to-latest control as an icon-only button', async () => {
    const { container } = render(
      <div className="thread-scroll">
        <ChatThread items={[{ kind: 'assistant', id: 'a1', text: 'reply', ts: now }]} />
      </div>,
    );
    const scroller = container.querySelector('.thread-scroll') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 100 });

    await settleThread();
    fireEvent.scroll(scroller);

    const button = screen.getByRole('button', { name: 'Scroll to latest' });
    expect(button).toHaveTextContent('');
    expect(button.querySelector('svg')).toBeInTheDocument();
    expect(button.querySelector('span')).not.toBeInTheDocument();
  });

  describe('keeping the newest messages visible when the viewport shrinks', () => {
    function mountInScroller(): { scroller: HTMLElement; scrollIntoView: ReturnType<typeof vi.fn> } {
      const scrollIntoView = vi.fn();
      Element.prototype.scrollIntoView = scrollIntoView as never;
      const { container } = render(
        <div className="thread-scroll">
          <ChatThread items={[{ kind: 'assistant', id: 'a1', text: 'reply', ts: now }]} />
        </div>,
      );
      const scroller = container.querySelector('.thread-scroll') as HTMLElement;
      scrollIntoView.mockClear();
      return { scroller, scrollIntoView };
    }

    it('scrolls back to the end when the soft keyboard shrinks the viewport', () => {
      // The keyboard shrinks the layout viewport without changing scrollTop, so the last messages
      // drop below the fold and nothing brings them back — the item list has not changed.
      const { scrollIntoView } = mountInScroller();

      fireEvent(window, new Event('resize'));

      expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' });
    });

    it('leaves a reader who scrolled up alone', async () => {
      const { scroller, scrollIntoView } = mountInScroller();
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 100 });
      await settleThread();
      fireEvent.scroll(scroller);
      scrollIntoView.mockClear();

      fireEvent(window, new Event('resize'));

      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it('opens at the newest message without animating, and offers no jump-to-latest on arrival', async () => {
      // The thread is mid-history and "unpinned" by the numbers, but it has only just opened — the
      // reader has not gone anywhere, history simply landed above them.
      const { scroller, scrollIntoView } = mountInScroller();
      Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
      Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 100 });

      fireEvent.scroll(scroller);

      expect(screen.queryByRole('button', { name: 'Scroll to latest' })).not.toBeInTheDocument();
      for (const call of scrollIntoView.mock.calls) {
        expect(call[0]).toMatchObject({ behavior: 'auto' });
      }
    });
  });
});

describe('Copying a message respects what you highlighted', () => {
  const items: TimelineItem[] = [
    { kind: 'assistant', id: 'a1', text: 'the quick brown fox jumps', ts: now },
  ];

  /** Highlight a slice of the bubble the way a long-press drag would. */
  function highlight(node: Node, start: number, end: number): void {
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }

  function stubClipboard(): { writeText: ReturnType<typeof vi.fn> } {
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
    return clipboard;
  }

  it('copies only the highlighted part instead of the whole message', () => {
    const clipboard = stubClipboard();
    render(<ChatThread items={items} />);
    const bubble = screen.getByText('the quick brown fox jumps');

    highlight(bubble.firstChild as Node, 4, 15);
    fireEvent.contextMenu(bubble);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy selection' }));
    expect(clipboard.writeText).toHaveBeenCalledWith('quick brown');
  });

  it('falls back to the whole message when nothing is highlighted', () => {
    const clipboard = stubClipboard();
    render(<ChatThread items={items} />);
    const bubble = screen.getByText('the quick brown fox jumps');

    window.getSelection()?.removeAllRanges();
    fireEvent.contextMenu(bubble);

    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy message' }));
    expect(clipboard.writeText).toHaveBeenCalledWith('the quick brown fox jumps');
  });

  it('leaves an in-progress selection alone rather than popping the menu over it', () => {
    vi.useFakeTimers();
    try {
      render(<ChatThread items={items} />);
      const bubble = screen.getByText('the quick brown fox jumps');
      highlight(bubble.firstChild as Node, 4, 15);

      // A second touch here is the user nudging a selection handle, not asking for a menu.
      fireEvent.touchStart(bubble, { touches: [{ clientX: 10, clientY: 10 }] });
      act(() => {
        vi.advanceTimersByTime(1000);
      });

      expect(screen.queryByRole('menu')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('The working row says what the agent is doing', () => {
  it('shows the agent note in place of the generic label, and falls back without one', () => {
    const items: TimelineItem[] = [{ kind: 'user', id: 'u1', text: 'go', ts: now, origin: 'phone' }];
    const { rerender } = render(<ChatThread items={items} streaming busy />);
    expect(screen.getByText('working…')).toBeInTheDocument();

    rerender(<ChatThread items={items} streaming busy intent="reading the relay config" />);
    expect(screen.getByText('reading the relay config')).toBeInTheDocument();
    expect(screen.queryByText('working…')).toBeNull();
  });

  it('counts thinking seconds locally, and yields to a real note when one arrives', () => {
    const items: TimelineItem[] = [{ kind: 'user', id: 'u1', text: 'go', ts: now, origin: 'phone' }];
    const start = 1_700_000_000_000;
    vi.useFakeTimers();
    vi.setSystemTime(start);
    try {
      const { rerender } = render(<ChatThread items={items} streaming busy thinkingSince={start} />);
      expect(screen.getByText('Thinking… 0s')).toBeInTheDocument();

      // The laptop sends no ticks: the phone counts on its own clock, so the label moves even
      // though nothing at all arrived over the wire.
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(screen.getByText('Thinking… 3s')).toBeInTheDocument();

      // A note the agent actually wrote beats a bare timer.
      rerender(<ChatThread items={items} streaming busy thinkingSince={start} intent="reading the relay config" />);
      expect(screen.getByText('reading the relay config')).toBeInTheDocument();

      // Thinking ends, nothing else known: back to the generic label rather than a frozen count.
      rerender(<ChatThread items={items} streaming busy />);
      expect(screen.getByText('working…')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

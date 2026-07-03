import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChatThread } from '@/ui/thread/ChatThread';
import type { TimelineItem } from '@/lib/timeline';

const now = Date.UTC(2026, 6, 1, 12, 0);

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

  it('renders the jump-to-latest control as an icon-only button', () => {
    const { container } = render(
      <div className="thread-scroll">
        <ChatThread items={[{ kind: 'assistant', id: 'a1', text: 'reply', ts: now }]} />
      </div>,
    );
    const scroller = container.querySelector('.thread-scroll') as HTMLElement;
    Object.defineProperty(scroller, 'scrollHeight', { configurable: true, value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 400 });
    Object.defineProperty(scroller, 'scrollTop', { configurable: true, value: 100 });

    fireEvent.scroll(scroller);

    const button = screen.getByRole('button', { name: 'Scroll to latest' });
    expect(button).toHaveTextContent('');
    expect(button.querySelector('svg')).toBeInTheDocument();
    expect(button.querySelector('span')).not.toBeInTheDocument();
  });
});

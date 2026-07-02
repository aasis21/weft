import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ChatThread } from '@/ui/thread/ChatThread';
import type { TimelineItem } from '@/lib/timeline';
import * as B from '@/test/helpers/builders';

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

  it('renders backfilled history above an Earlier divider', () => {
    render(
      <ChatThread
        items={[{ kind: 'assistant', id: 'live', text: 'live answer', ts: now + 3 }]}
        history={[
          B.historyItem(1, 'user', 'old question', now),
          B.historyItem(1, 'assistant', 'old answer', now + 1),
        ]}
      />,
    );

    expect(screen.getByText('old question').closest('.row')).toHaveClass('history', 'user');
    expect(screen.getByText('old answer').closest('.row')).toHaveClass('history', 'assistant');
    expect(screen.getByRole('separator')).toHaveTextContent('Earlier in this session');
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
});

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatThread } from '@/ui/thread/ChatThread';
import type { TimelineItem } from '@/lib/timeline';

const now = Date.UTC(2026, 6, 1, 12, 0);

describe('ChatThread polish', () => {
  it('shows sender, device and time above the message and delivery status below', () => {
    const items: TimelineItem[] = [{ kind: 'user', id: 'u1', text: 'hello', ts: now, origin: 'terminal', failed: true }];
    const { container } = render(<ChatThread items={items} onRetry={() => {}} />);

    const row = container.querySelector('.row.user');
    const parts = Array.from(row?.children ?? []).map((child) => child.className);
    expect(parts).toEqual(['user-meta', 'bubble user-bubble', 'user-status']);
    const meta = row?.querySelector('.user-meta');
    expect(meta).toHaveTextContent(/^You.*Laptop.*\d{1,2}:\d{2}\s[AP]M$/);
    expect(screen.getByText('Laptop')).toHaveClass('device-chip', 'laptop');
    const status = row?.querySelector('.user-status');
    expect(status).toContainElement(screen.getByText('Not delivered'));
    expect(status).toContainElement(screen.getByRole('button', { name: 'Retry sending message' }));
  });

  it('puts metadata above attachment-only messages and omits an empty status row', () => {
    const items: TimelineItem[] = [
      { kind: 'user', id: 'u2', text: '', ts: now, origin: 'phone', attachments: [{ name: 'a.png', mimeType: 'image/png', data: 'AA==' }] },
    ] as TimelineItem[];
    const { container } = render(<ChatThread items={items} />);

    const parts = Array.from(container.querySelector('.row.user')?.children ?? []).map((child) => child.className);
    expect(parts).toEqual(['user-meta', 'msg-attachments']);
  });

  it('renders the decorative empty icon inside the styled empty-icon container', () => {
    const { container } = render(<ChatThread items={[]} />);

    const icon = container.querySelector('.thread-empty-rich .empty-icon');
    expect(icon).toBeInTheDocument();
    expect(icon?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

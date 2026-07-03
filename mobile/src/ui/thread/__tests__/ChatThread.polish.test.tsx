import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChatThread } from '@/ui/thread/ChatThread';
import type { TimelineItem } from '@/lib/timeline';

const now = Date.UTC(2026, 6, 1, 12, 0);

describe('ChatThread polish', () => {
  it('keeps user timestamp and device chip in one metadata row', () => {
    const items: TimelineItem[] = [{ kind: 'user', id: 'u1', text: 'hello', ts: now, origin: 'terminal', failed: true }];
    const { container } = render(<ChatThread items={items} />);

    const meta = container.querySelector('.row.user .user-meta');
    expect(meta).toBeInTheDocument();
    expect(meta?.querySelector('.user-ts')).toHaveTextContent(/\d{1,2}:\d{2}\s[AP]M/);
    expect(meta).toContainElement(screen.getByText('Laptop'));
    expect(meta).toContainElement(screen.getByText('Not delivered'));
    expect(screen.getByText('Laptop')).toHaveClass('device-chip', 'laptop');
  });

  it('renders the decorative empty icon inside the styled empty-icon container', () => {
    const { container } = render(<ChatThread items={[]} />);

    const icon = container.querySelector('.thread-empty-rich .empty-icon');
    expect(icon).toBeInTheDocument();
    expect(icon?.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });
});

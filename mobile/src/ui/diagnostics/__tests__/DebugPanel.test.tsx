import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { DebugPanel } from '@/ui/diagnostics/DebugPanel';
import type { DebugEvent } from '@/lib/eventLog';

function ev(
  partial: Partial<DebugEvent> & Pick<DebugEvent, 'id' | 'dir' | 'eventType' | 'eventSubtype'>,
): DebugEvent {
  return {
    senderName: partial.dir === 'in' ? 'Copilot' : 'WebApp',
    ts: 1000,
    msg: {},
    ...partial,
  };
}

describe('DebugPanel', () => {
  it('shows the empty state and a zero count when there are no events', () => {
    const { container } = render(<DebugPanel events={[]} title="Refactor auth" onClose={vi.fn()} />);

    expect(screen.getByText('No events captured yet.')).toBeInTheDocument();
    expect(container.querySelector('.debug-sub')?.textContent).toBe('Refactor auth · 0 events');
    expect(container.querySelector('.debug-list')).not.toBeInTheDocument();
  });

  it('renders each event as a scrollable list row, newest-first', () => {
    const events = [
      ev({ id: 'a', dir: 'out', eventType: 'control', eventSubtype: 'state_request', ts: 100 }),
      ev({ id: 'b', dir: 'in', eventType: 'stream', eventSubtype: 'assistant_delta', ts: 200 }),
    ];
    const { container } = render(<DebugPanel events={events} title="t" onClose={vi.fn()} />);

    // The list is an <ol.debug-list> and each event is one <li.debug-row> (the scroll container).
    const list = container.querySelector('ol.debug-list');
    expect(list).toBeInTheDocument();
    const rows = container.querySelectorAll('.debug-row');
    expect(rows).toHaveLength(2);
    // Newest (b) first.
    expect(rows[0]?.textContent).toContain('stream.assistant_delta');
    expect(rows[1]?.textContent).toContain('control.state_request');
    expect(container.querySelector('.debug-sub')?.textContent).toBe('t · 2 events');
  });

  it('attributes direction and sender per row', () => {
    const events = [
      ev({ id: 'out1', dir: 'out', eventType: 'prompt', eventSubtype: 'prompt' }),
      ev({ id: 'in1', dir: 'in', eventType: 'control', eventSubtype: 'channel_up' }),
    ];
    const { container } = render(<DebugPanel events={events} title="t" onClose={vi.fn()} />);
    const rows = container.querySelectorAll('.debug-row');

    // rows[0] is newest = the inbound one.
    expect(rows[0]).toHaveClass('in');
    expect(rows[0]?.querySelector('.debug-dir.in')?.textContent).toBe('↓');
    expect(rows[0]?.textContent).toContain('Copilot');

    expect(rows[1]).toHaveClass('out');
    expect(rows[1]?.querySelector('.debug-dir.out')?.textContent).toBe('↑');
    expect(rows[1]?.textContent).toContain('WebApp');
  });

  it('expands and collapses a row to reveal its payload', async () => {
    const user = userEvent.setup();
    const events = [ev({ id: 'p', dir: 'out', eventType: 'prompt', eventSubtype: 'prompt', msg: { text: 'hello there' } })];
    const { container } = render(<DebugPanel events={events} title="t" onClose={vi.fn()} />);

    // Collapsed by default: no payload <pre>.
    expect(container.querySelector('.debug-msg')).not.toBeInTheDocument();
    const rowHead = screen.getByRole('button', { expanded: false });

    await user.click(rowHead);
    expect(screen.getByRole('button', { expanded: true })).toBeInTheDocument();
    expect(container.querySelector('.debug-msg')?.textContent).toContain('hello there');

    await user.click(rowHead);
    expect(container.querySelector('.debug-msg')).not.toBeInTheDocument();
  });

  it('calls onClose from the header close button', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DebugPanel events={[]} title="t" onClose={onClose} />);

    await user.click(screen.getByRole('button', { name: 'Close debug events' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes on Escape and focuses the close button on open', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<DebugPanel events={[]} title="t" onClose={onClose} />);

    expect(screen.getByRole('button', { name: 'Close debug events' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows a Dev detail tab with session identity + channel history when detail is provided (#154)', async () => {
    const user = userEvent.setup();
    render(
      <DebugPanel
        events={[]}
        title="t"
        onClose={vi.fn()}
        detail={{
          sessionId: 'sess-123',
          channelId: 'chan-current',
          channelHistory: [
            { channelId: 'chan-old-1', startedAt: 1 },
            { channelId: 'chan-old-2', startedAt: 2 },
          ],
          senderId: 'phone-abc',
          addedAt: 1_700_000_000_000,
          lastHeartbeat: 1_700_000_100_000,
          lastEventAt: 1_700_000_090_000,
          status: 'live',
          mode: 'default',
        }}
      />,
    );

    // Tabs render; switching to Dev detail shows identity facts.
    await user.click(screen.getByRole('tab', { name: 'Dev detail' }));
    expect(screen.getByText('sess-123')).toBeInTheDocument();
    expect(screen.getByText('chan-current')).toBeInTheDocument();
    expect(screen.getByText('chan-old-1, chan-old-2')).toBeInTheDocument();
    expect(screen.getByText('phone-abc')).toBeInTheDocument();
  });

  it('does not render tabs when no detail is provided (event log only)', () => {
    render(<DebugPanel events={[]} title="t" onClose={vi.fn()} />);
    expect(screen.queryByRole('tab', { name: 'Dev detail' })).not.toBeInTheDocument();
  });
});

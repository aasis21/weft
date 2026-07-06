import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElicitationRequestMsg } from '@aasis21/weft-shared';
import { ElicitationCard } from '@/ui/prompts/ElicitationCard';

describe('ElicitationCard multiselect accessibility', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('uses the visible field label as the checkbox group accessible name', () => {
    const req = {
      requestId: 'req-1',
      message: 'Choose tools',
      mode: 'form',
      requestedSchema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            title: 'Allowed tools',
            items: { type: 'string', enum: ['read', 'write'], enumNames: ['Read', 'Write'] },
          },
        },
      },
    } as ElicitationRequestMsg;

    render(<ElicitationCard req={req} onSubmit={vi.fn()} onDecline={vi.fn()} onCancel={vi.fn()} />);

    const label = screen.getByText('Allowed tools');
    const group = screen.getByRole('group', { name: 'Allowed tools' });
    expect(label).toHaveAttribute('id', 'elicit-req-1-tools');
    expect(label).not.toHaveAttribute('for');
    expect(group).toHaveAttribute('aria-labelledby', 'elicit-req-1-tools');
  });

  it('restores wizard answers and current step after remounting the same request', async () => {
    const user = userEvent.setup();
    const req = {
      requestId: 'req-persist',
      message: 'Fill this out',
      mode: 'form',
      requestedSchema: {
        type: 'object',
        required: ['project', 'reason'],
        properties: {
          project: { type: 'string', title: 'Project' },
          reason: { type: 'string', title: 'Reason' },
        },
      },
    } as ElicitationRequestMsg;

    const first = render(<ElicitationCard req={req} onSubmit={vi.fn()} onDecline={vi.fn()} onCancel={vi.fn()} />);
    await user.type(screen.getByRole('textbox', { name: /Project/ }), 'weft');
    await user.click(screen.getByRole('button', { name: 'Next →' }));
    await user.type(screen.getByRole('textbox', { name: /Reason/ }), 'reconnect');
    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument();

    first.unmount();
    render(<ElicitationCard req={req} onSubmit={vi.fn()} onDecline={vi.fn()} onCancel={vi.fn()} />);

    expect(screen.getByText('Question 2 of 2')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Reason/ })).toHaveValue('reconnect');
    await user.click(screen.getByRole('button', { name: '← Back' }));
    expect(screen.getByRole('textbox', { name: /Project/ })).toHaveValue('weft');
  });
});

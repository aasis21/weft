import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ElicitationRequestMsg } from '@aasis21/helm-shared';
import { ElicitationCard } from '@/ui/prompts/ElicitationCard';

describe('ElicitationCard multiselect accessibility', () => {
  it('uses the visible field label as the checkbox group accessible name', () => {
    const req = {
      requestId: 'req-1',
      message: 'Choose tools',
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
    expect(label.id).toBeTruthy();
    expect(group).toHaveAttribute('aria-labelledby', label.id);
  });
});

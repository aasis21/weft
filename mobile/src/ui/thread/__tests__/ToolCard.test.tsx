import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToolCard } from '@/ui/thread/ToolCard';

describe('ToolCard', () => {
  it('renders edit tool arguments as a colored unified diff', async () => {
    const user = userEvent.setup();

    render(
      <ToolCard
        item={{
          kind: 'tool',
          id: 'edit-1',
          name: 'edit',
          args: {
            path: 'src/app.tsx',
            old_string: 'const label = "old";\nrender(label);',
            new_string: 'const label = "new";\nrender(label);',
          },
          status: 'success',
          startedAt: 1,
          finishedAt: 2,
          ts: 1,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Editsrc\/app\.tsx1ms/i }));

    expect(screen.getByText('DIFF')).toBeInTheDocument();
    expect(screen.getByText('src/app.tsx')).toHaveClass('tc-diff-file');
    expect(screen.getByText('-const label = "old";')).toHaveClass('tc-diff-line', 'removed');
    expect(screen.getByText('+const label = "new";')).toHaveClass('tc-diff-line', 'added');
    expect(screen.queryByText('ARGUMENTS')).not.toBeInTheDocument();
  });
});

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ToolCard } from '@/ui/thread/ToolCard';

describe('ToolCard', () => {
  it('renders shell input, output, and completion status as separate surfaces', async () => {
    const user = userEvent.setup();

    render(
      <ToolCard
        item={{
          kind: 'tool',
          id: 'shell-1',
          name: 'powershell',
          args: {
            command: 'git -C "C:\\repos\\weft" status --short',
            description: 'Check working tree',
            initial_wait: 120,
            mode: 'sync',
          },
          status: 'success',
          resultPreview: ' M mobile/src/App.tsx\n<shellId: 7 completed with exit code 0>',
          startedAt: 1,
          finishedAt: 2001,
          ts: 1,
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: /RunCheck working tree2\.0s/i }));

    expect(screen.getByText('INPUT')).toBeInTheDocument();
    expect(screen.getByText('OUTPUT')).toBeInTheDocument();
    expect(screen.getByText('git -C "C:\\repos\\weft" status --short')).toHaveClass('tc-command');
    expect(screen.getByText('M mobile/src/App.tsx')).toHaveClass('tc-output');
    expect(screen.getByText('Exit 0')).toBeInTheDocument();
    expect(screen.getByText('shell 7')).toBeInTheDocument();
    expect(screen.getByText('sync')).toBeInTheDocument();
    expect(screen.getByText('wait up to 120s')).toBeInTheDocument();
    expect(screen.getByText(/"command":/)).not.toBeVisible();

    await user.click(screen.getByText('View raw arguments'));
    expect(screen.getByText(/"command":/)).toBeVisible();
  });

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

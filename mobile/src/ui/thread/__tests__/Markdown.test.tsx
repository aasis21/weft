import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Markdown } from '@/ui/thread/Markdown';

describe('Markdown', () => {
  it('preserves ordered-list numbering when paragraphs split items into separate lists', () => {
    render(
      <Markdown
        text={[
          '1. First finding',
          '',
          'Details about the first finding.',
          '',
          '2. Second finding',
          '',
          'Details about the second finding.',
          '',
          '3. Third finding',
        ].join('\n')}
      />,
    );

    const lists = screen.getAllByRole('list');
    expect(lists).toHaveLength(3);
    expect(lists[0]).toHaveAttribute('start', '1');
    expect(lists[1]).toHaveAttribute('start', '2');
    expect(lists[2]).toHaveAttribute('start', '3');
  });

  it('preserves the starting marker for a contiguous ordered list', () => {
    render(<Markdown text={'4. Fourth\n5. Fifth'} />);

    expect(screen.getByRole('list')).toHaveAttribute('start', '4');
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
  });
});

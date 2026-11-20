import { describe, expect, it } from 'vitest';
import { act, render, waitFor } from '@testing-library/react';
import { useState } from 'react';
import type { JSX } from 'react';
import { useBackHandler } from '@/ui/gestures/backNavigation';

let openSheet: (open: boolean) => void = () => {};

function Sheet(): JSX.Element {
  const [open, setOpen] = useState(false);
  openSheet = setOpen;
  useBackHandler(open, () => setOpen(false));
  return <div data-testid="sheet">{open ? 'open' : 'closed'}</div>;
}

describe('useBackHandler', () => {
  it('closes the open layer on system Back and keeps the underlying state', async () => {
    window.history.replaceState({ screen: 'devices' }, '');
    const view = render(<Sheet />);
    act(() => openSheet(true));
    expect(window.history.state).toMatchObject({ screen: 'devices' });
    expect(window.history.state.weftLayer).toBeDefined();

    act(() => window.history.back());
    await waitFor(() => expect(view.getByTestId('sheet').textContent).toBe('closed'));
    expect(window.history.state).toEqual({ screen: 'devices' });
    view.unmount();
  });

  it('removes its history entry when the layer is closed by a tap', async () => {
    window.history.replaceState({ screen: 'devices' }, '');
    const view = render(<Sheet />);
    act(() => openSheet(true));
    act(() => openSheet(false));
    await waitFor(() => expect(window.history.state).toEqual({ screen: 'devices' }));
    expect(view.getByTestId('sheet').textContent).toBe('closed');
    view.unmount();
  });
});

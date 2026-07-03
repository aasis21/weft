import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { JoinSessionScreen } from '../../screens/JoinSessionScreen';

const scannerState = vi.hoisted(() => ({ mounts: 0 }));

vi.mock('@/ui/pairing/WebQrScanner', async () => {
  const React = await import('react');
  return {
    WebQrScanner({ onResult }: { onResult(raw: string): void }) {
      React.useEffect(() => {
        scannerState.mounts += 1;
        if (scannerState.mounts <= 2) onResult(`raw-${scannerState.mounts}`);
      }, [onResult]);
      return React.createElement('div', null, 'scanner');
    },
  };
});

describe('JoinSessionScreen', () => {
  it('re-arms the inline scanner only after a failed pairing task settles', async () => {
    scannerState.mounts = 0;
    const onPair = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('first failed'))
      .mockResolvedValueOnce(undefined);

    render(
      <JoinSessionScreen
        hasSessions={false}
        error={null}
        onError={() => undefined}
        onPair={onPair}
        onStartDemo={() => Promise.resolve()}
      />,
    );

    await waitFor(() => expect(onPair).toHaveBeenCalledTimes(2));
    expect(onPair).toHaveBeenNthCalledWith(1, 'raw-1');
    expect(onPair).toHaveBeenNthCalledWith(2, 'raw-2');
  });
});

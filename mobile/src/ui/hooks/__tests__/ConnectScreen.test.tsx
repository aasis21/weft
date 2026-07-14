import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConnectScreen } from '../../screens/ConnectScreen';

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

describe('ConnectScreen', () => {
  it('re-arms the inline scanner only after a failed pairing task settles', async () => {
    scannerState.mounts = 0;
    let rejectFirst: (error: Error) => void = () => undefined;
    const firstPair = new Promise<void>((_, reject) => {
      rejectFirst = reject;
    });
    const onPair = vi.fn<() => Promise<void>>().mockReturnValueOnce(firstPair).mockResolvedValueOnce(undefined);

    render(
      <ConnectScreen
        hasSessions={false}
        error={null}
        onError={() => undefined}
        onPair={onPair}
      />,
    );

    await waitFor(() => expect(onPair).toHaveBeenCalledTimes(1));
    expect(scannerState.mounts).toBe(1);
    rejectFirst(new Error('first failed'));
    await waitFor(() => expect(onPair).toHaveBeenCalledTimes(2));
    expect(onPair).toHaveBeenNthCalledWith(1, 'raw-1');
    expect(onPair).toHaveBeenNthCalledWith(2, 'raw-2');
  });
});

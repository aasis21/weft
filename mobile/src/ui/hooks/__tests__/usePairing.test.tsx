import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { pairingErrorMessage, usePairing } from '../usePairing';

function Harness({
  task,
  onError,
}: {
  task: () => Promise<void>;
  onError: (message: string | null) => void;
}): JSX.Element {
  const { run } = usePairing(onError);
  return (
    <button type="button" onClick={() => void run(task)}>
      Run
    </button>
  );
}

describe('usePairing', () => {
  it('maps known pairing failures to friendly messages', () => {
    expect(pairingErrorMessage(new SyntaxError('Unexpected token'))).toBe(
      "That doesn't look like a valid Weft pairing code — re-copy it from the terminal.",
    );
    expect(pairingErrorMessage(new Error('wrapped: weft/pairing: invalid pairing payload'))).toBe(
      "That doesn't look like a valid Weft pairing code — re-copy it from the terminal.",
    );
    expect(pairingErrorMessage(new Error('weft/pairing: no ack from laptop'))).toBe(
      "Couldn't reach your laptop — make sure the terminal shows the QR and try again.",
    );
  });

  it('maps invalid pasted pairing JSON to a friendly error', async () => {
    const onError = vi.fn();
    render(<Harness task={() => Promise.reject(new SyntaxError('Expected property name'))} onError={onError} />);

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() =>
      expect(onError).toHaveBeenLastCalledWith(
        "That doesn't look like a valid Weft pairing code — re-copy it from the terminal.",
      ),
    );
  });

  it('maps pairing validation and no-ack errors while preserving unknown messages', async () => {
    const cases = [
      {
        err: new Error('weft/pairing: invalid pairing payload'),
        message: "That doesn't look like a valid Weft pairing code — re-copy it from the terminal.",
      },
      {
        err: new Error('weft/pairing: no ack from laptop'),
        message: "Couldn't reach your laptop — make sure the terminal shows the QR and try again.",
      },
      {
        err: new Error('Something else failed.'),
        message: 'Something else failed.',
      },
    ];

    for (const { err, message } of cases) {
      const onError = vi.fn();
      render(<Harness task={() => Promise.reject(err)} onError={onError} />);

      fireEvent.click(screen.getAllByRole('button', { name: 'Run' }).at(-1)!);

      await waitFor(() => expect(onError).toHaveBeenLastCalledWith(message));
    }
  });
});

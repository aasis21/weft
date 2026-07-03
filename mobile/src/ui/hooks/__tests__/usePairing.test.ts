import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanNativeQr, usePairing } from '@/ui/hooks/usePairing';

const scannerMock = vi.hoisted(() => ({
  isSupported: vi.fn(),
  requestPermissions: vi.fn(),
  scan: vi.fn(),
}));

vi.mock('@capacitor-mlkit/barcode-scanning', () => ({
  BarcodeScanner: scannerMock,
}));

describe('usePairing', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('ignores re-entrant pairing tasks while one is already running', async () => {
    let finishFirst: (() => void) | undefined;
    const firstTask = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    );
    const secondTask = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    const { result } = renderHook(() => usePairing(onError));

    let firstRun: Promise<void> | undefined;
    act(() => {
      firstRun = result.current.run(firstTask);
    });
    await waitFor(() => expect(result.current.busy).toBe(true));

    await act(async () => {
      await result.current.run(secondTask);
    });

    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(secondTask).not.toHaveBeenCalled();
    expect(result.current.busy).toBe(true);

    await act(async () => {
      finishFirst?.();
      await firstRun;
    });

    expect(result.current.busy).toBe(false);
  });
});

describe('scanNativeQr', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('times out if the native scanner never settles', async () => {
    vi.useFakeTimers();
    scannerMock.isSupported.mockResolvedValue({ supported: true });
    scannerMock.requestPermissions.mockResolvedValue(undefined);
    scannerMock.scan.mockReturnValue(new Promise(() => undefined));

    const scan = scanNativeQr();
    const rejection = expect(scan).rejects.toThrow('QR scan timed out. Try again.');
    await vi.advanceTimersByTimeAsync(60_000);

    await rejection;
  });

  it('rejects without scanning when camera permission is denied', async () => {
    scannerMock.isSupported.mockResolvedValue({ supported: true });
    scannerMock.requestPermissions.mockResolvedValue({ camera: 'denied' });

    await expect(scanNativeQr()).rejects.toThrow(/Camera permission is required/);
    expect(scannerMock.scan).not.toHaveBeenCalled();
  });

  it('scans when camera permission is granted', async () => {
    scannerMock.isSupported.mockResolvedValue({ supported: true });
    scannerMock.requestPermissions.mockResolvedValue({ camera: 'granted' });
    scannerMock.scan.mockResolvedValue({ barcodes: [{ rawValue: 'payload' }] });

    await expect(scanNativeQr()).resolves.toBe('payload');
  });
});

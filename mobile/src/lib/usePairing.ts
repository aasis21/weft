import { useCallback, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { describeError } from './debugSettings';

interface ScannerApi {
  isSupported?: () => Promise<{ supported: boolean }>;
  requestPermissions?: () => Promise<unknown>;
  scan: () => Promise<{ barcodes: Array<{ rawValue?: string; displayValue?: string }> }>;
}

/** True when running inside the native Capacitor shell (vs. the hosted web app). */
export const isNativeRuntime = (): boolean => Capacitor.isNativePlatform();

/**
 * Drive the native ML Kit barcode scanner (Android/iOS) and resolve with the raw QR
 * payload string — the same shape the in-browser scanner and paste box produce.
 */
export async function scanNativeQr(): Promise<string> {
  const module = await import('@capacitor-mlkit/barcode-scanning');
  const scanner = module.BarcodeScanner as unknown as ScannerApi;
  const support = await scanner.isSupported?.();
  if (support && !support.supported) {
    throw new Error('Barcode scanning is not supported on this device.');
  }
  await scanner.requestPermissions?.();
  const result = await scanner.scan();
  const raw = result.barcodes[0]?.rawValue ?? result.barcodes[0]?.displayValue;
  if (!raw) throw new Error('No QR payload detected.');
  return raw;
}

/**
 * Shared busy/error wrapper for pairing actions (scan, paste, demo). Keeps the Landing
 * and Join screens free of duplicated try/finally bookkeeping. Also captures a technical
 * detail string (raw cause chain + platform/transport context) for the debug-mode panel,
 * so a pairing failure remains diagnosable from the phone alone when a PC isn't handy.
 */
export function usePairing(onError: (message: string | null) => void): {
  busy: boolean;
  run: (task: () => Promise<void>) => Promise<void>;
  errorDetail: string | null;
} {
  const [busy, setBusy] = useState(false);
  const [errorDetail, setErrorDetail] = useState<string | null>(null);
  const run = useCallback(
    async (task: () => Promise<void>): Promise<void> => {
      setBusy(true);
      onError(null);
      setErrorDetail(null);
      try {
        await task();
      } catch (err) {
        onError(err instanceof Error ? err.message : 'Pairing failed.');
        setErrorDetail(describeError(err));
      } finally {
        setBusy(false);
      }
    },
    [onError],
  );
  return { busy, run, errorDetail };
}

import { useCallback, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { describeError } from '@/lib/debugSettings';

interface ScannerApi {
  isSupported?: () => Promise<{ supported: boolean }>;
  requestPermissions?: () => Promise<unknown>;
  scan: () => Promise<{ barcodes: Array<{ rawValue?: string; displayValue?: string }> }>;
}

const SCAN_TIMEOUT_MS = 60_000;
const SCAN_TIMEOUT_MESSAGE = 'QR scan timed out. Try again.';
const INVALID_PAIRING_CODE_MESSAGE =
  "That doesn't look like a valid Helm pairing code — re-copy it from the terminal.";
const NO_ACK_MESSAGE = "Couldn't reach your laptop — make sure the terminal shows the QR and try again.";

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timeoutId) clearTimeout(timeoutId);
  });
}

export function pairingErrorMessage(err: unknown): string {
  if (err instanceof SyntaxError) return INVALID_PAIRING_CODE_MESSAGE;
  if (err instanceof Error) {
    if (err.message.includes('helm/pairing: invalid pairing payload')) return INVALID_PAIRING_CODE_MESSAGE;
    if (err.message.includes('helm/pairing: no ack from laptop')) return NO_ACK_MESSAGE;
    return err.message;
  }
  return 'Pairing failed.';
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
  const result = await withTimeout(scanner.scan(), SCAN_TIMEOUT_MS, SCAN_TIMEOUT_MESSAGE);
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
  const busyRef = useRef(false);
  const run = useCallback(
    async (task: () => Promise<void>): Promise<void> => {
      if (busyRef.current) return;
      busyRef.current = true;
      setBusy(true);
      onError(null);
      setErrorDetail(null);
      try {
        await task();
      } catch (err) {
        onError(pairingErrorMessage(err));
        setErrorDetail(describeError(err));
      } finally {
        busyRef.current = false;
        setBusy(false);
      }
    },
    [onError],
  );
  return { busy, run, errorDetail };
}

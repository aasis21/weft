import { useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { Capacitor } from '@capacitor/core';
import { WebQrScanner } from './WebQrScanner';

interface PairingScreenProps {
  demoQr: string | null;
  error: string | null;
  onError(error: string | null): void;
  onPair(raw: string): Promise<void>;
  onStartDemo(): Promise<void>;
}

interface ScannerApi {
  isSupported?: () => Promise<{ supported: boolean }>;
  requestPermissions?: () => Promise<unknown>;
  scan: () => Promise<{ barcodes: Array<{ rawValue?: string; displayValue?: string }> }>;
}

export function PairingScreen({
  demoQr,
  error,
  onError,
  onPair,
  onStartDemo,
}: PairingScreenProps): JSX.Element {
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);

  const run = async (task: () => Promise<void>): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await task();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Pairing failed.');
    } finally {
      setBusy(false);
    }
  };

  const scanQr = async (): Promise<void> => {
    // Browsers can't use the native ML Kit scanner — open the in-page camera scanner instead.
    if (!Capacitor.isNativePlatform()) {
      onError(null);
      setScanning(true);
      return;
    }
    await run(async () => {
      const module = await import('@capacitor-mlkit/barcode-scanning');
      const scanner = module.BarcodeScanner as unknown as ScannerApi;
      const support = await scanner.isSupported?.();
      if (support && !support.supported) throw new Error('Barcode scanning is not supported on this device.');
      await scanner.requestPermissions?.();
      const result = await scanner.scan();
      const raw = result.barcodes[0]?.rawValue ?? result.barcodes[0]?.displayValue;
      if (!raw) throw new Error('No QR payload detected.');
      await onPair(raw);
    });
  };

  const handleScanResult = async (raw: string): Promise<void> => {
    setScanning(false);
    await run(async () => onPair(raw));
  };

  const pairManual = async (): Promise<void> => {
    await run(async () => onPair(manual));
  };

  const startDemo = async (): Promise<void> => {
    await run(onStartDemo);
  };

  return (
    <main className="pairing-shell">
      {scanning ? (
        <WebQrScanner onResult={handleScanResult} onCancel={() => setScanning(false)} />
      ) : null}
      <section className="brand-panel">
        <div className="brand-mark" aria-hidden="true">
          H
        </div>
        <p className="eyebrow">Encrypted Copilot second screen</p>
        <h1>Helm keeps your terminal session in your palm.</h1>
        <p className="lede">
          Scan the laptop QR to derive a phone-only ECDH session key. The relay only carries AES-GCM
          ciphertext.
        </p>
        <div className="signal-card">
          <span className="pulse-dot" />
          Android-first · React · Vite · Capacitor
        </div>
      </section>

      <section className="pair-card">
        <h2>Pair phone</h2>
        <button className="primary-action" type="button" disabled={busy} onClick={scanQr}>
          Scan QR
        </button>
        <label className="manual-label" htmlFor="manual-pairing">
          Manual QR JSON fallback
        </label>
        <textarea
          id="manual-pairing"
          value={manual}
          onChange={(event) => setManual(event.target.value)}
          placeholder='{"v":1,"channelId":"...","pub":"..."}'
        />
        <button className="secondary-action" type="button" disabled={busy || !manual.trim()} onClick={pairManual}>
          Pair from pasted JSON
        </button>
        <button className="demo-action" type="button" disabled={busy} onClick={startDemo}>
          Demo / Simulator
        </button>
        {demoQr ? (
          <div className="demo-qr">
            <QRCodeSVG value={demoQr} size={104} bgColor="transparent" fgColor="#d7ff73" />
            <span>Simulator laptop QR payload generated locally.</span>
          </div>
        ) : null}
        {error ? <p className="error-banner">{error}</p> : null}
      </section>
    </main>
  );
}

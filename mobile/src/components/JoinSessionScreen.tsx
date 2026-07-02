import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { WebQrScanner } from './WebQrScanner';
import { isNativeRuntime, scanNativeQr, usePairing } from '../lib/usePairing';
import { isDebugModeEnabled, setDebugModeEnabled } from '../lib/debugSettings';

interface JoinSessionScreenProps {
  /** Native first run: no prior sessions to go back to. */
  firstRun?: boolean;
  hasSessions: boolean;
  /** Open the manual paste box on mount (e.g. user tapped "Paste a pairing code"). */
  initialManual?: boolean;
  error: string | null;
  onError(error: string | null): void;
  onPair(raw: string): Promise<void>;
  onStartDemo(): Promise<void>;
  onCancel?: () => void;
}

export function JoinSessionScreen({
  firstRun = false,
  hasSessions,
  initialManual = false,
  error,
  onError,
  onPair,
  onStartDemo,
  onCancel,
}: JoinSessionScreenProps): JSX.Element {
  const native = isNativeRuntime();
  const { busy, run, errorDetail } = usePairing(onError);
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(initialManual);
  const [debugMode, setDebugMode] = useState(false);
  // Bumped after a failed pair so the inline web scanner remounts and resumes scanning.
  const [scanNonce, setScanNonce] = useState(0);
  const autoScanned = useRef(false);

  useEffect(() => {
    void isDebugModeEnabled().then(setDebugMode);
  }, []);

  const toggleDebugMode = (): void => {
    const next = !debugMode;
    setDebugMode(next);
    void setDebugModeEnabled(next);
  };

  const pair = (raw: string): Promise<void> =>
    run(async () => {
      try {
        await onPair(raw);
      } catch (err) {
        setScanNonce((n) => n + 1);
        throw err;
      }
    });

  const nativeScan = (): Promise<void> =>
    run(async () => {
      const raw = await scanNativeQr();
      await onPair(raw);
    });

  // On native there is no in-page camera, so open the ML Kit sheet once on mount.
  useEffect(() => {
    if (!native || autoScanned.current) return;
    autoScanned.current = true;
    void nativeScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const backLabel = hasSessions ? 'Back to sessions' : 'Back';

  return (
    <main className="join-shell">
      <header className="join-head">
        {onCancel && !firstRun ? (
          <button type="button" className="pair-back" onClick={onCancel}>
            ← {backLabel}
          </button>
        ) : null}
        <p className="eyebrow">{hasSessions ? 'Join another session' : 'Pair your phone'}</p>
        <h2>Point your camera at the laptop QR</h2>
        <p className="join-hint">
          Run <code>copilot</code> on your laptop, then frame the pairing QR it prints.
        </p>
      </header>

      <div className="join-scanner">
        {native ? (
          <div className="native-scan">
            <div className="scanner-reticle" aria-hidden="true">
              <span className="scanner-line" />
            </div>
            <button type="button" className="primary-action" disabled={busy} onClick={() => void nativeScan()}>
              {busy ? 'Scanning…' : 'Scan QR'}
            </button>
          </div>
        ) : (
          <WebQrScanner
            key={scanNonce}
            variant="inline"
            onResult={(raw) => void pair(raw)}
            onCancel={() => undefined}
          />
        )}
      </div>

      {error ? (
        <div className="error-banner-wrap">
          <p className="error-banner">{error}</p>
          {debugMode && errorDetail ? (
            <details className="error-debug-detail" open>
              <summary>Technical details</summary>
              <pre>{errorDetail}</pre>
            </details>
          ) : null}
        </div>
      ) : null}

      <div className="join-fallback">
        <button type="button" className="link-btn debug-toggle" onClick={toggleDebugMode}>
          Debug mode: {debugMode ? 'On' : 'Off'}
        </button>
        <button
          type="button"
          className="link-btn"
          aria-expanded={showManual}
          onClick={() => setShowManual((v) => !v)}
        >
          {showManual ? 'Hide manual entry' : 'Enter code manually'}
        </button>
        {showManual ? (
          <>
            <textarea
              aria-label="Manual pairing JSON"
              value={manual}
              onChange={(event) => setManual(event.target.value)}
              placeholder='{"v":1,"channelId":"...","pub":"..."}'
            />
            <button
              type="button"
              className="secondary-action"
              disabled={busy || !manual.trim()}
              onClick={() => void pair(manual)}
            >
              Pair from pasted code
            </button>
          </>
        ) : null}
        <button type="button" className="demo-action" disabled={busy} onClick={() => void run(onStartDemo)}>
          Demo / Simulator
        </button>
      </div>
    </main>
  );
}

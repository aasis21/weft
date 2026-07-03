import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { WebQrScanner } from '@/ui/pairing/WebQrScanner';
import { isNativeRuntime, scanNativeQr, usePairing } from '@/ui/hooks/usePairing';
import { isDebugModeEnabled, setDebugModeEnabled } from '@/lib/debugSettings';
import { runConnectivityProbe } from '@/lib/wsProbe';

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
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  // Bumped after a failed pair so the inline web scanner remounts and resumes scanning.
  const [scanNonce, setScanNonce] = useState(0);
  const autoScanned = useRef(false);

  useEffect(() => {
    void isDebugModeEnabled().then(setDebugMode);
  }, []);

  const runProbe = async (): Promise<void> => {
    setProbeRunning(true);
    setProbeResult(null);
    try {
      setProbeResult(await runConnectivityProbe());
    } finally {
      setProbeRunning(false);
    }
  };

  const toggleDebugMode = (): void => {
    const next = !debugMode;
    setDebugMode(next);
    void setDebugModeEnabled(next);
  };

  const pair = useCallback(
    async (raw: string): Promise<void> => {
      let failed = false;
      await run(async () => {
        try {
          await onPair(raw);
        } catch (err) {
          failed = true;
          throw err;
        }
      });
      if (failed) setScanNonce((n) => n + 1);
    },
    [onPair, run],
  );

  const nativeScan = useCallback(
    (): Promise<void> =>
      run(async () => {
        const raw = await scanNativeQr();
        await onPair(raw);
      }),
    [onPair, run],
  );

  const handleScannerResult = useCallback((raw: string): void => {
    void pair(raw);
  }, [pair]);

  // On native there is no in-page camera, so open the ML Kit sheet once on mount.
  useEffect(() => {
    if (!native || autoScanned.current) return;
    autoScanned.current = true;
    void nativeScan();
  }, [native, nativeScan]);

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
            onResult={handleScannerResult}
            onCancel={() => undefined}
            onPasteCode={() => setShowManual(true)}
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

      {debugMode ? (
        <div className="join-fallback">
          <button type="button" className="secondary-action" disabled={probeRunning} onClick={() => void runProbe()}>
            {probeRunning ? 'Testing connectivity…' : 'Run connectivity test'}
          </button>
          {probeResult ? (
            <details className="error-debug-detail" open>
              <summary>Connectivity test result</summary>
              <pre>{probeResult}</pre>
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

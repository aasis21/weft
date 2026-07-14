import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { WebQrScanner } from '@/ui/pairing/WebQrScanner';
import { isNativeRuntime, scanNativeQr, usePairing } from '@/ui/hooks/usePairing';
import { isDesktopInput } from '@/lib/platform';
import { isDebugModeEnabled, setDebugModeEnabled } from '@/lib/debugSettings';
import { runConnectivityProbe } from '@/lib/wsProbe';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';

interface ConnectScreenProps {
  /** Native first run: no prior sessions to go back to. */
  firstRun?: boolean;
  hasSessions: boolean;
  /** Open the manual paste box on mount (e.g. user tapped "Paste a pairing code"). */
  initialManual?: boolean;
  error: string | null;
  onError(error: string | null): void;
  onPair(raw: string): Promise<void>;
  onCancel?: () => void;
  /** In-app variant only (#186 nav consistency): the same hamburger + sessions drawer every other
   *  screen shows, so the connect screen isn't a dead-end with a lone back button. Omitted on the
   *  native first-run/standalone variant, which has no sessions to list. */
  sessions?: SessionView[];
  activeId?: string | null;
  devices?: ListenerDeviceState[];
  onSelectSession?(channelId: string): void;
  onStartOnDevice?(channelId: string): void;
  onOpenDeviceDetails?(channelId: string): void;
  onOpenDevices?(): void;
  onRemoveSession?(channelId: string): void;
  onRenameSession?(channelId: string, title: string): void;
  onGoHome?(): void;
}

export function ConnectScreen({
  firstRun = false,
  hasSessions,
  initialManual = false,
  error,
  onError,
  onPair,
  onCancel,
  sessions,
  activeId,
  devices,
  onSelectSession,
  onStartOnDevice,
  onOpenDeviceDetails,
  onOpenDevices,
  onRemoveSession,
  onRenameSession,
  onGoHome,
}: ConnectScreenProps): JSX.Element {
  const native = isNativeRuntime();
  // Manual/paste pairing is a keyboard-and-mouse convenience (copy a JSON blob from a
  // terminal) — on a touch phone it's just a confusing dead-end box, so keep it desktop-only
  // for now and rely on the camera scanner everywhere else.
  const desktop = isDesktopInput();
  const { busy, run, errorDetail } = usePairing(onError);
  const [manual, setManual] = useState('');
  const [showManual, setShowManual] = useState(initialManual);
  const [debugMode, setDebugMode] = useState(false);
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  // Bumped after a failed pair so the inline web scanner remounts and resumes scanning.
  const [scanNonce, setScanNonce] = useState(0);
  const [drawerOpen, setDrawerOpen] = useState(false);
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

  const backLabel = 'Back';
  const inApp = hasSessions && !firstRun;
  const kicker = 'Connect';
  const heading = 'Scan to connect';
  const tagline = 'One scan links your laptop — it pairs a new device or joins a session automatically.';
  const secondaryCls = inApp ? 'session-secondary-action' : 'secondary-action';
  const linkCls = inApp ? 'session-link-btn' : 'link-btn';

  return (
    <main className={inApp ? 'weft-session join-session' : 'join-shell'}>
      {inApp ? (
        <header className="status-bar">
          <button
            className="icon-btn drawer-btn"
            type="button"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open sessions"
          >
            <span className="hamburger" aria-hidden="true">
              <span />
              <span />
              <span />
            </span>
          </button>
          <div className="status-id">
            <span className="status-title">Scan to connect</span>
            <span className="status-line">
              <span className="status-dot" aria-hidden="true" />
              Pair a device or session
            </span>
          </div>
          {onCancel && !firstRun ? (
            <button className="icon-btn" type="button" onClick={onCancel} aria-label="Close">
              ✕
            </button>
          ) : null}
        </header>
      ) : null}
      <div className={inApp ? 'session-join-inner' : undefined}>
        {inApp ? null : (
          <header className="join-head">
            {onCancel && !firstRun ? (
              <button type="button" className="pair-back" onClick={onCancel}>
                ← {backLabel}
              </button>
            ) : null}
            <p className="eyebrow">{kicker}</p>
            <h2>{heading}</h2>
            <p className="join-tagline">{tagline}</p>
          </header>
        )}

      <div className={inApp ? 'session-join-scanner' : 'join-scanner'}>
        {native ? (
          <div className="native-scan">
            <div className="scanner-reticle" aria-hidden="true">
              <span className="scanner-line" />
            </div>
            <button
              type="button"
              className={inApp ? 'session-primary-action' : 'primary-action'}
              disabled={busy}
              onClick={() => void nativeScan()}
            >
              {busy ? 'Scanning…' : 'Scan QR'}
            </button>
          </div>
        ) : busy ? (
          <div className="scanner-connecting" role="status" aria-live="polite">
            <div className="connecting-spinner" aria-hidden="true" />
            <p>QR found — connecting to your laptop…</p>
          </div>
        ) : (
          <WebQrScanner
            key={scanNonce}
            variant="inline"
            onResult={handleScannerResult}
            onCancel={() => undefined}
            onPasteCode={desktop ? () => setShowManual(true) : undefined}
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

      <details className="join-troubleshoot">
        <summary>Trouble connecting?</summary>
        <div className="join-troubleshoot-body">
          <button
            type="button"
            className={secondaryCls}
            disabled={probeRunning}
            onClick={() => void runProbe()}
          >
            {probeRunning ? 'Testing connectivity…' : 'Run connectivity test'}
          </button>
          {probeResult ? (
            <details className="error-debug-detail" open>
              <summary>Connectivity test result</summary>
              <pre>{probeResult}</pre>
            </details>
          ) : null}

          {desktop ? (
            <>
              <button
                type="button"
                className={linkCls}
                aria-expanded={showManual}
                onClick={() => setShowManual((v) => !v)}
              >
                {showManual ? 'Hide manual entry' : 'Enter pairing code manually'}
              </button>
              {showManual ? (
                <>
                  <textarea
                    className={inApp ? 'session-manual-input' : undefined}
                    aria-label="Manual pairing JSON"
                    value={manual}
                    onChange={(event) => setManual(event.target.value)}
                    placeholder='{"v":1,"channelId":"...","pub":"..."}'
                  />
                  <button
                    type="button"
                    className={secondaryCls}
                    disabled={busy || !manual.trim()}
                    onClick={() => void pair(manual)}
                  >
                    Pair from pasted code
                  </button>
                </>
              ) : null}
            </>
          ) : null}

          <div className="join-debug-row">
            <span>Show technical error details</span>
            <button
              type="button"
              className={`${linkCls} debug-toggle`}
              onClick={toggleDebugMode}
            >
              Debug mode: {debugMode ? 'On' : 'Off'}
            </button>
          </div>
        </div>
      </details>
      </div>
      {drawerOpen && sessions ? (
        <WeftDrawer
          sessions={sessions}
          activeId={activeId ?? null}
          devices={devices}
          onSelect={(id) => {
            setDrawerOpen(false);
            onSelectSession?.(id);
          }}
          onStartOnDevice={onStartOnDevice ? (id) => {
            setDrawerOpen(false);
            onStartOnDevice(id);
          } : undefined}
          onOpenDeviceDetails={onOpenDeviceDetails ? (id) => {
            setDrawerOpen(false);
            onOpenDeviceDetails(id);
          } : undefined}
          onAddSession={() => setDrawerOpen(false)}
          onOpenDevices={onOpenDevices ? () => {
            setDrawerOpen(false);
            onOpenDevices();
          } : undefined}
          onRemove={(id) => onRemoveSession?.(id)}
          onRename={onRenameSession}
          onGoHome={() => {
            setDrawerOpen(false);
            onGoHome?.();
          }}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}
    </main>
  );
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { WebQrScanner } from '@/ui/pairing/WebQrScanner';
import { isNativeRuntime, scanNativeQr, usePairing } from '@/ui/hooks/usePairing';
import { isDebugModeEnabled, setDebugModeEnabled } from '@/lib/debugSettings';
import { runConnectivityProbe } from '@/lib/wsProbe';
import { supabaseProbeEndpoint } from '@/lib/weftClient';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
import { WeftMark, WeftMenuIcon } from '@/ui/brand/WeftMark';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { useLeftEdgeSwipe } from '@/ui/gestures/touchGestures';

export const SETUP_URL = 'https://aasis21.github.io/weft/#install-laptop';

interface ConnectScreenProps {
  /** Native first run: no prior sessions to go back to. */
  firstRun?: boolean;
  hasSessions: boolean;
  /** Open the manual paste box on mount (e.g. user tapped "Paste a code"). */
  initialManual?: boolean;
  /** Opened from a live chat: lead with the single-session (`/weft`) instructions. */
  fromChat?: boolean;
  /** Show the one-time welcome (headline + both ways to get a code, expanded). */
  showIntro?: boolean;
  /** The user dismissed the welcome with "Got it". */
  onIntroDone?(): void;
  error: string | null;
  onError(error: string | null): void;
  onPair(raw: string): Promise<void>;
  onCancel?: () => void;
  /** In-app variant only (#186 nav consistency): the same menu + sessions drawer every other
   *  screen shows, so the connect screen isn't a dead-end with a lone back button. */
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

type Method = 'idle' | 'scan' | 'paste';

function StationWay(): JSX.Element {
  return (
    <article className="connect-way connect-way-station">
      <div className="connect-way-head">
        <h3>Weft Station</h3>
        <span className="connect-way-tag">Recommended</span>
      </div>
      <p>Pair this phone once, then start or resume any Copilot session on the laptop.</p>
      <ol className="join-steps">
        <li><span className="step-num">1</span><span>On your laptop, run <code>weft</code></span></li>
        <li><span className="step-num">2</span><span>Choose <strong>Control → Start Station</strong></span></li>
        <li><span className="step-num">3</span><span>Open <strong>Pairing</strong> and scan its QR</span></li>
      </ol>
    </article>
  );
}

function SessionWay(): JSX.Element {
  return (
    <article className="connect-way connect-way-session">
      <div className="connect-way-head">
        <h3>Just this chat</h3>
      </div>
      <p>In a running Copilot CLI session, run <code>/weft</code> and scan its QR. No Station needed.</p>
    </article>
  );
}

export function ConnectScreen({
  firstRun = false,
  hasSessions,
  initialManual = false,
  fromChat = false,
  showIntro = false,
  onIntroDone,
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
  const { busy, run, errorDetail } = usePairing(onError);
  const [method, setMethod] = useState<Method>(initialManual ? 'paste' : 'idle');
  const [lastMethod, setLastMethod] = useState<Method>('idle');
  /** Android without the Play Services scanner module: use the in-app camera instead. */
  const [inAppCamera, setInAppCamera] = useState(!native);
  const [connecting, setConnecting] = useState(false);
  const [manual, setManual] = useState('');
  const [intro, setIntro] = useState(showIntro);
  const [setupNote, setSetupNote] = useState<string | null>(null);
  const [debugMode, setDebugMode] = useState(false);
  const [probeRunning, setProbeRunning] = useState(false);
  const [probeResult, setProbeResult] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  useLeftEdgeSwipe(!!sessions && !drawerOpen, () => setDrawerOpen(true));
  const probeEndpoint = useRef<string | null>(null);

  useEffect(() => {
    void isDebugModeEnabled().then(setDebugMode);
  }, []);

  useEffect(() => {
    setIntro(showIntro);
  }, [showIntro]);

  const runProbe = async (): Promise<void> => {
    setProbeRunning(true);
    setProbeResult(null);
    try {
      setProbeResult(await runConnectivityProbe(probeEndpoint.current));
    } finally {
      setProbeRunning(false);
    }
  };

  const toggleDebugMode = (): void => {
    const next = !debugMode;
    setDebugMode(next);
    void setDebugModeEnabled(next);
  };

  /** Pair a code read by any method. On failure, return to idle so "Try again" can re-open it. */
  const pairCode = useCallback(async (raw: string, from: Method): Promise<void> => {
    probeEndpoint.current = null;
    setProbeResult(null);
    setLastMethod(from);
    setConnecting(true);
    try {
      await onPair(raw);
    } catch (err) {
      probeEndpoint.current = supabaseProbeEndpoint(raw);
      setMethod(from === 'paste' ? 'paste' : 'idle');
      throw err;
    } finally {
      setConnecting(false);
    }
  }, [onPair]);

  const startScan = useCallback((): void => {
    onError(null);
    setLastMethod('scan');
    if (inAppCamera) {
      setMethod('scan');
      return;
    }
    void run(async () => {
      const raw = await scanNativeQr();
      if (raw === null) {
        setInAppCamera(true);
        setMethod('scan');
      } else {
        await pairCode(raw, 'scan');
      }
    });
  }, [inAppCamera, onError, pairCode, run]);

  const handleScannerResult = useCallback((raw: string): void => {
    void run(() => pairCode(raw, 'scan'));
  }, [pairCode, run]);

  const openPaste = (): void => {
    onError(null);
    setManual('');
    setMethod('paste');
  };

  const sendSetupLink = async (): Promise<void> => {
    const text = 'Install Weft on your laptop, then pair your phone:';
    try {
      if (typeof navigator.share === 'function') {
        await navigator.share({ title: 'Set up Weft', text, url: SETUP_URL });
        return;
      }
      await navigator.clipboard.writeText(`${text} ${SETUP_URL}`);
      setSetupNote('Setup link copied. Send it to your laptop.');
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setSetupNote(`Open ${SETUP_URL} on your laptop.`);
    }
  };

  const inApp = hasSessions && !firstRun;
  const secondaryCls = inApp ? 'session-secondary-action' : 'secondary-action';
  const primaryCls = inApp ? 'session-primary-action' : 'primary-action';
  const linkCls = inApp ? 'session-link-btn' : 'link-btn';
  const ways = fromChat ? [<SessionWay key="session" />, <StationWay key="station" />]
    : [<StationWay key="station" />, <SessionWay key="session" />];

  const methodArea = connecting ? (
    <ol className="connect-progress" role="status" aria-live="polite" aria-label="Pairing progress">
      <li className="is-done"><span className="connect-progress-dot" aria-hidden="true" />Pairing code read</li>
      <li className="is-active"><span className="connect-progress-dot" aria-hidden="true" />Connecting to your laptop…</li>
    </ol>
  ) : method === 'scan' ? (
    <div className="connect-scan">
      <div className={inApp ? 'session-join-scanner' : 'join-scanner'}>
        <WebQrScanner
          variant="inline"
          onResult={handleScannerResult}
          onCancel={() => setMethod('idle')}
        />
      </div>
      <div className="connect-alt">
        <button type="button" className={linkCls} onClick={() => setMethod('idle')}>Cancel</button>
        <button type="button" className={linkCls} onClick={openPaste}>Paste code instead</button>
      </div>
    </div>
  ) : method === 'paste' ? (
    <div className="join-fallback connect-paste">
      <p className="join-hint">On your laptop, open <strong>Pairing</strong> and choose <strong>Copy pairing code</strong>.</p>
      <textarea
        className={inApp ? 'session-manual-input' : undefined}
        aria-label="Pairing code"
        value={manual}
        onChange={(event) => setManual(event.target.value)}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Paste the private pairing code"
      />
      <button
        type="button"
        className={primaryCls}
        disabled={busy || !manual.trim()}
        onClick={() => void run(() => pairCode(manual.trim(), 'paste'))}
      >
        Pair
      </button>
      <button type="button" className={linkCls} onClick={() => setMethod('idle')}>Scan QR instead</button>
    </div>
  ) : (
    <div className="connect-actions">
      <button type="button" className={`${primaryCls} connect-scan-btn`} disabled={busy} onClick={startScan}>
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"
          strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
          <path d="M4 8V5a1 1 0 0 1 1-1h3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3" />
          <path d="M8 12h8" />
        </svg>
        {busy ? 'Opening scanner…' : 'Scan laptop QR'}
      </button>
      <button type="button" className={secondaryCls} disabled={busy} onClick={openPaste}>
        Paste code
      </button>
    </div>
  );

  return (
    <main className={`${inApp ? 'weft-session join-session' : 'join-shell'} connect-screen`}>
      {inApp ? (
        <header className="status-bar">
          <button className="icon-btn drawer-btn" type="button" onClick={() => setDrawerOpen(true)} aria-label="Open sessions">
            <WeftMenuIcon />
          </button>
          <div className="status-id">
            <span className="status-title">Connect</span>
            <span className="status-line">
              <span className="status-dot" aria-hidden="true" />
              Pair a laptop or join a chat
            </span>
          </div>
          {onCancel && !firstRun ? (
            <button className="icon-btn" type="button" onClick={onCancel} aria-label="Close">
              ✕
            </button>
          ) : null}
        </header>
      ) : null}
      <div className={inApp ? 'session-join-inner connect-inner' : 'connect-inner'}>
        {!inApp && onCancel && !firstRun ? (
          <button type="button" className="pair-back" onClick={onCancel}>
            ← Back
          </button>
        ) : null}

        {intro ? (
          <header className="connect-hero">
            <p className="connect-brand"><WeftMark size={18} /> Weft</p>
            <h2>Your Copilot session, off the desk.</h2>
            <p className="connect-lede">
              Start or resume Copilot sessions, follow live work, and approve tool calls from your phone.
              Copilot keeps running on your laptop.
            </p>
          </header>
        ) : (
          <header className="connect-head">
            <h2>Connect to your laptop</h2>
            <p className="connect-lede">Scan the QR Weft shows on your laptop.</p>
          </header>
        )}

        {intro && method === 'idle' && !connecting ? (
          <section className="connect-ways" aria-label="Get a pairing code">
            <p className="connect-ways-label">On your laptop</p>
            {ways}
          </section>
        ) : null}

        <div className="connect-method">{methodArea}</div>

        {error ? (
          <div className="error-banner-wrap">
            <p className="error-banner">{error}</p>
            {lastMethod !== 'idle' && !busy ? (
              <button
                type="button"
                className={secondaryCls}
                onClick={() => (lastMethod === 'paste' ? openPaste() : startScan())}
              >
                Try again
              </button>
            ) : null}
            {debugMode && errorDetail ? (
              <details className="error-debug-detail" open>
                <summary>Technical details</summary>
                <pre>{errorDetail}</pre>
              </details>
            ) : null}
          </div>
        ) : null}

        {intro ? (
          <button
            type="button"
            className={`${linkCls} connect-got-it`}
            onClick={() => {
              setIntro(false);
              onIntroDone?.();
            }}
          >
            Got it
          </button>
        ) : (
          <details className="join-troubleshoot connect-help">
            <summary>Need a pairing code?</summary>
            <div className="connect-ways">{ways}</div>
          </details>
        )}

        <div className="connect-setup">
          <span>Weft not on your laptop yet?</span>
          <button type="button" className={linkCls} onClick={() => void sendSetupLink()}>
            Send setup link
          </button>
          {setupNote ? <p className="connect-setup-note" role="status">{setupNote}</p> : null}
        </div>

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
            <div className="join-debug-row">
              <span>Show technical error details</span>
              <button type="button" className={`${linkCls} debug-toggle`} onClick={toggleDebugMode}>
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

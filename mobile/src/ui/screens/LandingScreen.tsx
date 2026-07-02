import { useState } from 'react';
import type { JSX } from 'react';
import { usePairing } from '@/ui/hooks/usePairing';

interface LandingScreenProps {
  onBeginPair(manual?: boolean): void;
  onStartDemo(): Promise<void>;
  error: string | null;
  onError(error: string | null): void;
  /** True when the user already has joined sessions, so the page can link back into them. */
  hasSessions?: boolean;
  /** Return to the live session screen. Provided only when hasSessions is true. */
  onOpenSessions?: () => void;
}

type OsTab = 'windows' | 'unix';

const INSTALL: Record<OsTab, { label: string; cmd: string }> = {
  windows: { label: 'Windows', cmd: 'irm https://usehelm.netlify.app/install.ps1 | iex' },
  unix: { label: 'macOS · Linux', cmd: 'curl -fsSL https://usehelm.netlify.app/install.sh | bash' },
};

const STEPS = [
  {
    n: 1,
    title: 'Install Helm on your laptop',
    body: 'One line. Copilot picks it up automatically — no accounts, no setup.',
  },
  {
    n: 2,
    title: 'Start a Copilot session',
    body: 'Run copilot in any project. A pairing QR appears right on your screen.',
  },
  {
    n: 3,
    title: 'Scan it with your phone',
    body: "You're in. Chat with it, send it new tasks, and approve its actions — from anywhere.",
  },
];

const CAN_DO = [
  {
    icon: 'chat',
    title: 'Talk to it',
    body: 'Send prompts and follow-ups, just like at your keyboard. Replies stream in live.',
  },
  {
    icon: 'check',
    title: 'Approve on the spot',
    body: 'When Copilot needs the OK to run something, it asks your phone. Tap yes or no.',
  },
  {
    icon: 'refresh',
    title: 'Pick up where you left off',
    body: 'Sessions stay warm and reconnect when you reopen Helm. Juggle several at once.',
  },
];

const ICONS: Record<string, JSX.Element> = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3 21l1.9-5.6A8.5 8.5 0 1 1 21 11.5Z" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="m8.4 12.2 2.4 2.4 4.8-5.2" />
    </svg>
  ),
  refresh: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3.5 12a8.5 8.5 0 0 1 14.4-6.1" />
      <path d="M18.5 3.5V8H14" />
      <path d="M20.5 12a8.5 8.5 0 0 1-14.4 6.1" />
      <path d="M5.5 20.5V16H10" />
    </svg>
  ),
};

const LOCK_ICON: JSX.Element = (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    <rect x="4.5" y="10.5" width="15" height="9.5" rx="2.4" />
    <path d="M8 10.5V7.2a4 4 0 0 1 8 0v3.3" />
    <circle cx="12" cy="15" r="1.1" />
  </svg>
);

function detectOs(): OsTab {
  if (typeof navigator === 'undefined') return 'windows';
  return /win/i.test(navigator.userAgent) ? 'windows' : 'unix';
}

function InstallCommand(): JSX.Element {
  const [os, setOs] = useState<OsTab>(detectOs());
  const [copied, setCopied] = useState(false);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(INSTALL[os].cmd);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard blocked — the command text is still selectable */
    }
  };

  return (
    <div className="install-cmd">
      <div className="install-tabs" role="tablist" aria-label="Operating system">
        {(Object.keys(INSTALL) as OsTab[]).map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={os === key}
            className={`install-tab${os === key ? ' active' : ''}`}
            onClick={() => setOs(key)}
          >
            {INSTALL[key].label}
          </button>
        ))}
      </div>
      <div className="install-row">
        <code className="install-code">{INSTALL[os].cmd}</code>
        <button type="button" className="copy-btn" onClick={() => void copy()}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function LandingScreen({
  onBeginPair,
  onStartDemo,
  error,
  onError,
  hasSessions = false,
  onOpenSessions,
}: LandingScreenProps): JSX.Element {
  const { busy, run } = usePairing(onError);
  const showSessions = hasSessions && !!onOpenSessions;

  return (
    <main className="landing-shell">
      {showSessions ? (
        <div className="landing-topbar">
          <button type="button" className="sessions-link" onClick={onOpenSessions}>
            ← Back to your sessions
          </button>
        </div>
      ) : null}

      <section className="landing-hero">
        <div className="brand-mark" aria-hidden="true">
          H
        </div>
        <p className="eyebrow">GitHub Copilot, off the desk</p>
        <h1>
          Your Copilot session, now in your <em className="serif">hand.</em>
        </h1>
        <p className="lede">
          Helm connects to your live GitHub Copilot session and puts you in control from your
          phone — see what it&apos;s doing, tell it what to do next, and approve its moves.
          Wherever you are. Private, end&nbsp;to&nbsp;end.
        </p>
        <div className="landing-cta">
          {showSessions ? (
            <button type="button" className="primary-action" onClick={onOpenSessions}>
              Open your sessions
            </button>
          ) : null}
          <button
            type="button"
            className={showSessions ? 'secondary-action' : 'primary-action'}
            onClick={() => onBeginPair(false)}
          >
            Scan QR to pair
          </button>
          <button type="button" className="secondary-action" onClick={() => onBeginPair(true)}>
            Paste a code
          </button>
          <button type="button" className="demo-action" disabled={busy} onClick={() => void run(onStartDemo)}>
            Try the demo
          </button>
        </div>
        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="landing-pitch">
        <p>
          Start a task at your desk — keep it going from the couch, the kitchen, or the train.
          Copilot keeps working; you stay in charge.
        </p>
      </section>

      <section className="landing-steps" aria-label="How it works">
        <h2>How it works</h2>
        <ol className="step-grid">
          {STEPS.map((step) => (
            <li key={step.n} className="step-card">
              <span className="step-num" aria-hidden="true">
                {step.n}
              </span>
              <div className="step-body">
                <h3>{step.title}</h3>
                <p>{step.body}</p>
                {step.n === 1 ? <InstallCommand /> : null}
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="landing-do" aria-label="What you can do">
        <h2>What you can do</h2>
        <div className="do-grid">
          {CAN_DO.map((item) => (
            <div key={item.title} className="do-card">
              <span className="do-icon" aria-hidden="true">
                {ICONS[item.icon]}
              </span>
              <div>
                <strong>{item.title}</strong>
                <p>{item.body}</p>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="landing-privacy" aria-label="Privacy">
        <span className="privacy-lock" aria-hidden="true">
          {LOCK_ICON}
        </span>
        <div>
          <strong>Yours alone.</strong>
          <p>
            Every message is encrypted end to end and stored nowhere — the relay only ever sees
            scrambled text.
            <span className="privacy-fine">AES-256-GCM · zero storage · private channel</span>
          </p>
        </div>
      </section>

      <section className="landing-fin">
        <p className="fin-line">
          Ship from <em className="serif">anywhere.</em>
          <span className="fin-caret">_</span>
        </p>
        <button
          type="button"
          className="primary-action"
          onClick={() => (showSessions ? onOpenSessions?.() : onBeginPair(false))}
        >
          {showSessions ? 'Open your sessions' : 'Scan QR to pair'}
        </button>
      </section>

      <footer className="landing-footer">
        <a href="https://github.com/aasis21/helm" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <span aria-hidden="true">·</span>
        <span>Apache-2.0 · Android-first · React · Vite · Capacitor</span>
      </footer>
    </main>
  );
}

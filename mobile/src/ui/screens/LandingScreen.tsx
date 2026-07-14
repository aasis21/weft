import { useState } from 'react';
import type { JSX } from 'react';
import { usePairing } from '@/ui/hooks/usePairing';
import { isDesktopInput } from '@/lib/platform';

interface LandingScreenProps {
  onBeginPair(manual?: boolean): void;
  onStartDemo(): Promise<void>;
  error: string | null;
  onError(error: string | null): void;
  /** True when the user already has joined sessions, so the page can link back into them. */
  hasSessions?: boolean;
  /** Return to the live session screen. Provided only when hasSessions is true. */
  onOpenSessions?: () => void;
  onStartSession?: () => void;
}

type OsTab = 'windows' | 'unix';

const INSTALL: Record<OsTab, { label: string; cmd: string }> = {
  windows: { label: 'Windows', cmd: 'irm https://useweft.netlify.app/install.ps1 | iex' },
  unix: { label: 'macOS · Linux', cmd: 'curl -fsSL https://useweft.netlify.app/install.sh | bash' },
};

const STEPS = [
  {
    n: 1,
    title: 'Install Weft on your laptop',
    body: 'One line. Copilot picks it up automatically — no accounts, no setup.',
  },
  {
    n: 2,
    title: 'Show a code',
    body: 'One for the whole laptop, or one for a single Copilot chat you have open.',
  },
  {
    n: 3,
    title: "Scan it, you're in",
    body: "A laptop code lets you start fresh chats or join any that's running; a chat code drops you straight into that one. Come back later, it's right where you left it.",
  },
];

const CAN_DO = [
  {
    icon: 'chat',
    title: 'Talk to it',
    body: 'Send prompts and follow-ups, just like at your keyboard. Replies stream in live.',
  },
  {
    icon: 'voice',
    title: 'Go hands-free with Vox',
    body: 'Tap the orb and just talk. Vox listens, sends, and reads replies back — eyes-free.',
  },
  {
    icon: 'check',
    title: 'Approve on the spot',
    body: 'When Copilot needs the OK to run something, it asks your phone. Tap yes or no.',
  },
  {
    icon: 'image',
    title: 'Show it a screenshot',
    body: 'Attach images from your camera or gallery so Copilot can see what you mean.',
  },
  {
    icon: 'devices',
    title: 'Start fresh or jump back in',
    body: "Kick off a new chat on any laptop, or drop straight into one it's already running.",
  },
  {
    icon: 'refresh',
    title: 'Pick up where you left off',
    body: 'Sessions stay warm and reconnect when you reopen Weft. Juggle several at once.',
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
  voice: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" />
      <path d="M12 18v3" />
    </svg>
  ),
  image: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.4" />
      <circle cx="9" cy="10" r="1.6" />
      <path d="m5 18 4.5-4.5a2 2 0 0 1 2.7 0L19 20" />
    </svg>
  ),
  devices: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <rect x="2.5" y="5" width="13" height="9.5" rx="1.6" />
      <path d="M6 18h6" />
      <rect x="16.5" y="9.5" width="5" height="10" rx="1.4" />
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
  const panelId = 'install-command-panel';
  const activeTabId = `install-tab-${os}`;

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
            id={`install-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={os === key}
            aria-controls={panelId}
            className={`install-tab${os === key ? ' active' : ''}`}
            onClick={() => setOs(key)}
          >
            {INSTALL[key].label}
          </button>
        ))}
      </div>
      <div id={panelId} className="install-row" role="tabpanel" aria-labelledby={activeTabId}>
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
  onStartSession,
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
          W
        </div>
        <p className="eyebrow">GitHub Copilot, off the desk</p>
        <h1>
          Your Copilot session, now in your <em className="serif">hand.</em>
        </h1>
        <p className="lede">
          Your Copilot runs on your laptop — Weft brings it to your phone. Pick up a chat
          that&apos;s already going, or start a new one on any laptop you&apos;ve paired. Everything
          you&apos;d do at the terminal, you do from your phone — send it work, watch it think,
          approve what it runs. From anywhere. Private, end&nbsp;to&nbsp;end.
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
          {showSessions && onStartSession ? (
            <button type="button" className="secondary-action" onClick={onStartSession}>
              Start another session
            </button>
          ) : null}
          {isDesktopInput() ? (
            <button type="button" className="secondary-action" onClick={() => onBeginPair(true)}>
              Paste a code
            </button>
          ) : null}
          <button type="button" className="demo-action" disabled={busy} onClick={() => void run(onStartDemo)}>
            Try the demo
          </button>
        </div>
        {error ? <p className="error-banner">{error}</p> : null}
      </section>

      <section className="landing-pitch">
        <p>
          Start a chat at your desk, keep it going from the couch. Pair more than one laptop, run as
          many chats as you like — Weft keeps them all in one place, warm and ready.
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
        <a href="https://github.com/aasis21/weft" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <span aria-hidden="true">·</span>
        <span>Apache-2.0 · Android-first · React · Vite · Capacitor</span>
      </footer>
    </main>
  );
}

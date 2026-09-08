import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import { usePairing } from '@/ui/hooks/usePairing';
import { WeftMark } from '@/ui/brand/WeftMark';
import { isDesktopInput } from '@/lib/platform';
import { applyTheme, getTheme, setTheme, subscribeSettings, type ThemeSetting } from '@/lib/settings';

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
const DOCS = 'https://aasis21.github.io/weft/';

const INSTALL: Record<OsTab, { label: string; cmd: string }> = {
  windows: { label: 'Windows', cmd: 'irm https://useweft.netlify.app/install.ps1 | iex' },
  unix: { label: 'macOS · Linux', cmd: 'curl -fsSL https://useweft.netlify.app/install.sh | bash' },
};

const STEPS = [
  {
    n: 1,
    title: 'Install on your laptop',
    body: 'Run one command in your terminal. It installs the Weft command and Copilot extension; no account is required.',
  },
  {
    n: 2,
    title: 'Run weft start',
    body: 'Start the Device Station and leave that terminal open. It prints the QR your phone needs.',
  },
  {
    n: 3,
    title: 'Scan with your phone',
    body: 'Open this site on your phone, choose Scan QR to pair, and point the camera at the code.',
  },
];

const CAN_DO = [
  {
    icon: 'chat',
    title: 'Drive it live',
    body: "Send prompts and follow-ups, watch replies stream back word by word. It's the real session — not a read-only peek.",
  },
  {
    icon: 'activity',
    title: 'Watch it work',
    body: 'See every command it runs and every file it edits unfold in real time, right in the thread.',
  },
  {
    icon: 'check',
    title: 'Approve before it acts',
    body: 'Review the permission requests Copilot sends you. Allow or deny from your phone, with the command in view.',
  },
  {
    icon: 'voice',
    title: 'Go hands-free with Vox',
    body: 'Dictate a prompt and hear replies with Vox on supported browsers. Prefer typing? The composer is always there.',
  },
  {
    icon: 'image',
    title: 'Show it what you mean',
    body: 'Snap a photo or attach a screenshot so it can see the bug, the design, the error — not just read about it.',
  },
  {
    icon: 'sliders',
    title: 'Keep it on track',
    body: 'Flip between plan and autopilot, drop in quick commands, or tap Stop the moment it wanders.',
  },
  {
    icon: 'devices',
    title: 'Run a whole fleet',
    body: 'Many laptops, many chats. Start a fresh one or jump into a running one. Opt in on a supported laptop to share a real terminal, too.',
  },
  {
    icon: 'refresh',
    title: 'Come back anytime',
    body: 'Reopen Weft to reconnect while your laptop and session are running. Your local history stays on your devices.',
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
  activity: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M3 12h4l2.5-6.5 5 13L17 12h4" />
    </svg>
  ),
  sliders: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d="M5 4v6M5 14v6M12 4v3M12 11v9M19 4v9M19 17v3" />
      <circle cx="5" cy="12" r="2" />
      <circle cx="12" cy="9" r="2" />
      <circle cx="19" cy="15" r="2" />
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
  const [copyStatus, setCopyStatus] = useState('');
  const resetTimer = useRef<ReturnType<typeof setTimeout>>();
  const panelId = 'install-command-panel';
  const activeTabId = `install-tab-${os}`;

  useEffect(() => () => clearTimeout(resetTimer.current), []);

  const copy = async (): Promise<void> => {
    clearTimeout(resetTimer.current);
    try {
      await navigator.clipboard.writeText(INSTALL[os].cmd);
      setCopyStatus('Copied to clipboard.');
      resetTimer.current = setTimeout(() => setCopyStatus(''), 2500);
    } catch {
      setCopyStatus('Copy unavailable. Select the command and copy it manually.');
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
            tabIndex={os === key ? 0 : -1}
            className={`install-tab${os === key ? ' active' : ''}`}
            onClick={() => { setOs(key); setCopyStatus(''); }}
            onKeyDown={(event) => {
              if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const next = event.key === 'Home' ? 'windows' : event.key === 'End' ? 'unix' : key === 'windows' ? 'unix' : 'windows';
              setOs(next);
              setCopyStatus('');
              document.getElementById(`install-tab-${next}`)?.focus();
            }}
          >
            {INSTALL[key].label}
          </button>
        ))}
      </div>
      <div id={panelId} className="install-row" role="tabpanel" aria-labelledby={activeTabId} tabIndex={0}>
        <code className="install-code">{INSTALL[os].cmd}</code>
        <button type="button" className="copy-btn" onClick={() => void copy()}>
          Copy
        </button>
      </div>
      <p className="install-copy-status" role="status">{copyStatus}</p>
    </div>
  );
}

function SessionPreview(): JSX.Element {
  return (
    <figure className="product-preview" aria-label="Illustrative Weft session preview">
      <div className="preview-terminal">
        <span className="preview-label">On your laptop</span>
        <code>$ weft start</code>
        <span>Device Station ready</span>
      </div>
      <div className="preview-phone">
        <div className="preview-session-bar">
          <WeftMark size={23} />
          <strong>My project</strong>
          <span>Illustration</span>
        </div>
        <div className="preview-thread">
          <p className="preview-message preview-user">Add a dark mode toggle and show me the changes.</p>
          <p className="preview-message">I&apos;ll use the existing theme tokens and update the header.</p>
          <div className="preview-tool"><span aria-hidden="true">↳</span> Editing Header.tsx</div>
          <div className="preview-approval">
            <span className="preview-label">You stay in control</span>
            <strong>Run the project tests?</strong>
            <code>npm test</code>
            <span className="preview-decision">Review on your phone</span>
          </div>
        </div>
        <div className="preview-composer">Send a follow-up… <span aria-hidden="true">↑</span></div>
      </div>
      <figcaption>Your code runs on your laptop. You stay in the conversation.</figcaption>
    </figure>
  );
}

function ThemeToggle(): JSX.Element {
  const [theme, setSelectedTheme] = useState<ThemeSetting | null>(null);
  const [systemDark, setSystemDark] = useState(() => globalThis.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false);

  useEffect(() => {
    let active = true;
    void getTheme().then((saved) => { if (active) setSelectedTheme(saved); });
    const unsubscribe = subscribeSettings((settings) => setSelectedTheme(settings.theme));
    const media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    const onChange = (): void => setSystemDark(media?.matches ?? false);
    media?.addEventListener('change', onChange);
    return () => { active = false; unsubscribe(); media?.removeEventListener('change', onChange); };
  }, []);

  const dark = theme === 'dark' || ((theme === 'system' || theme === null) && systemDark);
  const label = dark ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      className="product-theme-toggle"
      aria-label={label}
      title={label}
      disabled={theme === null}
      onClick={() => {
        const next = dark ? 'light' : 'dark';
        setSelectedTheme(next);
        applyTheme(next);
        void setTheme(next);
      }}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        {dark ? (
          <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>
        ) : (
          <path d="M20.8 13.2A9 9 0 0 1 10.8 3.2 9 9 0 1 0 20.8 13.2Z" />
        )}
      </svg>
    </button>
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
  const desktop = isDesktopInput();

  useEffect(() => {
    // The app mounts after the browser's initial fragment scroll.
    const section = window.location.hash.slice(1);
    if (['product', 'get-started', 'features', 'privacy'].includes(section)) {
      document.getElementById(section)?.scrollIntoView();
    }
  }, []);

  return (
    <main className="landing-shell">
      <a className="landing-skip" href="#get-started">Skip to setup</a>
      <nav className="product-nav" aria-label="Product navigation">
        <a className="product-brand" href="#product"><WeftMark size={30} /> <span>weft</span></a>
        <div className="product-nav-links">
          <a href="#features">Features</a>
          <a href={DOCS}>Docs</a>
          <a href="https://github.com/aasis21/weft">GitHub</a>
          <ThemeToggle />
        </div>
      </nav>
      {showSessions ? (
        <div className="landing-topbar">
          <button type="button" className="sessions-link" onClick={onOpenSessions}>
            ← Back to your sessions
          </button>
        </div>
      ) : null}

      <section className="landing-hero" id="product">
        <div className="product-intro">
          <p className="eyebrow">GitHub Copilot, off the desk</p>
          <h1>
            Your Copilot session, now in your <em className="serif">hand.</em>
          </h1>
          <p className="lede">
            Step away from your desk, not your work. Send prompts, follow the changes,
            and answer permission requests from your phone. Copilot keeps running on your laptop.
          </p>
          <div className="landing-cta">
            {showSessions ? (
              <button type="button" className="primary-action" onClick={onOpenSessions}>
                Open your sessions
              </button>
            ) : null}
            {desktop && !showSessions ? (
              <a className="primary-action" href="#get-started">Set up your laptop</a>
            ) : null}
            {!desktop ? (
              <button
                type="button"
                className={showSessions ? 'secondary-action' : 'primary-action'}
                onClick={() => onBeginPair(false)}
              >
                Scan QR to pair
              </button>
            ) : null}
            {showSessions && onStartSession ? (
              <button type="button" className="secondary-action" onClick={onStartSession}>
                Start another session
              </button>
            ) : null}
            <button type="button" className="demo-action" disabled={busy} onClick={() => void run(onStartDemo)}>
              Try the demo
            </button>
          </div>
          {desktop ? (
            <div className="product-pair-options">
              <span>Already have a pairing code?</span>
              <button type="button" className="secondary-action" onClick={() => onBeginPair(false)}>
                Scan QR to pair
              </button>
              <button type="button" className="secondary-action" onClick={() => onBeginPair(true)}>
                Paste a code
              </button>
            </div>
          ) : null}
          <p className="landing-context">
            {showSessions
              ? 'Your sessions are one tap away. Pair again only to add or replace a device.'
              : desktop
                ? 'Start here on your laptop. Then open useweft.netlify.app on your phone to scan.'
                : 'Have a QR on your laptop? Scan it above. New here? Follow the setup below.'}
          </p>
          <ul className="product-proof" aria-label="At a glance">
            <li>End-to-end encrypted</li>
            <li>Open source</li>
            <li>No Weft account</li>
          </ul>
          {error ? <p className="error-banner" role="alert">{error}</p> : null}
        </div>
        <SessionPreview />
      </section>

      <section className="landing-steps" id="get-started" aria-label="How it works" tabIndex={-1}>
        <div className="product-section-heading">
          <p className="product-kicker">One laptop. One phone. Your workflow.</p>
          <h2>From your terminal to your phone.</h2>
          <p>Use a laptop with Node.js 20+ and an installed, signed-in GitHub Copilot CLI.
            Keep it awake and connected while you work remotely.</p>
          <a href={`${DOCS}#quickstart`}>Full setup guide →</a>
        </div>
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
                {step.n === 2 ? <pre className="product-command"><code>weft start</code></pre> : null}
                {step.n === 3 ? <a className="product-inline-link" href="https://useweft.netlify.app">useweft.netlify.app →</a> : null}
              </div>
            </li>
          ))}
        </ol>
        <p className="landing-install-note">
          Use the phone browser right away, or choose Install app / Add to Home Screen.
          No app-store download needed. <a href="/app.html">App installation options</a>
        </p>
      </section>

      <section className="landing-do" id="features" aria-label="What you can do">
        <div className="product-section-heading">
          <p className="product-kicker">More than a remote view</p>
          <h2>Keep the conversation moving.</h2>
          <p>From the first prompt to the next decision, take the useful parts of your terminal with you.</p>
        </div>
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

      <section className="landing-privacy" id="privacy" aria-label="Privacy">
        <span className="privacy-lock" aria-hidden="true">
          {LOCK_ICON}
        </span>
        <div>
          <strong>Your work stays on your devices.</strong>
          <p>
            Weft keeps transcripts and pairing keys locally on your devices so sessions can
            reconnect. Relay infrastructure forwards encrypted traffic and stores no session
            content. Terminal input and output are excluded from Weft diagnostic logs;
            the shell and programs can still keep their own history.
            <span className="privacy-fine">AES-256-GCM · local history · no relay content storage</span>
          </p>
          <a
            className="privacy-link"
            href="https://github.com/aasis21/weft/blob/main/PRIVACY.md"
            target="_blank"
            rel="noreferrer"
          >
            Read the privacy notice
          </a>
        </div>
      </section>

      <section className="product-help" aria-labelledby="product-help-title">
        <div>
          <p className="product-kicker">Before you get started</p>
          <h2 id="product-help-title">A few things worth knowing.</h2>
          <p>What you need, where your work runs, and how the connection stays private.</p>
          <a className="product-inline-link" href={DOCS}>Explore the docs →</a>
          <p>Already using Weft? <a href={`${DOCS}#recovery`}>Get help reconnecting a phone.</a></p>
        </div>
        <div className="product-faq">
          <details>
            <summary>What do I need to get started?</summary>
            <p>A Windows, macOS, or Linux laptop with Node.js 20+ and a signed-in GitHub Copilot CLI,
              plus a phone with a current browser. Install Weft on the laptop, run <code>weft start</code>,
              and scan its QR from your phone. No phone download or separate Weft account is needed;
              you still need access to GitHub Copilot. Want a look first? Choose Try the demo above,
              with no pairing or changes to your files.</p>
          </details>
          <details>
            <summary>Where does my work run? Can I leave my desk?</summary>
            <p>Your files, terminal commands, and Copilot session stay on your laptop.
              Weft brings the conversation and permission requests to your phone; it does not
              move your development environment to the cloud. You can use a different Wi-Fi network
              or mobile data, as long as both devices can reach the relay. Keep the laptop awake,
              online, and the Device Station terminal open.</p>
            <p>With terminal access enabled, Open terminal creates or resumes one real laptop shell,
              shared with its local window. Leaving the phone terminal screen keeps that shell running;
              confirmed Close ends it. The initial workspace is not a sandbox.</p>
          </details>
          <details>
            <summary>Who can see or control my session?</summary>
            <p>Weft encrypts session traffic between your paired devices. The relay forwards encrypted
              messages, not readable prompts or code; local history and pairing keys remain on your devices.
              Your paired phone can send prompts and answer Copilot&apos;s permission requests, so keep
              the phone and pairing QR private. Shared terminal access is enabled by default on supported
              Windows laptops. Disable it with <code>terminal.enabled: false</code> in the laptop configuration.
              Terminal commands run with your laptop
              account permissions, not through Copilot&apos;s approval flow.
              This does not change how GitHub Copilot processes your
              requests under its own service policies. <a href={`${DOCS}#security`}>Read the privacy and trust boundaries.</a></p>
          </details>
        </div>
      </section>

      <section className="landing-fin">
        <p className="fin-line">
          Ship from <em className="serif">anywhere.</em>
          <span className="fin-caret">_</span>
        </p>
        {desktop && !showSessions ? (
          <a className="primary-action" href="#get-started">Set up your laptop</a>
        ) : null}
        <button
          type="button"
          className={desktop && !showSessions ? 'secondary-action' : 'primary-action'}
          onClick={() => (showSessions ? onOpenSessions?.() : onBeginPair(false))}
        >
          {showSessions ? 'Open your sessions' : 'Scan QR to pair'}
        </button>
      </section>

      <footer className="landing-footer">
        <a href={DOCS}>Documentation</a>
        <a href="https://github.com/aasis21/weft" target="_blank" rel="noreferrer">
          GitHub
        </a>
        <span aria-hidden="true">·</span>
        <a href="https://github.com/aasis21/weft/blob/main/PRIVACY.md" target="_blank" rel="noreferrer">
          Privacy
        </a>
        <a href="https://github.com/aasis21/weft/blob/main/SECURITY.md" target="_blank" rel="noreferrer">
          Security
        </a>
        <a href="https://github.com/aasis21/weft/blob/main/SUPPORT.md" target="_blank" rel="noreferrer">
          Support
        </a>
        <a href="https://github.com/aasis21/weft/blob/main/TERMS.md" target="_blank" rel="noreferrer">
          Terms
        </a>
        <a href="https://github.com/aasis21/weft/releases" target="_blank" rel="noreferrer">
          Releases
        </a>
        <span>Apache-2.0 · PWA-first</span>
      </footer>
    </main>
  );
}

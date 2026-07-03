import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { sessionRuntime } from '@/session/runtime/instance';
import type { SessionStatus } from '@/session/model';

interface StatusBarProps {
  title: string;
  cwd: string | null;
  status: SessionStatus;
  /** True while the agent is actively working (busy). Overrides the "Live" label with "Working…". */
  busy?: boolean;
  canReconnect: boolean;
  onOpenDrawer(): void;
  onAddSession(): void;
  onStartSession?(): void;
  onReconnect(): void;
  onRemove(): void;
  onGoHome(): void;
  onOpenDebug(): void;
  onOpenSettings?(): void;
  /** Desktop (#183): the session list is already docked and always visible, so the
   *  hamburger that opens it would be redundant (and confusing — nothing "opens").
   *  Show a static Helm mark instead, linking to About Helm like a typical app logo. */
  desktopDocked?: boolean;
}

const STATUS_LABEL: Record<SessionStatus, string> = {
  initializing: 'Initializing…',
  connecting: 'Connecting…',
  live: 'Live',
  idle: 'Quiet',
  ended: 'Ended',
  error: 'Offline',
};

export function StatusBar({
  title,
  cwd,
  status,
  busy = false,
  canReconnect,
  onOpenDrawer,
  onAddSession,
  onStartSession,
  onReconnect,
  onRemove,
  onGoHome,
  onOpenDebug,
  onOpenSettings,
  desktopDocked = false,
}: StatusBarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const unreadCount = snapshot.sessions.filter((session) => session.unread && session.meta.channelId !== snapshot.activeId).length;
  const activeSession = snapshot.sessions.find((session) => session.meta.channelId === snapshot.activeId);
  // A cold (warm-pool-evicted) session has no live socket, so surface it as "Offline" rather than the
  // warm-idle "Quiet" — otherwise the header contradicts the thread's "waiting to reconnect" banner (#127).
  const activeCold = activeSession?.cold ?? false;
  // Hard invariant: the header must never read "Live"/"Quiet" while a reachability error banner is
  // shown. If the active session carries a connection error, force the "Offline" header regardless of
  // the raw status, so the pill can't contradict the banner below it (#185).
  const errored = !!activeSession?.error && status !== 'ended';
  // While the agent is working the header reads "Working…" with a live pulse, so a connected but idle
  // session ("Live") is visibly distinct from one that's actively churning a turn.
  const working = busy && status === 'live' && !errored;
  const showCold = (activeCold && status === 'idle' && !working) || errored;
  const lineClass = working ? 'busy' : showCold ? 'error' : status;
  const statusLabel = working ? 'Working…' : showCold ? 'Offline' : STATUS_LABEL[status];

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setMenuOpen(false);
        menuButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const focusMenuItem = (direction: 1 | -1): void => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
    if (!items.length) return;
    const index = items.findIndex((el) => el === document.activeElement);
    items[(index + direction + items.length) % items.length]?.focus();
  };

  const onMenuButtonKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    setMenuOpen(true);
    window.requestAnimationFrame(() => focusMenuItem(event.key === 'ArrowDown' ? 1 : -1));
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      focusMenuItem(event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  return (
    <header className="status-bar">
      {desktopDocked ? (
        <button
          className="icon-btn helm-mark-btn"
          type="button"
          onClick={onGoHome}
          title="About Helm"
          aria-label="About Helm"
        >
          <span className="helm-mark" aria-hidden="true">⎈</span>
        </button>
      ) : (
        <button
          className="icon-btn drawer-btn"
          type="button"
          onClick={onOpenDrawer}
          aria-label={unreadCount > 0 ? `Open sessions, ${unreadCount} unread` : 'Open sessions'}
        >
          <span className="hamburger" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
      )}

      <div className="status-id">
        <span className="status-title" title={cwd ?? undefined}>{title}</span>
        <span className={`status-line ${lineClass}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

      <div className="status-icons">
        <button
          className="icon-btn add-btn"
          type="button"
          onClick={onAddSession}
          aria-label="New session"
          title="Join another session"
        >
          ＋
        </button>

        <button
          className="icon-btn home-btn"
          type="button"
          onClick={onGoHome}
          aria-label="Home"
          title="Home"
        >
          ⌂
        </button>

        <button
          className="icon-btn debug-btn"
          type="button"
          onClick={onOpenDebug}
          aria-label="Debug events"
          title="Debug events"
        >
          <span className="debug-glyph" aria-hidden="true">{'{ }'}</span>
        </button>

        <div className="bar-menu-wrap" ref={menuRef}>
          <button
            className="icon-btn menu-btn"
            type="button"
            ref={menuButtonRef}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen((v) => !v)}
            onKeyDown={onMenuButtonKeyDown}
            aria-label="Session menu"
          >
            ⋯
          </button>
          {menuOpen ? (
            <div className="bar-menu" role="menu" onKeyDown={onMenuKeyDown}>
              <button
                type="button"
                role="menuitem"
                className="bar-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onAddSession();
                }}
              >
                ＋ Join another session
              </button>
              <button
                type="button"
                role="menuitem"
                className="bar-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onStartSession?.();
                }}
              >
                ▻ Start another session
              </button>
              {canReconnect ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bar-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onReconnect();
                  }}
                >
                  ↻ Reconnect
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="bar-menu-item"
                onClick={() => {
                  setMenuOpen(false);
                  onOpenSettings?.();
                }}
              >
                ⚙ Settings
              </button>
              <button
                type="button"
                role="menuitem"
                className="bar-menu-item danger"
                onClick={() => {
                  setMenuOpen(false);
                  onRemove();
                }}
              >
                ✕ Leave this session
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </header>
  );
}

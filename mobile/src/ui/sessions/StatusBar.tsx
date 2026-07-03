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
  onReconnect(): void;
  onRemove(): void;
  onGoHome(): void;
  onOpenDebug(): void;
  onOpenSettings?(): void;
}

const STATUS_LABEL: Record<SessionStatus, string> = {
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
  onReconnect,
  onRemove,
  onGoHome,
  onOpenDebug,
  onOpenSettings,
}: StatusBarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const unreadCount = snapshot.sessions.filter((session) => session.unread && session.meta.channelId !== snapshot.activeId).length;
  // While the agent is working the header reads "Working…" with a live pulse, so a connected but idle
  // session ("Live") is visibly distinct from one that's actively churning a turn.
  const working = busy && status === 'live';
  // A cold (warm-pool-evicted) session has no live socket, so surface it as "Offline" rather than the
  // warm-idle "Quiet" — otherwise the header contradicts the thread's "waiting to reconnect" banner (#127).
  const activeCold = snapshot.sessions.find((session) => session.meta.channelId === snapshot.activeId)?.cold ?? false;
  const showCold = activeCold && status === 'idle' && !working;
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

      <div className="status-id">
        <span className="status-title" title={cwd ?? undefined}>{title}</span>
        <span className={`status-line ${lineClass}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

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
    </header>
  );
}

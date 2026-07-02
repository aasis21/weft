import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { sessionRuntime } from '@/session/runtime/instance';
import type { SessionStatus } from '@/session/model';

interface StatusBarProps {
  title: string;
  cwd: string | null;
  status: SessionStatus;
  /** True while the agent is actively working (busy). Overrides the "Live" label with "Working…". */
  busy?: boolean;
  sessionCount: number;
  canReconnect: boolean;
  onOpenDrawer(): void;
  onAddSession(): void;
  onReconnect(): void;
  onRemove(): void;
  onGoHome(): void;
  onOpenDebug(): void;
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
  sessionCount,
  canReconnect,
  onOpenDrawer,
  onAddSession,
  onReconnect,
  onRemove,
  onGoHome,
  onOpenDebug,
}: StatusBarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const unreadCount = snapshot.sessions.filter((session) => session.unread && session.meta.channelId !== snapshot.activeId).length;
  // While the agent is working the header reads "Working…" with a live pulse, so a connected but idle
  // session ("Live") is visibly distinct from one that's actively churning a turn.
  const working = busy && status === 'live';
  const lineClass = working ? 'busy' : status;
  const statusLabel = working ? 'Working…' : STATUS_LABEL[status];

  useEffect(() => {
    if (!menuOpen) return undefined;
    const onDoc = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

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
        {sessionCount > 1 ? <span className="session-count">{sessionCount}</span> : null}
        {unreadCount > 0 ? <span className="unread-badge">{unreadCount}</span> : null}
      </button>

      <div className="status-id">
        <span className="status-title" title={cwd ?? undefined}>{title}</span>
        <span className={`status-line ${lineClass}`}>
          <span className="status-dot" aria-hidden="true" />
          {statusLabel}
        </span>
      </div>

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
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          aria-label="Session menu"
        >
          ⋯
        </button>
        {menuOpen ? (
          <div className="bar-menu" role="menu">
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

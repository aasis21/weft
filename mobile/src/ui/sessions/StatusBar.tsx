import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX, KeyboardEvent } from 'react';
import { sessionRuntime } from '@/session/runtime/instance';
import type { SessionStatus } from '@/session/model';
import { deriveStatus } from './sessionStatus';

interface StatusBarProps {
  title: string;
  cwd: string | null;
  status: SessionStatus;
  /** True while the agent is actively working (busy). Overrides the "Live" label with "Working…". */
  busy?: boolean;
  onOpenDrawer(): void;
  onAddSession(): void;
  onStartSession?(): void;
  /** #163: re-scan the QR / re-pair this session (opens the Join screen). Shown only when not live. */
  onRejoin?(): void;
  onReconnect(): void;
  /** #163: archive this session now (drop the live socket, keep the card). Shown only when live. */
  onArchive?(): void;
  /** Rename this session (shown in the "⋯" menu; opens an inline title editor in the header). */
  onRename?(title: string): void;
  /** Pin/unpin this session (exempt from auto-delete + eviction preference). */
  onPin?(pinned: boolean): void;
  pinned?: boolean;
  /** #163: demo sessions can't rejoin/reconnect/archive — hide those items. */
  isDemo?: boolean;
  onRemove(): void;
  onGoHome(): void;
  onOpenDebug(): void;
  /** Desktop (#183): the session list is already docked and always visible, so the
   *  hamburger that opens it would be redundant (and confusing — nothing "opens").
   *  Show a static Weft mark instead, linking to About Weft like a typical app logo. */
  desktopDocked?: boolean;
}

export function StatusBar({
  title,
  cwd,
  status,
  busy = false,
  onOpenDrawer,
  onAddSession,
  onStartSession,
  onRejoin,
  onReconnect,
  onArchive,
  onRename,
  onPin,
  pinned = false,
  isDemo = false,
  onRemove,
  onGoHome,
  onOpenDebug,
  desktopDocked = false,
}: StatusBarProps): JSX.Element {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameDraft, setRenameDraft] = useState(title);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement | null>(null);
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const unreadCount = snapshot.sessions.filter((session) => session.unread && session.meta.channelId !== snapshot.activeId).length;
  const activeSession = snapshot.sessions.find((session) => session.meta.channelId === snapshot.activeId);
  // Single source of truth for the pill (#163): the same derivation the sidebar rows use, so the
  // header can never read "Live" while a row (or the banner below) says otherwise. Splits the calm
  // "Archived" (cold, tap to reconnect) from the problem "Offline" (error, reconnect).
  const derived = deriveStatus(
    { status, cold: activeSession?.cold ?? false, error: activeSession?.error },
    { busy },
  );
  const lineClass = derived.tone;
  const statusLabel = derived.label;

  const beginRename = (): void => {
    setRenameDraft(title);
    setRenaming(true);
  };
  const commitRename = (): void => {
    const trimmed = renameDraft.trim();
    if (trimmed && trimmed !== title) onRename?.(trimmed);
    setRenaming(false);
  };
  const cancelRename = (): void => setRenaming(false);

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
          className="icon-btn weft-mark-btn"
          type="button"
          onClick={onGoHome}
          title="About Weft"
          aria-label="About Weft"
        >
          <span className="weft-mark" aria-hidden="true">⎈</span>
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
        {renaming ? (
          <input
            className="status-rename-input"
            type="text"
            value={renameDraft}
            autoFocus
            aria-label="Rename session"
            onChange={(e) => setRenameDraft(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') cancelRename();
            }}
            onBlur={commitRename}
          />
        ) : (
          <span className="status-title" title={cwd ?? undefined}>
            {pinned ? <span className="pin-mark" title="Pinned" aria-label="Pinned">📌</span> : null}
            {title}
          </span>
        )}
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
          className="icon-btn start-btn"
          type="button"
          onClick={onStartSession}
          aria-label="Start another session"
          title="Start another session"
        >
          ▻
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
              {onRename ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bar-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    beginRename();
                  }}
                >
                  ✎ Rename session
                </button>
              ) : null}
              {onPin ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bar-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onPin(!pinned);
                  }}
                >
                  📌 {pinned ? 'Unpin session' : 'Pin session'}
                </button>
              ) : null}
              {!derived.active && !isDemo ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bar-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onRejoin?.();
                  }}
                >
                  ⟲ Rejoin this session
                </button>
              ) : null}
              {!derived.active && !isDemo ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bar-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onReconnect();
                  }}
                >
                  ↻ Reconnect this session
                </button>
              ) : null}
              {derived.active && !isDemo && onArchive ? (
                <button
                  type="button"
                  role="menuitem"
                  className="bar-menu-item"
                  onClick={() => {
                    setMenuOpen(false);
                    onArchive();
                  }}
                >
                  ⏸ Archive this session
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
      </div>
    </header>
  );
}

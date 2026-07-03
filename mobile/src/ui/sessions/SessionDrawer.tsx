import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { SessionView } from '@/session/view';

interface SessionDrawerProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(channelId: string): void;
  onAddSession(): void;
  onStartSession?(): void;
  onRemove(channelId: string): void;
  onRename?(channelId: string, title: string): void;
  onGoHome(): void;
  onOpenSettings?(): void;
  onClose(): void;
  /** Desktop: render docked inline in the layout (no scrim, no modal focus-trap/autofocus,
   *  no slide-in animation) instead of as a mobile overlay. onClose still fires — the
   *  caller decides what it means (e.g. collapse the rail vs. dismiss the overlay). */
  docked?: boolean;
}

function fmtRelative(ts: number | null): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function lastActivity(session: SessionView): number | null {
  const items = session.timeline.items;
  let lastRealTs = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item && (item.kind === 'user' || item.kind === 'assistant' || item.kind === 'tool')) {
      lastRealTs = item.ts;
      break;
    }
  }
  return Math.max(lastRealTs, session.lastEventAt ?? 0) || null;
}

function turnCount(session: SessionView): number {
  return session.timeline.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').length;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isFocusable(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.getClientRects().length > 0;
}

export function SessionDrawer({
  sessions,
  activeId,
  onSelect,
  onAddSession,
  onStartSession,
  onRemove,
  onRename,
  onGoHome,
  onOpenSettings,
  onClose,
  docked = false,
}: SessionDrawerProps): JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  onCloseRef.current = onClose;

  const beginRename = (id: string, current: string): void => {
    setEditingId(id);
    setDraft(current);
  };
  const commitRename = (id: string): void => {
    onRename?.(id, draft);
    setEditingId(null);
  };
  const cancelRename = (): void => setEditingId(null);

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? sessions.filter((session) => {
          const title = session.meta.title.toLowerCase();
          const cwd = session.meta.cwd?.toLowerCase() ?? '';
          return title.includes(q) || cwd.includes(q);
        })
      : sessions;
    // STABLE order by when each session's QR was last scanned — deliberately NOT by last activity, so
    // incoming events/heartbeats never reshuffle the list under the user. A re-scan bumps scannedAt so
    // that card jumps to the top. Fall back to addedAt for legacy/demo cards without a scan time.
    const scannedAt = (s: SessionView): number => s.meta.scannedAt ?? s.meta.addedAt ?? 0;
    return [...matched].sort((a, b) => scannedAt(b) - scannedAt(a));
  }, [query, sessions]);

  useEffect(() => {
    // Docked (desktop, always-visible) sidebar is not a modal: it must not steal focus on
    // every render or trap Tab globally — that would fight the user typing in the composer.
    if (docked) return undefined;

    const drawer = drawerRef.current;
    const activeElement = document.activeElement;
    triggerRef.current = activeElement instanceof HTMLElement ? activeElement : null;

    const getFocusableElements = (): HTMLElement[] => {
      if (!drawerRef.current) return [];
      return Array.from(drawerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }

      if (event.key !== 'Tab' || !drawerRef.current) return;

      const focusableElements = getFocusableElements();
      if (focusableElements.length === 0) {
        event.preventDefault();
        drawerRef.current.focus();
        return;
      }

      const first = focusableElements[0];
      const last = focusableElements[focusableElements.length - 1];
      const active = document.activeElement;
      if (!first || !last) return;

      if (!drawerRef.current.contains(active)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    const focusableElements = getFocusableElements();
    if (focusableElements.length > 0) {
      focusableElements[0]?.focus();
    } else {
      drawer?.focus();
    }

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger) && isFocusable(trigger)) {
        trigger.focus();
      }
    };
  }, [docked]);

  return (
    <>
      <aside
        ref={drawerRef}
        className={docked ? 'drawer drawer-docked' : 'drawer'}
        {...(docked ? {} : { role: 'dialog', 'aria-modal': true })}
        aria-label="Sessions"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span className="drawer-title">SESSIONS</span>
          <button className="icon-btn" type="button" onClick={onAddSession} title="Join another session">
            ＋
          </button>
          <button className="icon-btn" type="button" onClick={onClose} title={docked ? 'Collapse sidebar' : 'Close'}>
            {docked ? '⟨' : '✕'}
          </button>
        </div>

        <input
          className="drawer-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="Filter sessions"
          placeholder="Filter sessions"
        />

        <div className="drawer-list">
          {sessions.length === 0 ? (
            <p className="drawer-empty">No sessions joined yet.</p>
          ) : filteredSessions.length === 0 ? (
            <p className="drawer-empty">No matches.</p>
          ) : (
            filteredSessions.map((session) => {
              const id = session.meta.channelId;
              const isActive = id === activeId;
              const pending = session.timeline.approvals.length;
              const activity = lastActivity(session);
              return (
                <div
                  key={id}
                  className={`session-row ${isActive ? 'current' : ''} ${session.unread && !isActive ? 'unread' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onSelect(id);
                    if (e.key === ' ' || e.key === 'Spacebar') {
                      e.preventDefault();
                      onSelect(id);
                    }
                  }}
                >
                  <span
                    className={`unread-dot ${session.unread && !isActive ? 'on' : ''}`}
                    aria-label={session.unread && !isActive ? 'Unread activity' : undefined}
                  />
                  <span className="session-info">
                    <span className="session-title">
                      {editingId === id ? (
                        <input
                          className="session-rename-input"
                          type="text"
                          value={draft}
                          autoFocus
                          aria-label="Rename session"
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => setDraft(e.target.value)}
                          onKeyDown={(e) => {
                            e.stopPropagation();
                            if (e.key === 'Enter') commitRename(id);
                            if (e.key === 'Escape') cancelRename();
                          }}
                          onBlur={() => commitRename(id)}
                        />
                      ) : (
                        <>
                          {session.meta.title}
                          {session.meta.kind === 'demo' ? <span className="tag demo">demo</span> : null}
                          {pending > 0 ? <span className="tag alert">{pending} approval</span> : null}
                        </>
                      )}
                    </span>
                    <span className="session-sub">
                      {turnCount(session)} msg
                      {!isActive && (session.unreadCount ?? 0) > 0 ? (
                        <span className="unread-new">{` · ${session.unreadCount} new`}</span>
                      ) : null}
                      {activity ? ` · ${fmtRelative(activity)}` : ''}
                      {session.meta.cwd ? ` · ${session.meta.cwd.split(/[\\/]/).pop()}` : ''}
                    </span>
                  </span>
                  {session.meta.kind !== 'demo' && editingId !== id ? (
                    <button
                      className="icon-btn row-rename"
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        beginRename(id, session.meta.title);
                      }}
                      title="Rename session"
                      aria-label="Rename session"
                    >
                      ✎
                    </button>
                  ) : null}
                  <button
                    className="icon-btn row-x"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(id);
                    }}
                    title="Leave session"
                  >
                    ✕
                  </button>
                </div>
              );
            })
          )}
        </div>

        <button className="drawer-add" type="button" onClick={onAddSession}>
          ＋ Join another Copilot session
        </button>

        <button className="drawer-add" type="button" onClick={onStartSession}>
          ▻ Start another Copilot session
        </button>

        <button className="drawer-home" type="button" onClick={onGoHome}>
          ⌂ About Helm
        </button>
        {onOpenSettings ? (
          <button className="drawer-home" type="button" onClick={onOpenSettings}>
            ⚙ Settings
          </button>
        ) : null}
      </aside>
      {docked ? null : <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />}
    </>
  );
}

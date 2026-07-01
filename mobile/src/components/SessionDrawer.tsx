import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { SessionView } from '../lib/sessionManager';

interface SessionDrawerProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(channelId: string): void;
  onAddSession(): void;
  onRemove(channelId: string): void;
  onClose(): void;
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
  const lastTs = items.length > 0 ? items[items.length - 1].ts : null;
  return Math.max(lastTs ?? 0, session.timeline.lastHeartbeat ?? 0) || null;
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
  onRemove,
  onClose,
}: SessionDrawerProps): JSX.Element {
  const drawerRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const [query, setQuery] = useState('');
  onCloseRef.current = onClose;

  const filteredSessions = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((session) => {
      const title = session.meta.title.toLowerCase();
      const cwd = session.meta.cwd?.toLowerCase() ?? '';
      return title.includes(q) || cwd.includes(q);
    });
  }, [query, sessions]);

  useEffect(() => {
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
      focusableElements[0].focus();
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
  }, []);

  return (
    <>
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Sessions"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="drawer-head">
          <span className="drawer-title">SESSIONS</span>
          <button className="icon-btn" type="button" onClick={onAddSession} title="Join another session">
            ＋
          </button>
          <button className="icon-btn" type="button" onClick={onClose} title="Close">
            ✕
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
              return (
                <div
                  key={id}
                  className={`session-row ${isActive ? 'current' : ''}`}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') onSelect(id);
                  }}
                >
                  <span className={`status-dot ${session.status}`} aria-hidden="true" />
                  {session.unread && !isActive ? <span className="unread-dot" aria-hidden="true" /> : null}
                  <span className="session-info">
                    <span className="session-title">
                      {session.meta.title}
                      {session.meta.kind === 'demo' ? <span className="tag demo">demo</span> : null}
                      {pending > 0 ? <span className="tag alert">{pending} approval</span> : null}
                    </span>
                    <span className="session-sub">
                      {turnCount(session)} msg
                      {lastActivity(session) ? ` · ${fmtRelative(lastActivity(session))}` : ''}
                      {session.meta.cwd ? ` · ${session.meta.cwd.split(/[\\/]/).pop()}` : ''}
                    </span>
                  </span>
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
      </aside>
      <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />
    </>
  );
}

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { deriveStatus } from './sessionStatus';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';
import { DeviceAvatar } from '@/ui/screens/deviceGlyphs';

interface SessionDrawerProps {
  sessions: SessionView[];
  activeId: string | null;
  onSelect(channelId: string): void;
  onAddSession(): void;
  onStartSession?(): void;
  onOpenDevices?(): void;
  /** #186 nav simplification: registered listener devices, shown as a compact group at the top
   *  of the drawer so picking one to start a session on never needs a separate screen. */
  devices?: ListenerDeviceState[];
  /** Tapping a device row (the common case) starts a new session on it directly. */
  onStartOnDevice?(channelId: string): void;
  onRemove(channelId: string): void;
  onRename?(channelId: string, title: string): void;
  /** #163: pin/unpin a session (exempt from auto-delete + eviction preference). */
  onPin?(channelId: string, pinned: boolean): void;
  /** #163: manually archive (drop the live socket now, keep the card). */
  onArchive?(channelId: string): void;
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
  onOpenDevices,
  devices,
  onStartOnDevice,
  onRemove,
  onRename,
  onPin,
  onArchive,
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

  // #163: split the (already stably-sorted) list into Active vs Archived using the shared status
  // derivation, so the sidebar mirrors the detail-header pill exactly. Search filters both groups.
  const { activeGroup, archivedGroup } = useMemo(() => {
    const activeGroup: SessionView[] = [];
    const archivedGroup: SessionView[] = [];
    for (const s of filteredSessions) {
      (deriveStatus(s).active ? activeGroup : archivedGroup).push(s);
    }
    return { activeGroup, archivedGroup };
  }, [filteredSessions]);

  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  useEffect(() => {
    // Docked (desktop, always-visible) sidebar is not a modal: it must not steal focus on
    // every render or trap Tab globally — that would fight the user typing in the composer.
    // It still supports Escape-to-collapse, but only when focus is inside the sidebar itself
    // (so Escape typed elsewhere, e.g. in the composer, doesn't unexpectedly collapse it).
    if (docked) {
      const handleDockedKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== 'Escape') return;
        if (!drawerRef.current?.contains(document.activeElement)) return;
        onCloseRef.current();
      };
      document.addEventListener('keydown', handleDockedKeyDown);
      return () => document.removeEventListener('keydown', handleDockedKeyDown);
    }

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

  const renderDeviceRow = (device: ListenerDeviceState): JSX.Element => {
    const status = deviceStatus(device);
    const lastSeen = formatLastSeen(device.lastSeenAt);
    const projectsLabel = device.projectsLoading
      ? 'Loading projects…'
      : device.projects.length > 0
        ? `${device.projects.length} project${device.projects.length === 1 ? '' : 's'}`
        : 'No projects yet';
    return (
      <div
        key={device.channelId}
        className="session-row device-drawer-row"
        role="button"
        tabIndex={0}
        aria-label={`Start session on ${deviceLabel(device)}`}
        onClick={() => onStartOnDevice?.(device.channelId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onStartOnDevice?.(device.channelId);
          if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            onStartOnDevice?.(device.channelId);
          }
        }}
      >
        <DeviceAvatar tone={status.tone} />
        <span className="session-info">
          <span className="session-title">
            {deviceLabel(device)}
            {device.isDefault ? <span className="tag">default</span> : null}
          </span>
          <span className="session-sub">
            {status.label}
            {lastSeen ? ` · ${lastSeen}` : ''}
            {` · ${projectsLabel}`}
          </span>
        </span>
        <button
          className="icon-btn row-actions"
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onStartOnDevice?.(device.channelId);
          }}
          title="Start session"
          aria-label={`Start session on ${deviceLabel(device)}`}
        >
          ▻
        </button>
      </div>
    );
  };

  const renderRow = (session: SessionView): JSX.Element => {
    const id = session.meta.channelId;
    const isActive = id === activeId;
    const pending = session.timeline.approvals.length;
    const activity = lastActivity(session);
    const derived = deriveStatus(session);
    const isDemo = session.meta.kind === 'demo';
    const confirming = confirmDeleteId === id;
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
                {session.pinned ? <span className="pin-mark" title="Pinned" aria-label="Pinned">📌</span> : null}
                {session.meta.title}
                {isDemo ? <span className="tag demo">demo</span> : null}
                {pending > 0 ? <span className="tag alert">{pending} approval</span> : null}
              </>
            )}
          </span>
          <span className="session-sub">
            <span className={`session-pill ${derived.tone}`}>
              <span className="pill-dot" aria-hidden="true" />
              {derived.label}
            </span>
            {` · ${turnCount(session)} msg`}
            {!isActive && (session.unreadCount ?? 0) > 0 ? (
              <span className="unread-new">{` · ${session.unreadCount} new`}</span>
            ) : null}
            {activity ? ` · ${fmtRelative(activity)}` : ''}
            {session.meta.cwd ? ` · ${session.meta.cwd.split(/[\\/]/).pop()}` : ''}
          </span>
        </span>
        {confirming ? (
          <span className="row-confirm" onClick={(e) => e.stopPropagation()}>
            <span className="row-confirm-label">Delete?</span>
            <button
              className="icon-btn row-confirm-yes"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDeleteId(null);
                onRemove(id);
              }}
              title="Confirm delete"
              aria-label="Confirm delete session"
            >
              ✓
            </button>
            <button
              className="icon-btn row-confirm-no"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setConfirmDeleteId(null);
              }}
              title="Cancel"
              aria-label="Cancel delete"
            >
              ✕
            </button>
          </span>
        ) : editingId === id ? null : (
          <span className="row-actions" onClick={(e) => e.stopPropagation()}>
            {!isDemo && onPin ? (
              <button
                className={`icon-btn row-pin ${session.pinned ? 'on' : ''}`}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onPin(id, !session.pinned);
                }}
                title={session.pinned ? 'Unpin' : 'Pin (keep, never auto-delete)'}
                aria-label={session.pinned ? 'Unpin session' : 'Pin session'}
                aria-pressed={session.pinned ?? false}
              >
                📌
              </button>
            ) : null}
            {!isDemo && onArchive && derived.active ? (
              <button
                className="icon-btn row-archive"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onArchive(id);
                }}
                title="Archive now (drop the live connection)"
                aria-label="Archive session now"
              >
                ⏸
              </button>
            ) : null}
            {!isDemo ? (
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
                setConfirmDeleteId(id);
              }}
              title="Delete session"
              aria-label="Delete session"
            >
              🗑
            </button>
          </span>
        )}
      </div>
    );
  };

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
          {devices && devices.length > 0 ? (
            <>
              <div className="drawer-group-head">
                Devices <span className="drawer-group-count">{devices.length}</span>
              </div>
              {sortDevices(devices).map(renderDeviceRow)}
            </>
          ) : null}
          {sessions.length === 0 ? (
            <p className="drawer-empty">No sessions joined yet.</p>
          ) : filteredSessions.length === 0 ? (
            <p className="drawer-empty">No matches.</p>
          ) : (
            <>
              {activeGroup.length > 0 ? (
                <div className="drawer-group-head">
                  Active <span className="drawer-group-count">{activeGroup.length}</span>
                </div>
              ) : null}
              {activeGroup.map(renderRow)}
              {archivedGroup.length > 0 ? (
                <div className="drawer-group-head">
                  Archived <span className="drawer-group-count">{archivedGroup.length}</span>
                </div>
              ) : null}
              {archivedGroup.map(renderRow)}
            </>
          )}
        </div>

        <button className="drawer-add" type="button" onClick={onAddSession}>
          ＋ Join another Copilot session
        </button>

        <button className="drawer-add" type="button" onClick={onStartSession}>
          ▻ Start another Copilot session
        </button>

        {onOpenDevices ? (
          <button className="drawer-home" type="button" onClick={onOpenDevices}>
            🖥 Manage devices
          </button>
        ) : null}

        {onOpenSettings ? (
          <button className="drawer-home" type="button" onClick={onOpenSettings}>
            ⚙ Settings
          </button>
        ) : null}

        <button className="drawer-home" type="button" onClick={onGoHome}>
          ⌂ About Helm
        </button>
      </aside>
      {docked ? null : <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />}
    </>
  );
}

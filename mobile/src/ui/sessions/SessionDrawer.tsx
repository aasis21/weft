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
  /** Tapping the device's avatar/name (not the row's ▻ start button) navigates to its detail
   *  page instead of starting a session. Falls back to onStartOnDevice if not provided. */
  onOpenDeviceDetails?(channelId: string): void;
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
  // Phone-domain only. `lastEventAt` is stamped on the phone as events arrive; timeline `item.ts`
  // is the LAPTOP's clock, and feeding it to a `Date.now() - ts` age would misreport "N ago" (even
  // negative "in the future") under cross-clock skew. Fall back to scan/add time (also phone-domain).
  return session.lastEventAt ?? session.meta.scannedAt ?? session.meta.addedAt ?? null;
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
  onOpenDeviceDetails,
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
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  onCloseRef.current = onClose;

  // Row actions are collapsed behind a "⋮" menu (pin/archive/rename); only delete stays as a
  // direct "✕" icon on the row. Close that menu on any click outside a row's menu wrapper.
  useEffect(() => {
    if (!openMenuId) return;
    const handleDocClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.row-menu-wrap')) return;
      setOpenMenuId(null);
    };
    document.addEventListener('click', handleDocClick);
    return () => document.removeEventListener('click', handleDocClick);
  }, [openMenuId]);

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
    // Filter search box removed for now (#see chat request) — sidebar just shows all sessions,
    // stably ordered by when each session's QR was last scanned. Deliberately NOT by last
    // activity, so incoming events/heartbeats never reshuffle the list under the user. A
    // re-scan bumps scannedAt so that card jumps to the top. Fall back to addedAt for
    // legacy/demo cards without a scan time.
    const scannedAt = (s: SessionView): number => s.meta.scannedAt ?? s.meta.addedAt ?? 0;
    return [...sessions].sort((a, b) => scannedAt(b) - scannedAt(a));
  }, [sessions]);

  // #163: split the (already stably-sorted) list into Active vs Archived using the shared status
  // derivation, so the sidebar mirrors the detail-header pill exactly.
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
    // Three clocks (now / last connected / last tried): show when we last SUCCEEDED (lastSeenAt),
    // and — while not Online — when we last TRIED (lastAttemptAt), so a laptop that isn't answering
    // reads "Offline · last seen 2h ago · tried 5s ago" rather than a bare, ambiguous "Offline".
    const lastSeen = formatLastSeen(device.lastSeenAt);
    const lastTried = !device.connected ? formatLastSeen(device.lastAttemptAt) : null;
    const projectsLabel = device.projectsLoading
      ? 'Loading projects…'
      : device.projects.length > 0
        ? `${device.projects.length} project${device.projects.length === 1 ? '' : 's'}`
        : 'No projects yet';
    const openDetails = (): void =>
      onOpenDeviceDetails ? onOpenDeviceDetails(device.channelId) : onStartOnDevice?.(device.channelId);
    return (
      <div
        key={device.channelId}
        className="session-row device-drawer-row"
        role="button"
        tabIndex={0}
        aria-label={`View details for ${deviceLabel(device)}`}
        onClick={openDetails}
        onKeyDown={(e) => {
          if (e.key === 'Enter') openDetails();
          if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            openDetails();
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
            {lastSeen ? ` · seen ${lastSeen}` : ''}
            {lastTried ? ` · tried ${lastTried}` : ''}
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
            {!isDemo ? (
              <span className="row-menu-wrap">
                <button
                  className="icon-btn row-menu-btn"
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setOpenMenuId(openMenuId === id ? null : id);
                  }}
                  title="More actions"
                  aria-label="More actions"
                  aria-haspopup="menu"
                  aria-expanded={openMenuId === id}
                >
                  ⋮
                </button>
                {openMenuId === id ? (
                  <div className="row-menu-dropdown" role="menu">
                    {onPin ? (
                      <button
                        className="row-menu-item"
                        type="button"
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation();
                          onPin(id, !session.pinned);
                          setOpenMenuId(null);
                        }}
                        aria-label={session.pinned ? 'Unpin session' : 'Pin session'}
                      >
                        📌 {session.pinned ? 'Unpin' : 'Pin'}
                      </button>
                    ) : null}
                    {onArchive && derived.active ? (
                      <button
                        className="row-menu-item"
                        type="button"
                        role="menuitem"
                        onClick={(e) => {
                          e.stopPropagation();
                          onArchive(id);
                          setOpenMenuId(null);
                        }}
                        aria-label="Archive session now"
                      >
                        ⏸ Archive now
                      </button>
                    ) : null}
                    <button
                      className="row-menu-item"
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpenMenuId(null);
                        beginRename(id, session.meta.title);
                      }}
                      aria-label="Rename session"
                    >
                      ✎ Rename
                    </button>
                  </div>
                ) : null}
              </span>
            ) : null}
            <button
              className="icon-btn row-x"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setOpenMenuId(null);
                setConfirmDeleteId(id);
              }}
              title="Delete session"
              aria-label="Delete session"
            >
              ✕
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
        </div>
        <button
          className="drawer-close"
          type="button"
          onClick={onClose}
          title={docked ? 'Collapse sidebar' : 'Close'}
        >
          {docked ? '⟨' : '✕'}
        </button>

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
          ⌂ About Weft
        </button>
      </aside>
      {docked ? null : <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />}
    </>
  );
}

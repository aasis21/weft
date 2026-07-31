import { useEffect, useRef, useState } from 'react';
import type { JSX, TouchEvent as ReactTouchEvent } from 'react';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { deviceLabel, deviceStatus, formatLastSeen } from '@/ui/screens/deviceDisplay';
import {
  BackGlyph,
  BracesGlyph,
  ChevronGlyph,
  DeviceAvatar,
  FolderGlyph,
  MoreHorizontalGlyph,
  PencilGlyph,
  PlayGlyph,
  RefreshGlyph,
  ResumeGlyph,
  StarGlyph,
  TrashGlyph,
  WarningGlyph,
} from '@/ui/screens/deviceGlyphs';
import { DebugPanel } from '@/ui/diagnostics/DebugPanel';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
import { SettingsScreen } from '@/ui/settings/SettingsScreen';
import { deriveStatus } from '@/ui/sessions/sessionStatus';
import { transportIdentity } from '@aasis21/weft-shared';
import { useNowTick } from '@/ui/hooks/useNowTick';

interface DeviceDetailsScreenProps {
  device: ListenerDeviceState;
  activeId: string | null;
  /** Every session in the app; filtered here to the ones this device spawned. */
  sessions: SessionView[];
  /** Every registered listener device, so the sidebar's "Devices" group stays visible here too. */
  devices: ListenerDeviceState[];
  onRefreshProjects(channelId: string): void;
  /** Open the start screen on its Resume tab for this device. The resumable-session list lives
   *  there, next to the folder picker and permission toggle it shares with starting a new one —
   *  this screen is device administration, not a second place to launch sessions from. */
  onResumeOnDevice(channelId: string): void;
  onSetDefault(channelId: string): Promise<void>;
  onForget(channelId: string): Promise<void>;
  onStartOnDevice(channelId: string): void;
  onOpenDeviceDetails?(channelId: string): void;
  onJoinOffer(deviceChannelId: string, offerChannelId: string): void;
  onOpenSession(channelId: string): void;
  onSelectSession(channelId: string): void;
  onAddSession(): void;
  onStartSession(): void;
  onOpenDevices(): void;
  onRemoveSession(channelId: string): void;
  onRenameSession(channelId: string, title: string): void;
  onGoHome(): void;
}

/**
 * Device details (#device-events): the full record for ONE registered listener — its live status,
 * its stable identifiers (deviceId survives `weft start` restarts; channelId is the current
 * pairing channel, freshly minted every run), a "Sessions from this device" list (every session
 * ever spawned here via "Start session", matched by the listener's stable deviceId), and the raw
 * DEVICE-channel event log (project list / spawn / forget — reuses the same DebugPanel component
 * the per-session debug view uses). Reached from a device row on DevicesScreen.
 *
 * Navigation: the header keeps the same leading hamburger as every other screen so the top row
 * lines up pixel-for-pixel with the chat view; "back to the device list" is a separate breadcrumb
 * on the first body row rather than a fourth header control.
 *
 * The header's trailing control is a "⋯" overflow (same menu vocabulary as the device tiles on
 * DevicesScreen) holding the administrative actions — refresh, make default, event log, forget.
 * Only the two things you actually came here to do, Start and Resume, stay as first-class buttons.
 */
function folderName(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

export function DeviceDetailsScreen({
  device,
  activeId,
  sessions,
  devices,
  onRefreshProjects,
  onResumeOnDevice,
  onSetDefault,
  onForget,
  onStartOnDevice,
  onOpenDeviceDetails,
  onJoinOffer,
  onOpenSession,
  onSelectSession,
  onAddSession,
  onStartSession,
  onOpenDevices,
  onRemoveSession,
  onRenameSession,
  onGoHome,
}: DeviceDetailsScreenProps): JSX.Element {
  const [logOpen, setLogOpen] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  // Forget is destructive and irreversible from here, so the menu item flips into a confirm state
  // in place rather than firing on first tap.
  const [confirmForget, setConfirmForget] = useState(false);
  // #ui: the inactive bucket starts collapsed so the list opens on what's still running.
  const [inactiveOpen, setInactiveOpen] = useState(false);
  // #ui: swipe-to-reveal row actions, mirroring WeftDrawer's session rows. One row at a time.
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const touchRef = useRef<{ id: string; startX: number; startY: number; dx: number; swiping: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const now = useNowTick();
  const status = deviceStatus(device);
  const lastSeen = formatLastSeen(device.lastSeenAt, now);
  const deviceKey = device.deviceId ?? device.channelId;
  const spawnedSessions = sessions
    .filter((s) => (s.meta.spawnedFromDeviceId ?? '') === deviceKey)
    .sort((a, b) => (b.lastEventAt ?? b.meta.addedAt) - (a.lastEventAt ?? a.meta.addedAt));
  const rows = spawnedSessions.map((session) => ({
    session,
    derived: deriveStatus(session, { busy: session.timeline.busy }),
  }));
  const activeRows = rows.filter((r) => r.derived.active);
  const inactiveRows = rows.filter((r) => !r.derived.active);
  // Sessions this laptop opened `/weft` in and is offering for one-tap adoption. Hide any whose
  // channel we already track (already joined) so a lingering offer can't show a duplicate row.
  const tracked = new Set(sessions.map((s) => s.meta.channelId));
  const offers = (device.offers ?? []).filter((o) => o && o.channelId && !tracked.has(o.channelId));
  const online = device.connected;

  const closeMenu = (returnFocus: boolean): void => {
    setMenuOpen(false);
    setConfirmForget(false);
    if (returnFocus) menuTriggerRef.current?.focus();
  };

  useEffect(() => {
    if (!menuOpen) return;
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target?.closest('.device-menu-wrap')) return;
      closeMenu(false);
    };
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMenu(true);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen]);

  // #ui: a mostly-horizontal drag past the threshold opens (left) or closes (right) a row's action
  // strip; a plain tap still opens the session.
  const onRowTouchStart = (id: string) => (e: ReactTouchEvent): void => {
    const t = e.touches[0];
    if (!t) return;
    touchRef.current = { id, startX: t.clientX, startY: t.clientY, dx: 0, swiping: false };
  };
  const onRowTouchMove = (e: ReactTouchEvent): void => {
    const s = touchRef.current;
    const t = e.touches[0];
    if (!s || !t) return;
    const dx = t.clientX - s.startX;
    const dy = t.clientY - s.startY;
    if (!s.swiping && Math.abs(dx) > 8 && Math.abs(dx) > Math.abs(dy)) s.swiping = true;
    s.dx = dx;
  };
  const onRowTouchEnd = (id: string) => (): void => {
    const s = touchRef.current;
    touchRef.current = null;
    if (!s || !s.swiping) return;
    // A real swipe fires a synthetic click afterwards on most browsers — swallow it so the row
    // doesn't also get opened.
    suppressClickRef.current = true;
    if (s.dx < -40) setSwipedId(id);
    else if (s.dx > 40) setSwipedId((cur) => (cur === id ? null : cur));
  };

  const renderSessionRow = ({ session, derived }: (typeof rows)[number]): JSX.Element => {
    const id = session.meta.channelId;
    const folder = folderName(session.meta.cwd);
    const age = formatLastSeen(session.lastEventAt ?? session.meta.addedAt, now);
    const swiped = swipedId === id;
    return (
      <li key={id} className={`device-session-row ${swiped ? 'row-swipe-open' : ''}`}>
        {swiped ? (
          <span className="row-swipe-actions" onClick={(e) => e.stopPropagation()}>
            <button
              className="row-swipe-btn"
              type="button"
              aria-label={`Rename ${session.meta.title}`}
              title="Rename"
              onClick={(e) => {
                e.stopPropagation();
                setSwipedId(null);
                const next = window.prompt('Rename session', session.meta.title);
                if (next && next.trim()) onRenameSession(id, next.trim());
              }}
            >
              <PencilGlyph />
            </button>
            <button
              className="row-swipe-btn danger"
              type="button"
              aria-label={`Remove ${session.meta.title}`}
              title="Remove"
              onClick={(e) => {
                e.stopPropagation();
                setSwipedId(null);
                onRemoveSession(id);
              }}
            >
              <TrashGlyph />
            </button>
          </span>
        ) : null}
        <button
          type="button"
          className="device-session-open"
          onTouchStart={onRowTouchStart(id)}
          onTouchMove={onRowTouchMove}
          onTouchEnd={onRowTouchEnd(id)}
          onClick={() => {
            if (suppressClickRef.current) {
              suppressClickRef.current = false;
              return;
            }
            if (swiped) {
              setSwipedId(null);
              return;
            }
            onOpenSession(id);
          }}
        >
          <span className={`status-dot ${derived.tone}`} aria-hidden="true" />
          <span className="device-session-text">
            <span className="device-card-name">{session.meta.title}</span>
            <span className="device-session-meta">
              {derived.label}
              {folder ? ` · ${folder}` : ''}
              {age ? ` · ${age}` : ''}
            </span>
          </span>
        </button>
      </li>
    );
  };

  return (
    <main className="weft-session join-session device-details-screen">
      <header className="status-bar">
        <button
          className="icon-btn drawer-btn"
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open sessions"
        >
          <span className="hamburger" aria-hidden="true">
            <span />
            <span />
            <span />
          </span>
        </button>
        <DeviceAvatar tone={status.tone} />
        <div className="status-id">
          <span className="status-title" title={deviceLabel(device)}>
            {deviceLabel(device)}
            {device.isDefault ? <span className="tag">default</span> : null}
          </span>
          <span className={`device-status device-status-${status.tone}`}>
            <span className="device-status-dot" aria-hidden="true" />
            <span>{status.label}</span>
            {lastSeen ? <span className="device-status-seen">· last seen {lastSeen}</span> : null}
          </span>
        </div>
        <div className="status-icons">
          <div className="device-menu-wrap">
            <button
              ref={menuTriggerRef}
              className="icon-btn device-menu-btn"
              type="button"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              aria-label={`Device actions for ${deviceLabel(device)}`}
              onClick={() => (menuOpen ? closeMenu(false) : setMenuOpen(true))}
            >
              <MoreHorizontalGlyph />
            </button>
            {menuOpen ? (
              <div ref={menuRef} className="device-menu device-menu-down" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="device-menu-item"
                  onClick={() => {
                    closeMenu(false);
                    onOpenDevices();
                  }}
                >
                  <span className="device-action-icon" aria-hidden="true"><BackGlyph /></span>
                  Devices
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="device-menu-item"
                  onClick={() => {
                    closeMenu(false);
                    onRefreshProjects(device.channelId);
                  }}
                >
                  <span className="device-action-icon" aria-hidden="true"><RefreshGlyph /></span>
                  Refresh projects
                </button>
                {!device.isDefault ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="device-menu-item"
                    onClick={() => {
                      closeMenu(false);
                      void onSetDefault(device.channelId);
                    }}
                  >
                    <span className="device-action-icon" aria-hidden="true"><StarGlyph /></span>
                    Make default
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="device-menu-item"
                  onClick={() => {
                    closeMenu(false);
                    setLogOpen(true);
                  }}
                >
                  <span className="device-action-icon" aria-hidden="true"><BracesGlyph /></span>
                  Event log
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="device-menu-item danger"
                  onClick={() => {
                    if (!confirmForget) {
                      setConfirmForget(true);
                      return;
                    }
                    closeMenu(false);
                    void onForget(device.channelId);
                  }}
                >
                  <span className="device-action-icon" aria-hidden="true"><TrashGlyph /></span>
                  {confirmForget ? 'Tap again to forget' : 'Forget device'}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>

      <div className="session-join-inner">
        {device.error ? <p className="error-banner">{device.error}</p> : null}

        {/* Start and Resume are why you came here, so they sit directly under the header rather
            than buried at the bottom of a Projects card — the project list is context for them,
            not a step before them. */}
        {online ? (
          <div className="device-actions device-actions-lead">
            <button
              type="button"
              className="session-primary-action device-start-btn"
              onClick={() => onStartOnDevice(device.channelId)}
            >
              <span className="device-action-icon" aria-hidden="true"><PlayGlyph /></span>
              Start
            </button>
            <button
              type="button"
              className="session-secondary-action device-resume-btn"
              onClick={() => onResumeOnDevice(device.channelId)}
            >
              <span className="device-action-icon" aria-hidden="true"><ResumeGlyph /></span>
              Resume
            </button>
          </div>
        ) : (
          // Offline: the old UI disabled both buttons and explained why in a `title` tooltip,
          // which is invisible on touch. Say it inline instead.
          <p className="device-offline-note">
            <span className="device-action-icon" aria-hidden="true"><WarningGlyph /></span>
            <span>
              Offline — run <code>weft start</code> on this laptop to start or resume sessions.
            </span>
          </p>
        )}

        {offers.length > 0 ? (
          <section className="session-join-fallback device-offers">
            <h3>Offered sessions</h3>
            <p className="device-card-sub">
              Sessions this laptop opened with <code>/weft</code> — tap to join, no QR needed.
            </p>
            <ul className="device-sessions-list">
              {offers.map((offer) => (
                <li key={offer.channelId} className="device-session-row">
                  <button
                    type="button"
                    className="device-session-open"
                    onClick={() => onJoinOffer(device.channelId, offer.channelId)}
                  >
                    <span className="status-dot listening" aria-hidden="true" />
                    <span className="device-session-text">
                      <span className="device-card-name">{offer.name || offer.cwd || 'Copilot session'}</span>
                      {offer.cwd && offer.name ? (
                        <span className="device-session-meta">{offer.cwd}</span>
                      ) : null}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="session-join-fallback device-card">
          <h3 className="device-section-label">Projects</h3>
          {device.projectsLoading ? (
            <p className="device-card-sub">{online ? 'Refreshing projects…' : 'Loading projects…'}</p>
          ) : device.projects.length > 0 ? (
            <ul className="device-project-chips">
              {device.projects.map((project) => (
                <li key={project.path ?? project.name} className="device-project-chip" title={project.path ?? project.name}>
                  <FolderGlyph />
                  {project.name}
                </li>
              ))}
            </ul>
          ) : (
            <p className="device-card-sub">No projects received yet.</p>
          )}
        </section>

        <section className="session-join-fallback device-sessions">
          <h3 className="device-section-label">Active{activeRows.length > 0 ? ` (${activeRows.length})` : ''}</h3>
          {activeRows.length === 0 ? (
            <p className="device-card-sub">
              {rows.length === 0 ? 'No sessions started on this device yet.' : 'Nothing running right now.'}
            </p>
          ) : (
            <ul className="device-sessions-list">{activeRows.map(renderSessionRow)}</ul>
          )}

          {inactiveRows.length > 0 ? (
            <>
              <button
                type="button"
                className={`device-group-toggle ${inactiveOpen ? 'open' : ''}`}
                aria-expanded={inactiveOpen}
                onClick={() => setInactiveOpen((v) => !v)}
              >
                <ChevronGlyph />
                Inactive ({inactiveRows.length})
              </button>
              {inactiveOpen ? (
                <ul className="device-sessions-list">{inactiveRows.map(renderSessionRow)}</ul>
              ) : null}
            </>
          ) : null}
        </section>
      </div>

      {logOpen ? (
        <DebugPanel
          events={device.events}
          title={deviceLabel(device)}
          identifiers={{
            rows: [
              { label: 'Device ID', value: device.deviceId ?? '—' },
              { label: 'Latest channel ID', value: device.channelId },
              { label: 'Transport', value: transportIdentity(device.transport).label },
            ],
            note:
              'Device ID is stable across weft start restarts; the channel ID is a fresh pairing ' +
              'channel minted every run, for forward secrecy. Transport is the relay this device ' +
              'pairs over — it matches the Transport line on weft start.',
          }}
          onClose={() => setLogOpen(false)}
        />
      ) : null}

      {drawerOpen ? (
        <WeftDrawer
          sessions={sessions}
          activeId={activeId}
          devices={devices}
          onStartOnDevice={(id) => {
            setDrawerOpen(false);
            onStartOnDevice(id);
          }}
          onOpenDeviceDetails={onOpenDeviceDetails ? (id) => {
            setDrawerOpen(false);
            onOpenDeviceDetails(id);
          } : undefined}
          onSelect={(id) => {
            setDrawerOpen(false);
            onSelectSession(id);
          }}
          onAddSession={() => {
            setDrawerOpen(false);
            onAddSession();
          }}
          onStartSession={() => {
            setDrawerOpen(false);
            onStartSession();
          }}
          onRemove={(id) => {
            onRemoveSession(id);
          }}
          onRename={onRenameSession}
          onOpenDevices={() => {
            setDrawerOpen(false);
            onOpenDevices();
          }}
          onGoHome={() => {
            setDrawerOpen(false);
            onGoHome();
          }}
          onOpenSettings={() => {
            setDrawerOpen(false);
            setSettingsOpen(true);
          }}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}

      {settingsOpen ? <SettingsScreen onClose={() => setSettingsOpen(false)} laptopVersion={device.appVersion} /> : null}
    </main>
  );
}

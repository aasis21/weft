import { useEffect, useRef, useState } from 'react';
import type { JSX, TouchEvent as ReactTouchEvent } from 'react';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { deviceLabel, deviceStatus, formatLastSeen } from '@/ui/screens/deviceDisplay';
import {
  BackGlyph,
  BracesGlyph,
  ChevronGlyph,
  ClipboardGlyph,
  DeviceAvatar,
  FolderGlyph,
  MoreHorizontalGlyph,
  PencilGlyph,
  PlayGlyph,
  PowerGlyph,
  RefreshGlyph,
  ResumeGlyph,
  StarGlyph,
  TerminalGlyph,
  TrashGlyph,
  WarningGlyph,
} from '@/ui/screens/deviceGlyphs';
import { DebugPanel } from '@/ui/diagnostics/DebugPanel';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
import { SettingsScreen } from '@/ui/settings/SettingsScreen';
import { deriveStatus } from '@/ui/sessions/sessionStatus';
import { DEVICE_CAPABILITY, transportIdentity, type DeviceSystemSnapshot } from '@aasis21/weft-shared';
import { App as CapacitorApp } from '@capacitor/app';
import { useNowTick } from '@/ui/hooks/useNowTick';
import { DeviceClipboardSheet, DeviceKeepAwakeSheet, keepAwakeRemaining } from './DeviceUtilitySheets';

interface DeviceDetailsScreenProps {
  device: ListenerDeviceState;
  activeId: string | null;
  /** Every session in the app; filtered here to the ones this device spawned. */
  sessions: SessionView[];
  /** Every registered listener device, so the sidebar's "Devices" group stays visible here too. */
  devices: ListenerDeviceState[];
  onRefreshProjects(channelId: string): void;
  onStartMonitoring(channelId: string): void;
  onStopMonitoring(channelId: string): void;
  onOpenDeviceClipboard(channelId: string): void;
  onCloseDeviceClipboard(channelId: string): void;
  onReadDeviceClipboard(channelId: string): void;
  onWriteDeviceClipboard(channelId: string, text: string): void;
  onRefreshDeviceKeepAwake(channelId: string): void;
  onStartDeviceKeepAwake(channelId: string, durationMs: number): void;
  onStopDeviceKeepAwake(channelId: string): void;
  /** Open the start screen on its Resume tab for this device. The resumable-session list lives
   *  there, next to the folder picker and permission toggle it shares with starting a new one —
   *  this screen is device administration, not a second place to launch sessions from. */
  onResumeOnDevice(channelId: string): void;
  onSetDefault(channelId: string): Promise<void>;
  onForget(channelId: string): Promise<void>;
  onStartOnDevice(channelId: string): void;
  onOpenTerminal?(channelId: string): void;
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
 * User-facing device operations live in one quick-action grid, with utilities capability-gated.
 */
function folderName(path: string | null | undefined): string | null {
  if (!path) return null;
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? (parts[parts.length - 1] ?? null) : null;
}

function compactPath(path: string): string {
  const separator = path.includes('\\') ? '\\' : '/';
  const parts = path.split(/[\\/]/).filter(Boolean);
  if (parts.length <= 3) return path;
  return `…${separator}${parts.slice(-3).join(separator)}`;
}

function percent(used: number | null, total: number | null): number | null {
  if (used === null || total === null || total <= 0) return null;
  return Math.max(0, Math.min(100, (used / total) * 100));
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatBytes(value: number | null): string | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function PowerCard({ system, remainingAwake }: {
  system: DeviceSystemSnapshot | undefined;
  remainingAwake: string | null;
}): JSX.Element {
  const batteryPercent = system?.batteryPercent ?? null;
  const source = batteryPercent !== null
    ? system?.batteryCharging === true || system?.onAcPower === true
      ? 'Charging'
      : system?.onAcPower === false ? 'On battery' : null
    : system?.onAcPower === true ? 'Plugged in' : system?.onAcPower === false ? 'On battery' : null;
  return (
    <div className="device-metric device-power-metric" role="group" aria-label="Power">
      <span className="device-metric-name">Power</span>
      {batteryPercent !== null ? <strong>{formatPercent(batteryPercent)}</strong> : system?.onAcPower === true ? <strong>AC</strong> : null}
      {source ? <span className="device-metric-detail">{source}</span> : batteryPercent === null ? <span className="device-metric-detail">Power unavailable</span> : null}
      {remainingAwake ? <span className="device-metric-detail device-awake-status">Keep Awake · {remainingAwake}</span> : null}
      {batteryPercent !== null ? (
        <span className="device-meter" aria-hidden="true"><i style={{ width: `${batteryPercent}%` }} /></span>
      ) : null}
    </div>
  );
}

export function DeviceDetailsScreen({
  device,
  activeId,
  sessions,
  devices,
  onRefreshProjects,
  onStartMonitoring,
  onStopMonitoring,
  onOpenDeviceClipboard,
  onCloseDeviceClipboard,
  onReadDeviceClipboard,
  onWriteDeviceClipboard,
  onRefreshDeviceKeepAwake,
  onStartDeviceKeepAwake,
  onStopDeviceKeepAwake,
  onResumeOnDevice,
  onSetDefault,
  onForget,
  onStartOnDevice,
  onOpenTerminal,
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
  const [utility, setUtility] = useState<{ kind: 'clipboard' | 'keep-awake'; channelId: string } | null>(null);
  // Forget is destructive and irreversible from here, so the menu item flips into a confirm state
  // in place rather than firing on first tap.
  const [confirmForget, setConfirmForget] = useState(false);
  // #ui: the inactive bucket starts collapsed so the list opens on what's still running.
  const [inactiveOpen, setInactiveOpen] = useState(false);
  const [allAppsOpen, setAllAppsOpen] = useState(false);
  const [allProjectsOpen, setAllProjectsOpen] = useState(false);
  // #ui: swipe-to-reveal row actions, mirroring WeftDrawer's session rows. One row at a time.
  const [swipedId, setSwipedId] = useState<string | null>(null);
  const touchRef = useRef<{ id: string; startX: number; startY: number; dx: number; swiping: boolean } | null>(null);
  const suppressClickRef = useRef(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRef = useRef<HTMLButtonElement | null>(null);
  const now = useNowTick(5_000);
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
  const terminalSupported = device.capabilities?.includes(DEVICE_CAPABILITY.TERMINAL_V1) ?? false;
  const monitoringSupported = device.capabilities?.includes(DEVICE_CAPABILITY.MONITOR_V1) ?? false;
  const clipboardSupported = device.capabilities?.includes(DEVICE_CAPABILITY.CLIPBOARD_V1) ?? false;
  const keepAwakeSupported = device.capabilities?.includes(DEVICE_CAPABILITY.KEEP_AWAKE_V1) ?? false;
  const remainingAwake = online && keepAwakeSupported ? keepAwakeRemaining(device.keepAwake?.status, now) : null;
  const utilityUnavailable = !online ? 'Offline' : device.capabilities === undefined ? 'Checking support' : 'Update required';
  const snapshot = device.monitoring?.snapshot;
  const cachedHealth = device.cachedHealth;
  const health = snapshot ?? cachedHealth;
  const usingCachedHealth = !snapshot && Boolean(cachedHealth);
  const system = health?.system;
  const memoryPercent = system ? percent(system.memoryUsedBytes, system.memoryTotalBytes) : null;
  const diskPercent = system ? percent(system.diskUsedBytes, system.diskTotalBytes) : null;
  const batteryPercent = system?.batteryPercent ?? null;
  const effectiveInterval = health?.effectiveIntervalMs ?? 10_000;
  const snapshotStale = Boolean(
    health && now - health.capturedAt > Math.max(effectiveInterval * 2 + 5_000, 25_000),
  );
  const visibleApps = snapshot?.apps ?? [];
  const shownApps = allAppsOpen ? visibleApps : visibleApps.slice(0, 3);
  const shownProjects = allProjectsOpen ? device.projects : device.projects.slice(0, 3);
  const appsUnavailable = snapshot?.issues.some((issue) => issue.component === 'apps') ?? false;
  const hasPartialSystemIssues =
    health?.issues.some((issue) => issue.component !== 'apps') ?? false;
  const systemUnavailable = Boolean(
    health &&
      system?.cpuPercent === null &&
      memoryPercent === null &&
      diskPercent === null &&
      batteryPercent === null &&
      typeof system?.onAcPower !== 'boolean',
  );

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
    setAllProjectsOpen(false);
  }, [deviceKey]);

  useEffect(() => {
    setUtility(null);
  }, [device.channelId, online, clipboardSupported, keepAwakeSupported]);

  useEffect(() => {
    if (!monitoringSupported || !online) {
      onStopMonitoring(device.channelId);
      return;
    }
    let appActive = true;
    let disposed = false;
    let removeAppListener: (() => void) | undefined;
    const syncMonitoring = (): void => {
      if (!appActive || document.visibilityState === 'hidden') onStopMonitoring(device.channelId);
      else onStartMonitoring(device.channelId);
    };
    syncMonitoring();
    document.addEventListener('visibilitychange', syncMonitoring);
    void CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      appActive = isActive;
      syncMonitoring();
    }).then((handle) => {
      if (disposed) void handle.remove();
      else removeAppListener = () => void handle.remove();
    });
    return () => {
      disposed = true;
      removeAppListener?.();
      document.removeEventListener('visibilitychange', syncMonitoring);
      onStopMonitoring(device.channelId);
    };
  }, [device.channelId, monitoringSupported, online, onStartMonitoring, onStopMonitoring]);

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

        <section className="device-monitor-summary device-panel" aria-label="Device health">
          {online && device.capabilities !== undefined && !monitoringSupported ? (
            <div className="device-monitor-state device-monitor-update">
              <strong>Update Weft on this laptop</strong>
              <span>Install the latest Device Station to see system health and running apps.</span>
            </div>
          ) : health ? (
            <>
              <div className="device-section-head device-health-head">
                <h3 className="device-section-label">System health</h3>
                <span className="device-section-meta">
                  {usingCachedHealth
                    ? online
                      ? `Updating · saved ${formatLastSeen(health.capturedAt, now) ?? 'recently'}`
                      : `Saved ${formatLastSeen(health.capturedAt, now) ?? 'recently'} · offline`
                    : snapshotStale
                      ? 'Update delayed'
                      : `Updated ${formatLastSeen(health.capturedAt, now) ?? 'just now'}`}
                </span>
              </div>
              <div className="device-metrics">
                {system?.cpuPercent !== null && system?.cpuPercent !== undefined ? (
                  <div className="device-metric">
                    <span className="device-metric-name">CPU</span>
                    <strong>{formatPercent(system.cpuPercent)}</strong>
                    <span className="device-meter" aria-hidden="true"><i style={{ width: `${system.cpuPercent}%` }} /></span>
                  </div>
                ) : null}
                {memoryPercent !== null ? (
                  <div className="device-metric">
                    <span className="device-metric-name">Memory</span>
                    <strong>{formatPercent(memoryPercent)}</strong>
                    <span className="device-metric-detail">
                      {formatBytes(system?.memoryUsedBytes ?? null)} / {formatBytes(system?.memoryTotalBytes ?? null)}
                    </span>
                    <span className="device-meter" aria-hidden="true"><i style={{ width: `${memoryPercent}%` }} /></span>
                  </div>
                ) : null}
                {diskPercent !== null ? (
                  <div className="device-metric">
                    <span className="device-metric-name">Disk</span>
                    <strong>{formatPercent(diskPercent)}</strong>
                    <span className="device-metric-detail">
                      {formatBytes(system?.diskUsedBytes ?? null)} / {formatBytes(system?.diskTotalBytes ?? null)}
                    </span>
                    <span className="device-meter" aria-hidden="true"><i style={{ width: `${diskPercent}%` }} /></span>
                  </div>
                ) : null}
                <PowerCard system={system} remainingAwake={remainingAwake} />
              </div>
              {systemUnavailable ? (
                <p className="device-monitor-partial">System metrics are temporarily unavailable.</p>
              ) : null}
              {hasPartialSystemIssues && !systemUnavailable ? (
                <p className="device-monitor-partial">Some system details are temporarily unavailable.</p>
              ) : null}
            </>
          ) : !online ? (
            <div className="device-monitor-state">
              <strong>System health unavailable</strong>
              <span>Monitoring resumes when this laptop reconnects.</span>
            </div>
          ) : device.capabilities === undefined ? (
            <div className="device-monitor-state" role="status">
              <strong>Checking Device Station capabilities…</strong>
              <span>Waiting for this laptop to describe the features it supports.</span>
            </div>
          ) : (
            <div className="device-monitor-state" role="status">
              <strong>Checking system health…</strong>
              <span>{device.monitoring?.error ?? 'Waiting for the first snapshot from this laptop.'}</span>
            </div>
          )}
          {!health || (online && device.capabilities !== undefined && !monitoringSupported) ? (
            <div className="device-metrics"><PowerCard system={undefined} remainingAwake={remainingAwake} /></div>
          ) : null}
        </section>

        <section className="device-quick-actions device-panel" aria-labelledby="device-quick-actions-heading">
          <h3 id="device-quick-actions-heading" className="device-section-label">Quick actions</h3>
          <div className="device-action-grid">
            <button
              type="button"
              className="device-quick-action"
              disabled={!online}
              onClick={() => onStartOnDevice(device.channelId)}
            >
              <span className="device-action-icon" aria-hidden="true"><PlayGlyph /></span>
              <strong>Start Copilot</strong>
            </button>
            <button
              type="button"
              className="device-quick-action"
              disabled={!online}
              onClick={() => onResumeOnDevice(device.channelId)}
            >
              <span className="device-action-icon" aria-hidden="true"><ResumeGlyph /></span>
              <strong>Resume Copilot</strong>
            </button>
            <button
              type="button"
              className="device-quick-action"
              aria-haspopup="dialog"
              aria-describedby={!online || !clipboardSupported ? 'device-utility-support' : undefined}
              disabled={!online || !clipboardSupported}
              onClick={(event) => {
                event.currentTarget.focus();
                setUtility({ kind: 'clipboard', channelId: device.channelId });
              }}
            >
              <span className="device-action-icon" aria-hidden="true"><ClipboardGlyph /></span>
              <strong>Clipboard</strong>
              {!online || !clipboardSupported ? <small className="device-action-status">{utilityUnavailable}</small> : device.clipboard?.pending ? <small className="device-action-status">Working…</small> : null}
            </button>
            <button
              type="button"
              className="device-quick-action"
              aria-haspopup="dialog"
              aria-describedby={!online || !keepAwakeSupported ? 'device-utility-support' : undefined}
              disabled={!online || !keepAwakeSupported}
              onClick={(event) => {
                event.currentTarget.focus();
                setUtility({ kind: 'keep-awake', channelId: device.channelId });
              }}
            >
              <span className="device-action-icon" aria-hidden="true"><PowerGlyph /></span>
              <strong>Keep Awake</strong>
              <small className="device-action-status">{!online || !keepAwakeSupported ? utilityUnavailable : device.keepAwake?.pending ? 'Working…' : remainingAwake ?? 'System sleep'}</small>
            </button>
            <button
              type="button"
              className="device-quick-action"
              aria-label="Open terminal"
              aria-describedby={!terminalSupported ? 'terminal-enable-guidance' : undefined}
              disabled={!online || !terminalSupported || !onOpenTerminal}
              onClick={() => onOpenTerminal?.(device.channelId)}
            >
              <span className="device-action-icon" aria-hidden="true"><TerminalGlyph /></span>
              <strong>Open terminal</strong>
              {!terminalSupported ? <small className="device-action-status">Enable on laptop</small> : null}
            </button>
          </div>
          {!terminalSupported ? (
            <p id="terminal-enable-guidance" className="device-offline-note">
              Terminal access is unavailable. Update Weft on the laptop, then run <code>weft start --allow-terminal</code>.
            </p>
          ) : null}
          {!online || !clipboardSupported || !keepAwakeSupported ? (
            <p id="device-utility-support" className="device-utility-support">
              {!online ? 'Reconnect this laptop to use device utilities.' : device.capabilities === undefined ? 'Checking utility support on this laptop…' : 'Update Weft on this laptop to enable unavailable utilities.'}
            </p>
          ) : null}
        </section>

        {!online ? (
          <p className="device-offline-note">
            <span className="device-action-icon" aria-hidden="true"><WarningGlyph /></span>
            <span>
              Offline — run <code>weft start</code> on this laptop to start or resume sessions.
            </span>
          </p>
        ) : null}

        {monitoringSupported && snapshot ? (
          <section className="session-join-fallback device-running device-panel">
            <div className="device-section-head device-running-head">
              <h3 className="device-section-label">
                Running now
                <span className="sr-only">, {visibleApps.length} apps</span>
              </h3>
              <div className="device-section-tools">
                <span className="device-section-count" aria-hidden="true">{visibleApps.length} apps</span>
                {visibleApps.length > 3 ? (
                  <button type="button" onClick={() => setAllAppsOpen((open) => !open)}>
                    {allAppsOpen ? 'Show less' : `Show all ${visibleApps.length}`}
                  </button>
                ) : null}
              </div>
            </div>
            {appsUnavailable ? (
              <p className="device-card-sub">Running applications are temporarily unavailable.</p>
            ) : visibleApps.length > 0 ? (
              <ul className="device-running-list">
                {shownApps.map((app) => {
                  const details = [
                    app.windowCount > 0 ? `${app.windowCount} window${app.windowCount === 1 ? '' : 's'}` : null,
                    app.memoryBytes !== null ? formatBytes(app.memoryBytes) : null,
                  ].filter((value): value is string => Boolean(value));
                  return (
                    <li key={app.id}>
                      <span>{app.name}</span>
                      {details.length > 0 ? <small>{details.join(' · ')}</small> : null}
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="device-card-sub">No visible applications are running.</p>
            )}
          </section>
        ) : null}

        {offers.length > 0 ? (
          <section className="session-join-fallback device-offers device-panel">
            <div className="device-section-head">
              <h3 className="device-section-label">
                Offered sessions
                <span className="sr-only">, {offers.length}</span>
              </h3>
              <span className="device-section-count" aria-hidden="true">{offers.length}</span>
            </div>
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

        <section className="session-join-fallback device-workspaces device-panel">
          <div className="device-section-head">
            <h3 className="device-section-label">
              Copilot workspaces
              {!device.projectsLoading && device.projects.length > 0 ? (
                <span className="sr-only">
                  , {device.projects.length} {device.projects.length === 1 ? 'folder' : 'folders'}
                </span>
              ) : null}
            </h3>
            {!device.projectsLoading && device.projects.length > 0 ? (
              <span className="device-section-count" aria-hidden="true">
                {device.projects.length} {device.projects.length === 1 ? 'folder' : 'folders'}
              </span>
            ) : null}
          </div>
          {device.projectsLoading ? (
            <p className="device-card-sub">{online ? 'Refreshing workspaces…' : 'Loading workspaces…'}</p>
          ) : device.projects.length > 0 ? (
            <>
              <ul className="device-workspace-list">
                {shownProjects.map((project) => (
                  <li key={project.path ?? project.name} className="device-workspace-row">
                    <span className="device-workspace-icon" aria-hidden="true"><FolderGlyph /></span>
                    <span className="device-workspace-copy">
                      <span className="device-workspace-name">
                        <span className="device-workspace-title">{project.name}</span>
                        {project.isDefault ? <span className="device-workspace-default">Default</span> : null}
                      </span>
                      <span className="device-workspace-path" title={project.path}>
                        {compactPath(project.path)}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              {device.projects.length > 3 ? (
                <button
                  type="button"
                  className="device-workspaces-toggle"
                  aria-expanded={allProjectsOpen}
                  onClick={() => setAllProjectsOpen((open) => !open)}
                >
                  <ChevronGlyph />
                  {allProjectsOpen ? 'Show fewer workspaces' : `Show all ${device.projects.length} workspaces`}
                </button>
              ) : null}
            </>
          ) : (
            <div className="device-workspaces-empty">
              <span className="device-workspace-icon" aria-hidden="true"><FolderGlyph /></span>
              <span>
                <strong>No Copilot workspaces configured</strong>
                <small>Add one on the laptop with <code>weft add-project</code>.</small>
              </span>
            </div>
          )}
        </section>

        <section className="session-join-fallback device-sessions device-panel">
          <div className="device-section-head">
            <h3 className="device-section-label">
              Active Copilot sessions
              <span className="sr-only">, {activeRows.length}</span>
            </h3>
            <span className="device-section-count" aria-hidden="true">{activeRows.length}</span>
          </div>
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
                Inactive Copilot sessions ({inactiveRows.length})
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

      {settingsOpen ? <SettingsScreen onClose={() => setSettingsOpen(false)} laptopVersion={device.appVersion} onOpenDrawer={() => setDrawerOpen(true)} /> : null}
      {utility?.channelId === device.channelId && online && utility.kind === 'clipboard' && clipboardSupported ? (
        <DeviceClipboardSheet
          key={device.channelId}
          device={device}
          onOpen={onOpenDeviceClipboard}
          onClear={onCloseDeviceClipboard}
          onRead={onReadDeviceClipboard}
          onWrite={onWriteDeviceClipboard}
          onClose={() => setUtility(null)}
        />
      ) : null}
      {utility?.channelId === device.channelId && online && utility.kind === 'keep-awake' && keepAwakeSupported ? (
        <DeviceKeepAwakeSheet
          key={device.channelId}
          device={device}
          onRefresh={onRefreshDeviceKeepAwake}
          onStart={onStartDeviceKeepAwake}
          onStop={onStopDeviceKeepAwake}
          onClose={() => setUtility(null)}
        />
      ) : null}
    </main>
  );
}

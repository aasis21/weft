import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { ListenerDeviceState } from '@/session/model';
import type { SessionView } from '@/session/view';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';
import { DeviceAvatar, MoreHorizontalGlyph, PlayGlyph, PlusGlyph, RefreshGlyph, StarGlyph, TrashGlyph } from '@/ui/screens/deviceGlyphs';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
import { SettingsScreen } from '@/ui/settings/SettingsScreen';
import { useNowTick } from '@/ui/hooks/useNowTick';
import { PullIndicator, useLeftEdgeSwipe, usePullToRefresh } from '@/ui/gestures/touchGestures';

interface DevicesScreenProps {
  sessions: SessionView[];
  activeId: string | null;
  devices: ListenerDeviceState[];
  onRefreshProjects(channelId: string): void;
  onSetDefault(channelId: string): Promise<void>;
  onForget(channelId: string): Promise<void>;
  onStartOnDevice(channelId: string): void;
  onOpenDetails(channelId: string): void;
  onScanListener(): void;
  onSelectSession(channelId: string): void;
  onAddSession(): void;
  onStartSession(): void;
  onOpenDevices(): void;
  onRemoveSession(channelId: string): void;
  onRenameSession(channelId: string, title: string): void;
  onGoHome(): void;
}

/**
 * Full "connected devices" management screen (#186): every registered `weft` listener, its
 * live status + last-seen time, and per-device actions — separate from StartSessionScreen (which
 * is scoped to launching ONE new session on ONE device). Reached from the sessions drawer/menu
 * as "Devices", distinct from "Join another session" (mirror an existing session by its QR) and
 * "Start another session" (spawn a new one via a device already registered here).
 *
 * Navigation: the header always shows the same hamburger as every other screen (opens the
 * sessions sidebar, never "back") — leaving this screen relies on the browser/app Back
 * gesture (history pushed by the caller), not a dedicated in-page back button.
 */
export function DevicesScreen({
  sessions,
  activeId,
  devices,
  onRefreshProjects,
  onSetDefault,
  onForget,
  onStartOnDevice,
  onOpenDetails,
  onScanListener,
  onSelectSession,
  onAddSession,
  onStartSession,
  onOpenDevices,
  onRemoveSession,
  onRenameSession,
  onGoHome,
}: DevicesScreenProps): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [menuPlacement, setMenuPlacement] = useState<'down' | 'up'>('down');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  const now = useNowTick();
  const sortedDevices = sortDevices(devices);
  const scrollRef = useRef<HTMLDivElement>(null);
  useLeftEdgeSwipe(!drawerOpen && !settingsOpen, () => setDrawerOpen(true));
  const pull = usePullToRefresh(scrollRef, () => sortedDevices.forEach((device) => onRefreshProjects(device.channelId)),
    sortedDevices.length > 0);
  const onlineDevices = sortedDevices.filter((d) => deviceStatus(d).tone !== 'offline');
  const offlineDevices = sortedDevices.filter((d) => deviceStatus(d).tone === 'offline');
  const onlineCount = onlineDevices.length;
  const countLabel =
    sortedDevices.length === 0
      ? 'No devices yet'
      : `${sortedDevices.length} device${sortedDevices.length === 1 ? '' : 's'}${
          onlineCount > 0 ? ` · ${onlineCount} online` : ''
        }`;

  const closeMenu = (returnFocus: boolean): void => {
    const openId = menuOpenId;
    setMenuOpenId(null);
    if (returnFocus && openId) menuTriggerRefs.current.get(openId)?.focus();
  };

  useEffect(() => {
    if (!menuOpenId) return;
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
  }, [menuOpenId]);

  useEffect(() => {
    if (!menuOpenId) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpenId]);

  const renderDevice = (device: ListenerDeviceState): JSX.Element => {
    const status = deviceStatus(device);
    const lastSeen = formatLastSeen(device.lastSeenAt, now);
    const lastTried = !device.connected ? formatLastSeen(device.lastAttemptAt, now) : null;
    const projectsLabel = device.projectsLoading
      ? device.connected
        ? 'Refreshing projects…'
        : 'Loading projects…'
      : device.projects.length > 0
        ? `${device.projects.length} project${device.projects.length === 1 ? '' : 's'}`
        : 'No projects yet';
    const menuOpen = menuOpenId === device.channelId;
    const openMenu = (button: HTMLButtonElement): void => {
      const rect = button.getBoundingClientRect();
      const spaceBelow = window.innerHeight - rect.bottom;
      setMenuPlacement(spaceBelow < 180 && rect.top > spaceBelow ? 'up' : 'down');
      setMenuOpenId(device.channelId);
    };
    const offline = status.tone === 'offline';
    const meta = [
      lastSeen ? `last seen ${lastSeen}` : null,
      lastTried ? `tried ${lastTried}` : null,
      offline ? null : projectsLabel,
    ].filter(Boolean).join(' · ');
    return (
      <li key={device.channelId} className={`device-row${offline ? ' offline' : ''}`}>
        <button
          type="button"
          className="device-row-main"
          aria-label={`View details for ${deviceLabel(device)}`}
          onClick={() => onOpenDetails(device.channelId)}
        >
          <DeviceAvatar tone={status.tone} />
          <span className="device-row-text">
            <span className="device-row-name">
              <span className="device-row-title">{deviceLabel(device)}</span>
              {device.isDefault ? <span className="tag">default</span> : null}
            </span>
            {meta ? <span className="device-row-meta">{meta}</span> : null}
            {device.error ? (
              <span className="device-row-error" title={device.error}>{device.error}</span>
            ) : null}
          </span>
        </button>
        {offline ? null : (
          <button
            type="button"
            className="device-row-start"
            aria-label={`Start session on ${deviceLabel(device)}`}
            title="Start a session on this device"
            onClick={() => onStartOnDevice(device.channelId)}
          >
            <span className="device-action-icon" aria-hidden="true"><PlayGlyph /></span>
            Start
          </button>
        )}
        <div className="device-menu-wrap" data-device-menu-root={device.channelId}>
          <button
            ref={(node) => {
              if (node) menuTriggerRefs.current.set(device.channelId, node);
              else menuTriggerRefs.current.delete(device.channelId);
            }}
            className="icon-btn device-menu-btn"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={`Device actions for ${deviceLabel(device)}`}
            onClick={(e) => {
              if (menuOpen) setMenuOpenId(null);
              else openMenu(e.currentTarget);
            }}
          >
            <MoreHorizontalGlyph />
          </button>
          {menuOpen ? (
            <div ref={menuRef} className={`device-menu device-menu-${menuPlacement}`} role="menu">
              {!device.isDefault ? (
                <button
                  type="button"
                  role="menuitem"
                  className="device-menu-item"
                  onClick={() => {
                    setMenuOpenId(null);
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
                  setMenuOpenId(null);
                  onRefreshProjects(device.channelId);
                }}
              >
                <span className="device-action-icon" aria-hidden="true"><RefreshGlyph /></span>
                Refresh projects
              </button>
              <button
                type="button"
                role="menuitem"
                className="device-menu-item danger"
                onClick={() => {
                  setMenuOpenId(null);
                  void onForget(device.channelId);
                }}
              >
                <span className="device-action-icon" aria-hidden="true"><TrashGlyph /></span>
                Forget device
              </button>
            </div>
          ) : null}
        </div>
      </li>
    );
  };

  return (
    <main className="weft-session join-session fixed-frame devices-screen">
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
        <div className="status-id">
          <span className="status-title">Devices</span>
          <span className="status-line">
            <span className={`status-dot${onlineCount > 0 ? ' live' : ''}`} aria-hidden="true" />
            {countLabel}
          </span>
        </div>
        <span className="status-icons">
          <button
            className="icon-btn devices-refresh-btn"
            type="button"
            onClick={() => sortedDevices.forEach((device) => onRefreshProjects(device.channelId))}
            aria-label="Refresh all devices"
            title="Refresh all devices"
            disabled={sortedDevices.length === 0}
          >
            <RefreshGlyph />
          </button>
          <button
            className="icon-btn devices-add-btn"
            type="button"
            onClick={onScanListener}
            aria-label="Add a new device"
            title="Add a new device"
          >
            <PlusGlyph />
          </button>
        </span>
      </header>
      <div className="page-scroll" ref={scrollRef}>
        <PullIndicator state={pull} />
        <div className="session-join-inner">
          {sortedDevices.length === 0 ? (
            <section className="session-join-scanner start-empty">
              <p>
                A <strong>device</strong> is a laptop running <code>weft start</code>. Pair one, then start
                Copilot sessions on it from your phone.
              </p>
              <button type="button" className="session-primary-action" onClick={onScanListener}>
                Scan to connect
              </button>
            </section>
          ) : (
            <>
              {onlineDevices.length > 0 ? (
                <section className="device-group" aria-labelledby="devices-online-heading">
                  <h3 id="devices-online-heading" className="device-group-header">Online</h3>
                  <ul className="device-rows">{onlineDevices.map(renderDevice)}</ul>
                </section>
              ) : null}
              {offlineDevices.length > 0 ? (
                <section className="device-group" aria-labelledby="devices-offline-heading">
                  <h3 id="devices-offline-heading" className="device-group-header">
                    {onlineDevices.length > 0 ? 'Offline' : 'Offline · no devices reachable'}
                  </h3>
                  <ul className="device-rows">{offlineDevices.map(renderDevice)}</ul>
                  <p className="device-group-note">Run <code>weft start</code> on a laptop to bring it back online.</p>
                </section>
              ) : null}
            </>
          )}
        </div>
      </div>

      {drawerOpen ? (
        <WeftDrawer
          sessions={sessions}
          activeId={activeId}
          devices={devices}
          onStartOnDevice={(id) => {
            setDrawerOpen(false);
            onStartOnDevice(id);
          }}
          onOpenDeviceDetails={(id) => {
            setDrawerOpen(false);
            onOpenDetails(id);
          }}
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

      {settingsOpen ? <SettingsScreen onClose={() => setSettingsOpen(false)} onOpenDrawer={() => setDrawerOpen(true)} /> : null}
    </main>
  );
}

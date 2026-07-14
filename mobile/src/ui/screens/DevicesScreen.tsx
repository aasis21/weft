import { useState } from 'react';
import type { JSX } from 'react';
import type { ListenerDeviceState } from '@/session/model';
import type { SessionView } from '@/session/view';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';
import { DeviceAvatar } from '@/ui/screens/deviceGlyphs';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
import { SettingsScreen } from '@/ui/settings/SettingsScreen';

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
  const sortedDevices = sortDevices(devices);
  const onlineDevices = sortedDevices.filter((d) => deviceStatus(d).tone !== 'offline');
  const offlineDevices = sortedDevices.filter((d) => deviceStatus(d).tone === 'offline');
  const onlineCount = onlineDevices.length;
  const countLabel =
    sortedDevices.length === 0
      ? 'No devices yet'
      : `${sortedDevices.length} device${sortedDevices.length === 1 ? '' : 's'}${
          onlineCount > 0 ? ` · ${onlineCount} online` : ''
        }`;

  const renderDevice = (device: ListenerDeviceState): JSX.Element => {
    const status = deviceStatus(device);
    const lastSeen = formatLastSeen(device.lastSeenAt);
    const projectsLabel = device.projectsLoading
      ? 'Loading projects…'
      : device.projects.length > 0
        ? `${device.projects.length} project${device.projects.length === 1 ? '' : 's'}`
        : 'No projects yet';
    const menuOpen = menuOpenId === device.channelId;
    return (
      <div
        key={device.channelId}
        className="device-card device-tile"
        role="button"
        tabIndex={0}
        aria-label={`View details for ${deviceLabel(device)}`}
        onClick={() => onOpenDetails(device.channelId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onOpenDetails(device.channelId);
          if (e.key === ' ' || e.key === 'Spacebar') {
            e.preventDefault();
            onOpenDetails(device.channelId);
          }
        }}
      >
        <div className="device-tile-head">
          <DeviceAvatar tone={status.tone} />
          <span className="session-info">
            <span className="session-title">
              {deviceLabel(device)}
              {device.isDefault ? <span className="tag">default</span> : null}
            </span>
            <span className="session-sub">
              <span className={`device-status device-status-${status.tone}`}>
                <span className="device-status-dot" aria-hidden="true" />
                {status.label}
              </span>
              {lastSeen ? ` · last seen ${lastSeen}` : ''}
              {` · ${projectsLabel}`}
            </span>
          </span>
          <button
            className="icon-btn device-menu-btn"
            type="button"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="Device actions"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenId(menuOpen ? null : device.channelId);
            }}
          >
            ⋯
          </button>
        </div>

        {device.error ? <p className="error-banner">{device.error}</p> : null}

        <button
          type="button"
          className="session-primary-action device-start-btn"
          onClick={(e) => {
            e.stopPropagation();
            onStartOnDevice(device.channelId);
          }}
        >
          ▻ Start session
        </button>

        {menuOpen ? (
          <div className="device-menu" role="menu" onClick={(e) => e.stopPropagation()}>
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
                ⭐ Make default
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
              ↻ Refresh projects
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
              🗑 Forget device
            </button>
          </div>
        ) : null}
      </div>
    );
  };

  return (
    <main className="weft-session join-session devices-screen">
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
          <span className="status-title">Manage devices</span>
          <span className="status-line">
            <span className="status-dot" aria-hidden="true" />
            {countLabel}
          </span>
        </div>
        <span className="status-icons">
          <button
            className="icon-btn devices-add-btn"
            type="button"
            onClick={onScanListener}
            aria-label="Add a new device"
            title="Add a new device"
          >
            +
          </button>
        </span>
      </header>

      <div className="session-join-inner">
        <p className="session-join-hint">
          A <strong>device</strong> is a laptop running <code>weft start</code>. Pair one here,
          then start <strong>sessions</strong> (live Copilot runs) on it from your phone.
          {sortedDevices.length > 0 ? ' Tap a card to view its details, projects, and event log.' : ''}
        </p>

        {sortedDevices.length === 0 ? (
          <section className="session-join-scanner start-empty">
            <p>No devices saved yet.</p>
            <button type="button" className="session-primary-action" onClick={onScanListener}>
              Scan to connect
            </button>
          </section>
        ) : (
          <section className="session-join-fallback devices-list">
            {onlineDevices.length > 0 ? (
              <div className="device-group">
                <h3 className="device-group-header">Online</h3>
                {onlineDevices.map(renderDevice)}
              </div>
            ) : null}
            {offlineDevices.length > 0 ? (
              <div className="device-group">
                {onlineDevices.length > 0 ? <h3 className="device-group-header">Offline</h3> : null}
                {offlineDevices.map(renderDevice)}
              </div>
            ) : null}
          </section>
        )}
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

      {settingsOpen ? <SettingsScreen onClose={() => setSettingsOpen(false)} /> : null}
    </main>
  );
}

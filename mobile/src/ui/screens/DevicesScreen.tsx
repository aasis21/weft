import { useState } from 'react';
import type { JSX } from 'react';
import type { ListenerDeviceState } from '@/session/model';
import type { SessionView } from '@/session/view';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';
import { SessionDrawer } from '@/ui/sessions/SessionDrawer';
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
  onRemoveSession(channelId: string): void;
  onRenameSession(channelId: string, title: string): void;
  onGoHome(): void;
}

/**
 * Full "connected devices" management screen (#186): every registered `helm-cli` listener, its
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
  onRemoveSession,
  onRenameSession,
  onGoHome,
}: DevicesScreenProps): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const sortedDevices = sortDevices(devices);
  const onlineCount = sortedDevices.filter((d) => deviceStatus(d).tone === 'online').length;
  const countLabel =
    sortedDevices.length === 0
      ? 'No devices yet'
      : `${sortedDevices.length} device${sortedDevices.length === 1 ? '' : 's'}${
          onlineCount > 0 ? ` · ${onlineCount} online` : ''
        }`;

  return (
    <main className="helm-session join-session devices-screen">
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
          <span className="status-title">Connected devices</span>
          <span className="status-line">
            <span className="status-dot" aria-hidden="true" />
            {countLabel}
          </span>
        </div>
      </header>

      <div className="session-join-inner">
        <p className="session-join-hint">
          Each is a laptop running <code>helm-cli start</code>. Tap a device to view its details,
          projects, and event log.
        </p>

        {sortedDevices.length === 0 ? (
          <section className="session-join-scanner start-empty">
            <p>No listener devices saved yet.</p>
            <button type="button" className="session-primary-action" onClick={onScanListener}>
              Scan a listener QR
            </button>
          </section>
        ) : (
          <section className="session-join-fallback devices-list">
            {sortedDevices.map((device) => {
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
                  className="session-row device-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => onOpenDetails(device.channelId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') onOpenDetails(device.channelId);
                    if (e.key === ' ' || e.key === 'Spacebar') {
                      e.preventDefault();
                      onOpenDetails(device.channelId);
                    }
                  }}
                >
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
                    {device.error ? <p className="error-banner">{device.error}</p> : null}
                  </span>

                  <span className="row-actions" onClick={(e) => e.stopPropagation()}>
                    <button
                      className="icon-btn"
                      type="button"
                      onClick={() => onStartOnDevice(device.channelId)}
                      title="Start session"
                      aria-label="Start session"
                    >
                      ▻
                    </button>
                    {!device.isDefault ? (
                      <button
                        className="icon-btn"
                        type="button"
                        onClick={() => void onSetDefault(device.channelId)}
                        title="Make default"
                        aria-label="Make default"
                      >
                        ⭐
                      </button>
                    ) : null}
                    <button
                      className="icon-btn"
                      type="button"
                      onClick={() => onRefreshProjects(device.channelId)}
                      title="Refresh projects"
                      aria-label="Refresh projects"
                    >
                      ↻
                    </button>
                    <button
                      className="icon-btn danger"
                      type="button"
                      onClick={() => void onForget(device.channelId)}
                      title="Forget device"
                      aria-label="Forget device"
                    >
                      🗑
                    </button>
                  </span>
                  <span className="row-chevron" aria-hidden="true">
                    ›
                  </span>
                </div>
              );
            })}

            <button type="button" className="session-secondary-action" onClick={onScanListener}>
              + Scan another listener QR
            </button>
          </section>
        )}
      </div>

      {drawerOpen ? (
        <SessionDrawer
          sessions={sessions}
          activeId={activeId}
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

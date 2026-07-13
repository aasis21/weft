import { useState } from 'react';
import type { JSX } from 'react';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { deviceLabel, deviceStatus, formatLastSeen } from '@/ui/screens/deviceDisplay';
import { DeviceAvatar } from '@/ui/screens/deviceGlyphs';
import { DebugPanel } from '@/ui/diagnostics/DebugPanel';
import { SessionDrawer } from '@/ui/sessions/SessionDrawer';
import { SettingsScreen } from '@/ui/settings/SettingsScreen';
import { deriveStatus } from '@/ui/sessions/sessionStatus';
import { transportIdentity } from '@aasis21/weft-shared';

interface DeviceDetailsScreenProps {
  device: ListenerDeviceState;
  activeId: string | null;
  /** Every session in the app; filtered here to the ones this device spawned. */
  sessions: SessionView[];
  /** Every registered listener device, so the sidebar's "Devices" group stays visible here too. */
  devices: ListenerDeviceState[];
  onRefreshProjects(channelId: string): void;
  onSetDefault(channelId: string): Promise<void>;
  onForget(channelId: string): Promise<void>;
  onStartOnDevice(channelId: string): void;
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
 * Navigation: the header always shows the same hamburger as every other screen (opens the
 * sessions sidebar, never "back") — leaving this screen relies on the browser/app Back gesture,
 * not a dedicated in-page back button.
 */
export function DeviceDetailsScreen({
  device,
  activeId,
  sessions,
  devices,
  onRefreshProjects,
  onSetDefault,
  onForget,
  onStartOnDevice,
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
  const status = deviceStatus(device);
  const lastSeen = formatLastSeen(device.lastSeenAt);
  const deviceKey = device.deviceId ?? device.channelId;
  const spawnedSessions = sessions
    .filter((s) => (s.meta.spawnedFromDeviceId ?? '') === deviceKey)
    .sort((a, b) => (b.lastEventAt ?? b.meta.addedAt) - (a.lastEventAt ?? a.meta.addedAt));

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
          <button
            className="icon-btn debug-btn"
            type="button"
            onClick={() => setLogOpen(true)}
            aria-label="Debug events"
            title="Event log & comms identifiers"
          >
            <span className="debug-glyph" aria-hidden="true">{'{ }'}</span>
          </button>
        </div>
      </header>

      <div className="session-join-inner">
        {device.error ? <p className="error-banner">{device.error}</p> : null}

        <section className="session-join-fallback device-card">
          <p className="device-card-sub">
            {device.projectsLoading
              ? 'Loading projects…'
              : device.projects.length > 0
                ? device.projects.map((p) => p.name).join(', ')
                : 'No projects received yet.'}
          </p>
          <div className="device-actions">
            <button type="button" className="session-primary-action device-start-btn" onClick={() => onStartOnDevice(device.channelId)}>
              Start session
            </button>
            <button type="button" className="session-link-btn" onClick={() => onRefreshProjects(device.channelId)}>
              Refresh
            </button>
            {!device.isDefault ? (
              <button type="button" className="session-link-btn" onClick={() => void onSetDefault(device.channelId)}>
                Make default
              </button>
            ) : null}
            <button type="button" className="session-link-btn danger" onClick={() => void onForget(device.channelId)}>
              Forget
            </button>
          </div>
        </section>

        <section className="session-join-fallback device-sessions">
          <h3>Sessions from this device</h3>
          {spawnedSessions.length === 0 ? (
            <p className="device-card-sub">No sessions started on this device yet.</p>
          ) : (
            <ul className="devices-list device-sessions-list">
              {spawnedSessions.map((session) => {
                const derived = deriveStatus(session, { busy: session.timeline.busy });
                return (
                  <li key={session.meta.channelId} className="device-card device-session-row">
                    <button
                      type="button"
                      className="device-session-open"
                      onClick={() => onOpenSession(session.meta.channelId)}
                    >
                      <span className="device-card-name">{session.meta.title}</span>
                      <span className={`status-line ${derived.tone} device-session-status`}>
                        <span className="status-dot" aria-hidden="true" />
                        {derived.label}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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
        <SessionDrawer
          sessions={sessions}
          activeId={activeId}
          devices={devices}
          onStartOnDevice={(id) => {
            setDrawerOpen(false);
            onStartOnDevice(id);
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

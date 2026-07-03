import { useState } from 'react';
import type { JSX } from 'react';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { deviceLabel, deviceStatus, formatLastSeen } from '@/ui/screens/deviceDisplay';
import { DebugPanel } from '@/ui/diagnostics/DebugPanel';

interface DeviceDetailsScreenProps {
  device: ListenerDeviceState;
  /** Every session in the app; filtered here to the ones this device spawned. */
  sessions: SessionView[];
  onRefreshProjects(channelId: string): void;
  onSetDefault(channelId: string): Promise<void>;
  onForget(channelId: string): Promise<void>;
  onStartOnDevice(channelId: string): void;
  onOpenSession(channelId: string): void;
  onBack(): void;
}

function sessionStatusLabel(session: SessionView): string {
  switch (session.status) {
    case 'live':
      return session.timeline.busy ? 'Working' : 'Live';
    case 'idle':
      return 'Quiet';
    case 'connecting':
    case 'initializing':
      return 'Connecting…';
    case 'error':
      return 'Offline';
    case 'ended':
      return 'Ended';
    default:
      return session.status;
  }
}

/**
 * Device details (#device-events): the full record for ONE registered listener — its live status,
 * a "Sessions from this device" list (every session ever spawned here via "Start session", matched
 * by the listener's stable deviceId so it survives `helm-cli start` restarts), and the raw
 * DEVICE-channel event log (project list / spawn / forget — reuses the same DebugPanel component
 * the per-session debug view uses). Reached from a device row on DevicesScreen.
 */
export function DeviceDetailsScreen({
  device,
  sessions,
  onRefreshProjects,
  onSetDefault,
  onForget,
  onStartOnDevice,
  onOpenSession,
  onBack,
}: DeviceDetailsScreenProps): JSX.Element {
  const [logOpen, setLogOpen] = useState(false);
  const status = deviceStatus(device);
  const lastSeen = formatLastSeen(device.lastSeenAt);
  const deviceKey = device.deviceId ?? device.channelId;
  const spawnedSessions = sessions
    .filter((s) => (s.meta.spawnedFromDeviceId ?? '') === deviceKey)
    .sort((a, b) => (b.lastEventAt ?? b.meta.addedAt) - (a.lastEventAt ?? a.meta.addedAt));

  return (
    <main className="helm-session join-session device-details-screen">
      <div className="session-join-inner">
        <header className="session-join-head">
          <button type="button" className="session-pair-back" onClick={onBack}>
            ← Back to devices
          </button>
          <p className="session-join-kicker">Device details</p>
          <h2>
            {deviceLabel(device)}
            {device.isDefault ? <span className="tag">default</span> : null}
          </h2>
          <div className={`device-status device-status-${status.tone}`}>
            <span className="device-status-dot" aria-hidden="true" />
            <span>{status.label}</span>
            {lastSeen ? <span className="device-status-seen">· last seen {lastSeen}</span> : null}
          </div>
        </header>

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
            <button type="button" className="session-link-btn" onClick={() => setLogOpen(true)}>
              Event log ({device.events.length})
            </button>
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
              {spawnedSessions.map((session) => (
                <li key={session.meta.channelId} className="device-card device-session-row">
                  <button
                    type="button"
                    className="device-session-open"
                    onClick={() => onOpenSession(session.meta.channelId)}
                  >
                    <span className="device-card-name">{session.meta.title}</span>
                    <span className="device-card-sub">{sessionStatusLabel(session)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {logOpen ? (
        <DebugPanel events={device.events} title={deviceLabel(device)} onClose={() => setLogOpen(false)} />
      ) : null}
    </main>
  );
}

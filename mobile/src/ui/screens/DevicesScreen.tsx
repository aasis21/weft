import type { JSX } from 'react';
import type { ListenerDeviceState } from '@/session/model';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';

interface DevicesScreenProps {
  hasSessions: boolean;
  devices: ListenerDeviceState[];
  onRefreshProjects(channelId: string): void;
  onSetDefault(channelId: string): Promise<void>;
  onForget(channelId: string): Promise<void>;
  onStartOnDevice(channelId: string): void;
  onScanListener(): void;
  onCancel(): void;
}

/**
 * Full "connected devices" management screen (#186): every registered `helm-cli` listener, its
 * live status + last-seen time, and per-device actions — separate from StartSessionScreen (which
 * is scoped to launching ONE new session on ONE device). Reached from the sessions drawer/menu
 * as "Devices", distinct from "Join another session" (mirror an existing session by its QR) and
 * "Start another session" (spawn a new one via a device already registered here).
 */
export function DevicesScreen({
  hasSessions,
  devices,
  onRefreshProjects,
  onSetDefault,
  onForget,
  onStartOnDevice,
  onScanListener,
  onCancel,
}: DevicesScreenProps): JSX.Element {
  const sortedDevices = sortDevices(devices);

  return (
    <main className="helm-session join-session devices-screen">
      <div className="session-join-inner">
        <header className="session-join-head">
          <button type="button" className="session-pair-back" onClick={onCancel}>
            ← {hasSessions ? 'Back to sessions' : 'Back'}
          </button>
          <p className="session-join-kicker">Connected devices</p>
          <h2>Laptops registered with this phone</h2>
          <p className="session-join-hint">
            Each is a laptop running <code>helm-cli start</code>. Start a fresh Copilot session on
            one, or manage its default/projects here.
          </p>
        </header>

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
              return (
                <div key={device.channelId} className="device-card">
                  <div className="device-card-head">
                    <span className="device-card-name">
                      {deviceLabel(device)}
                      {device.isDefault ? <span className="tag">default</span> : null}
                    </span>
                    <div className={`device-status device-status-${status.tone}`}>
                      <span className="device-status-dot" aria-hidden="true" />
                      <span>{status.label}</span>
                      {lastSeen ? <span className="device-status-seen">· last seen {lastSeen}</span> : null}
                    </div>
                  </div>

                  <p className="device-card-sub">
                    {device.projectsLoading
                      ? 'Loading projects…'
                      : device.projects.length > 0
                        ? `${device.projects.length} project${device.projects.length === 1 ? '' : 's'} advertised`
                        : 'No projects received yet.'}
                  </p>
                  {device.error ? <p className="error-banner">{device.error}</p> : null}

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
                </div>
              );
            })}

            <button type="button" className="session-secondary-action" onClick={onScanListener}>
              + Scan another listener QR
            </button>
          </section>
        )}
      </div>
    </main>
  );
}

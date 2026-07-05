import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { SpawnMode } from '@aasis21/helm-shared';
import type { ListenerDeviceState } from '@/session/model';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';
import { DeviceAvatar } from '@/ui/screens/deviceGlyphs';

interface StartSessionScreenProps {
  hasSessions: boolean;
  devices: ListenerDeviceState[];
  /** Preselect a device (e.g. arriving from the "Start session" button on a DevicesScreen row)
   *  instead of defaulting to the top of the sorted list. */
  initialChannelId?: string;
  onConnectDevice(channelId: string): void;
  onRefreshProjects(channelId: string): void;
  onStart(channelId: string, opts: { projectName: string; mode: SpawnMode; name?: string }): Promise<void>;
  onForget(channelId: string): Promise<void>;
  onSetDefault(channelId: string): Promise<void>;
  onScanListener(): void;
  /** Jump to the full DevicesScreen list (manage every device, not just pick one to start). */
  onManageDevices?(): void;
  onCancel(): void;
}

export function StartSessionScreen({
  hasSessions,
  devices,
  initialChannelId,
  onConnectDevice,
  onRefreshProjects,
  onStart,
  onForget,
  onSetDefault,
  onScanListener,
  onManageDevices,
  onCancel,
}: StartSessionScreenProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string>(initialChannelId ?? '');
  const [projectName, setProjectName] = useState('');
  const [mode, setMode] = useState<SpawnMode>('default');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sortedDevices = sortDevices(devices);
  const selected = sortedDevices.find((d) => d.channelId === selectedId) ?? sortedDevices[0] ?? null;

  useEffect(() => {
    if (!selectedId && sortedDevices[0]) setSelectedId(sortedDevices[0].channelId);
  }, [selectedId, sortedDevices]);

  useEffect(() => {
    if (selected) onConnectDevice(selected.channelId);
  }, [selected?.channelId, onConnectDevice]);

  useEffect(() => {
    if (!selected) return;
    const defaultProject = selected.projects.find((p) => p.name === selected.lastProjectName)
      ?? selected.projects.find((p) => p.isDefault)
      ?? selected.projects[0];
    setProjectName(defaultProject?.name ?? '');
  }, [selected?.channelId, selected?.projects, selected?.lastProjectName]);

  const submit = async (): Promise<void> => {
    if (!selected || !projectName) return;
    setBusy(true);
    setError(null);
    try {
      await onStart(selected.channelId, { projectName, mode, name: name.trim() || undefined });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the session.');
      setBusy(false);
    }
  };

  return (
    <main className="helm-session join-session start-session-v2">
      <div className="session-join-inner">
        <header className="session-join-head">
          <button type="button" className="session-pair-back" onClick={onCancel}>
            ← {hasSessions ? 'Back to sessions' : 'Back'}
          </button>
          <p className="session-join-kicker">Start another session</p>
          <h2>Launch Copilot</h2>
          <p className="session-join-hint">Pick a laptop, pick a project, go.</p>
        </header>

        {sortedDevices.length === 0 ? (
          <section className="session-join-scanner start-empty">
            <p>No listener devices saved yet.</p>
            <button type="button" className="session-primary-action" onClick={onScanListener}>
              Scan a listener QR
            </button>
          </section>
        ) : (
          <>
            <section className="start-section">
              <h3 className="start-section-title">
                1. Device
                {sortedDevices.length > 1 ? <span className="start-section-count">{sortedDevices.length}</span> : null}
              </h3>
              <div className="start-device-list" role="radiogroup" aria-label="Listener device">
                {sortedDevices.map((device) => {
                  const status = deviceStatus(device);
                  const isSelected = device.channelId === selected?.channelId;
                  return (
                    <button
                      key={device.channelId}
                      type="button"
                      role="radio"
                      aria-checked={isSelected}
                      className={`start-device-card${isSelected ? ' selected' : ''}`}
                      onClick={() => setSelectedId(device.channelId)}
                    >
                      <DeviceAvatar tone={status.tone} />
                      <span className="start-device-info">
                        <span className="start-device-name">
                          {deviceLabel(device)}
                          {device.isDefault ? <span className="start-device-default">default</span> : null}
                        </span>
                        <span className={`start-device-status device-status-${status.tone}`}>
                          <span className="device-status-dot" aria-hidden="true" />
                          {status.label}
                          {formatLastSeen(device.lastSeenAt) ? ` · seen ${formatLastSeen(device.lastSeenAt)}` : ''}
                        </span>
                      </span>
                      <span className="start-device-check" aria-hidden="true">✓</span>
                    </button>
                  );
                })}
              </div>

              {selected ? (
                <div className="device-actions start-device-actions">
                  <button type="button" className="session-link-btn" onClick={() => void onRefreshProjects(selected.channelId)}>
                    ↻ Refresh
                  </button>
                  {!selected.isDefault ? (
                    <button type="button" className="session-link-btn" onClick={() => void onSetDefault(selected.channelId)}>
                      ⭐ Make default
                    </button>
                  ) : null}
                  <button type="button" className="session-link-btn danger" onClick={() => void onForget(selected.channelId)}>
                    🗑 Forget
                  </button>
                </div>
              ) : null}
            </section>

            <section className="start-section">
              <h3 className="start-section-title">2. Project</h3>
              {selected?.projectsLoading ? (
                <p className="session-join-hint start-loading">Loading projects from the listener…</p>
              ) : selected && selected.projects.length === 0 ? (
                <p className="session-join-hint">No projects received yet. Refresh after the listener is online.</p>
              ) : (
                <label className="session-field start-project-field">
                  <select
                    value={projectName}
                    disabled={!selected || selected.projects.length === 0}
                    onChange={(e) => setProjectName(e.target.value)}
                  >
                    {selected?.projects.map((project) => (
                      <option key={project.name} value={project.name}>
                        {project.name}{project.isDefault ? ' (default)' : ''}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {selected?.error ? <p className="error-banner">{selected.error}</p> : null}
            </section>

            <section className="start-section">
              <h3 className="start-section-title">3. Options</h3>
              <div className="start-mode-toggle" role="radiogroup" aria-label="Permission mode">
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'default'}
                  className={mode === 'default' ? 'selected' : ''}
                  onClick={() => setMode('default')}
                >
                  Default
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'allow-all'}
                  className={mode === 'allow-all' ? 'selected' : ''}
                  onClick={() => setMode('allow-all')}
                >
                  Allow all tools
                </button>
              </div>

              <label className="session-field start-name-field">
                <span>Session name (optional)</span>
                <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mobile bug sweep" />
              </label>
            </section>

            {error ? <p className="error-banner">{error}</p> : null}

            <div className="start-footer">
              <button
                type="button"
                className="session-primary-action"
                disabled={busy || !selected || !projectName || selected.projectsLoading}
                onClick={() => void submit()}
              >
                {busy ? 'Starting…' : `Start on ${selected ? deviceLabel(selected) : 'device'}`}
              </button>
              <div className="start-footer-links">
                <button type="button" className="session-link-btn" onClick={onScanListener}>
                  Scan another listener QR
                </button>
                {onManageDevices ? (
                  <button type="button" className="session-link-btn" onClick={onManageDevices}>
                    Manage all devices
                  </button>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

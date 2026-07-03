import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { SpawnMode } from '@aasis21/helm-shared';
import type { ListenerDeviceState } from '@/session/model';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';

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
    <main className="helm-session join-session start-session">
      <div className="session-join-inner">
        <header className="session-join-head">
          <button type="button" className="session-pair-back" onClick={onCancel}>
            ← {hasSessions ? 'Back to sessions' : 'Back'}
          </button>
          <p className="session-join-kicker">Start another session</p>
          <h2>Launch Copilot on a registered laptop</h2>
          <p className="session-join-hint">
            Choose a listener device, pick one of its advertised projects, then start a fresh session.
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
          <section className="session-join-fallback start-form">
            <label className="session-field">
              <span>Listener device</span>
              <select value={selected?.channelId ?? ''} onChange={(e) => setSelectedId(e.target.value)}>
                {sortedDevices.map((device) => {
                  const status = deviceStatus(device);
                  return (
                    <option key={device.channelId} value={device.channelId}>
                      {status.tone === 'online' ? '🟢' : status.tone === 'loading' ? '🟡' : '⚪️'} {deviceLabel(device)}
                      {device.isDefault ? ' (default)' : ''}
                    </option>
                  );
                })}
              </select>
            </label>

            {selected ? (
              <div className={`device-status device-status-${deviceStatus(selected).tone}`}>
                <span className="device-status-dot" aria-hidden="true" />
                <span>{deviceStatus(selected).label}</span>
                {formatLastSeen(selected.lastSeenAt) ? (
                  <span className="device-status-seen">· last seen {formatLastSeen(selected.lastSeenAt)}</span>
                ) : null}
              </div>
            ) : null}

            {selected ? (
              <div className="device-actions">
                <button type="button" className="session-link-btn" onClick={() => void onRefreshProjects(selected.channelId)}>
                  Refresh projects
                </button>
                <button type="button" className="session-link-btn" onClick={() => void onSetDefault(selected.channelId)}>
                  Make default
                </button>
                <button type="button" className="session-link-btn danger" onClick={() => void onForget(selected.channelId)}>
                  Forget
                </button>
              </div>
            ) : null}

            <label className="session-field">
              <span>Project</span>
              <select
                value={projectName}
                disabled={!selected || selected.projectsLoading || selected.projects.length === 0}
                onChange={(e) => setProjectName(e.target.value)}
              >
                {selected?.projects.map((project) => (
                  <option key={project.name} value={project.name}>
                    {project.name}{project.isDefault ? ' (default)' : ''}
                  </option>
                ))}
              </select>
            </label>
            {selected?.projectsLoading ? <p className="session-join-hint">Loading projects from the listener…</p> : null}
            {selected?.error ? <p className="error-banner">{selected.error}</p> : null}
            {selected && !selected.projectsLoading && selected.projects.length === 0 ? (
              <p className="session-join-hint">No projects received yet. Refresh after the listener is online.</p>
            ) : null}

            <fieldset className="session-field mode-field">
              <legend>Permission mode</legend>
              <label>
                <input type="radio" checked={mode === 'default'} onChange={() => setMode('default')} />
                Default
              </label>
              <label>
                <input type="radio" checked={mode === 'allow-all'} onChange={() => setMode('allow-all')} />
                Allow all tools
              </label>
            </fieldset>

            <label className="session-field">
              <span>Optional session name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mobile bug sweep" />
            </label>

            {error ? <p className="error-banner">{error}</p> : null}

            <button
              type="button"
              className="session-primary-action"
              disabled={busy || !selected || !projectName || selected.projectsLoading}
              onClick={() => void submit()}
            >
              {busy ? 'Starting…' : 'Start'}
            </button>
            <button type="button" className="session-secondary-action" onClick={onScanListener}>
              Scan another listener QR
            </button>
            {onManageDevices ? (
              <button type="button" className="session-link-btn" onClick={onManageDevices}>
                Manage all devices
              </button>
            ) : null}
          </section>
        )}
      </div>
    </main>
  );
}

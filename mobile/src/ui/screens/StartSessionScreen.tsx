import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import type { SpawnMode } from '@aasis21/weft-shared';
import type { ListenerDeviceState } from '@/session/model';
import type { SessionView } from '@/session/view';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';
import { DeviceAvatar } from '@/ui/screens/deviceGlyphs';
import { SessionDrawer } from '@/ui/sessions/SessionDrawer';

interface StartSessionScreenProps {
  hasSessions: boolean;
  devices: ListenerDeviceState[];
  /** Preselect a device (e.g. arriving from the "Start session" button on a DevicesScreen row)
   *  instead of defaulting to the top of the sorted list. */
  initialChannelId?: string;
  onConnectDevice(channelId: string): void;
  onStart(channelId: string, opts: { projectName: string; mode: SpawnMode; name?: string }): Promise<void>;
  onScanListener(): void;
  /** Jump to the full DevicesScreen list (manage every device, not just pick one to start). */
  onManageDevices?(): void;
  onCancel(): void;
  /** Same hamburger + sessions drawer every other screen shows (#186 nav consistency) — lets you
   *  jump straight to another live session, or back here from it, without losing this in-progress flow. */
  sessions: SessionView[];
  activeId: string | null;
  onSelectSession(channelId: string): void;
  onRemoveSession(channelId: string): void;
  onRenameSession(channelId: string, title: string): void;
  onGoHome(): void;
}

export function StartSessionScreen({
  hasSessions,
  devices,
  initialChannelId,
  onConnectDevice,
  onStart,
  onScanListener,
  onManageDevices,
  onCancel,
  sessions,
  activeId,
  onSelectSession,
  onRemoveSession,
  onRenameSession,
  onGoHome,
}: StartSessionScreenProps): JSX.Element {
  const [selectedId, setSelectedId] = useState<string>(initialChannelId ?? '');
  const [projectName, setProjectName] = useState('');
  const [mode, setMode] = useState<SpawnMode>('allow-all');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

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

  const onlineCount = sortedDevices.filter((d) => deviceStatus(d).tone === 'online').length;
  const deviceCountLabel = sortedDevices.length === 0
    ? 'No devices yet'
    : `${sortedDevices.length} device${sortedDevices.length === 1 ? '' : 's'} · ${onlineCount} online`;

  return (
    <main className="weft-session join-session start-session-v2">
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
          <span className="status-title">Start a session</span>
          <span className="status-line">
            <span className="status-dot" aria-hidden="true" />
            {deviceCountLabel}
          </span>
        </div>
        {hasSessions ? (
          <button className="icon-btn" type="button" onClick={onCancel} aria-label="Cancel">
            ✕
          </button>
        ) : null}
      </header>

      <div className="session-join-inner">
        {sortedDevices.length === 0 ? (
          <section className="session-join-scanner start-empty">
            <p>No devices saved yet.</p>
            <button type="button" className="session-primary-action" onClick={onScanListener}>
              Scan a device QR
            </button>
          </section>
        ) : (
          <>
            <section className="start-section">
              <h3 className="start-section-title">
                1. Device
                {sortedDevices.length > 1 ? <span className="start-section-count">{sortedDevices.length}</span> : null}
              </h3>
              <div className="start-device-list" role="radiogroup" aria-label="Device">
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

            </section>

            <section className="start-section">
              <h3 className="start-section-title">2. Project</h3>
              {selected?.projectsLoading ? (
                <p className="session-join-hint start-loading">Loading projects from the device…</p>
              ) : selected && selected.projects.length === 0 ? (
                <p className="session-join-hint">No projects received yet. Refresh after the device is online.</p>
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
                  Allow all
                </button>
              </div>
              {mode === 'allow-all' ? (
                <p className="start-mode-hint">
                  Grants full permissions: tools, file paths, and URLs run without confirmation.
                </p>
              ) : null}

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
            </div>
          </>
        )}
      </div>

      {drawerOpen ? (
        <SessionDrawer
          sessions={sessions}
          activeId={activeId}
          devices={devices}
          onStartOnDevice={(id) => {
            setDrawerOpen(false);
            setSelectedId(id);
          }}
          onSelect={(id) => {
            setDrawerOpen(false);
            onSelectSession(id);
          }}
          onAddSession={() => {
            setDrawerOpen(false);
            onScanListener();
          }}
          onRemove={onRemoveSession}
          onRename={onRenameSession}
          onOpenDevices={onManageDevices ? () => {
            setDrawerOpen(false);
            onManageDevices();
          } : undefined}
          onGoHome={() => {
            setDrawerOpen(false);
            onGoHome();
          }}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}
    </main>
  );
}

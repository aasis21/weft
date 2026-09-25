import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { LifecycleStatusMsg, SpawnMode } from '@aasis21/weft-shared';
import type { ListenerDeviceState } from '@/session/model';
import type { SessionView } from '@/session/view';
import {
  lifecycleFailureMessage,
  requiresTakeoverConfirmation,
  type SessionOpenIntent,
} from '@/session/access/sessionAccess';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';
import { DeviceAvatar, PlusGlyph } from '@/ui/screens/deviceGlyphs';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
import { useNowTick } from '@/ui/hooks/useNowTick';
import { ALL_FOLDERS, filterStoredSessions, folderOptions, isFiltering } from '@/ui/screens/sessionFilter';

/** Which of the two ways into a session this screen is showing. They share every step — device,
 *  folder, permissions — and differ only in what the folder step is choosing *within*. */
export type StartMode = 'new' | 'resume';

interface StartSessionScreenProps {
  hasSessions: boolean;
  devices: ListenerDeviceState[];
  /** Preselect a device (e.g. arriving from the "Start session" button on a DevicesScreen row)
   *  instead of defaulting to the top of the sorted list. */
  initialChannelId?: string | undefined;
  /** Open straight onto the Resume tab (arriving from "Resume a session" on a device). */
  initialMode?: StartMode;
  onConnectDevice(channelId: string): void;
  onOpen(intent: SessionOpenIntent): Promise<LifecycleStatusMsg>;
  onConfirmTakeover(operationId: string): Promise<LifecycleStatusMsg>;
  /** On-demand pull of the device's recent resumable CLI sessions. Never automatic: the store is
   *  large and rewritten every turn, and the reply arrives asynchronously. */
  onRefreshSessions(channelId: string, cwd?: string | null): void;
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
  initialMode,
  onConnectDevice,
  onOpen,
  onConfirmTakeover,
  onRefreshSessions,
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
  const [startMode, setStartMode] = useState<StartMode>(initialMode ?? 'new');
  const resuming = startMode === 'resume';
  const [projectName, setProjectName] = useState('');
  // Permission mode is shared by both tabs and starts from the selected laptop's configured
  // preference. A user's choice on this screen wins until they switch devices.
  const [mode, setMode] = useState<SpawnMode>('default');
  const modeTouchedRef = useRef(false);
  const modeDeviceRef = useRef<string | null>(null);
  const [name, setName] = useState('');
  const [nameEditing, setNameEditing] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<LifecycleStatusMsg | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Arriving with a device already chosen (the "Start session" / "Resume a session" buttons on a
   *  device row) means the device question is already answered, so step 1 opens collapsed to a
   *  single summary row. Coming in cold from home there is nothing to summarise, so it opens as
   *  the full list. Either way "Change" re-expands it — this only picks the starting state. */
  const [deviceOpen, setDeviceOpen] = useState(!initialChannelId);
  // --- resume-tab state -------------------------------------------------------------------------
  const [sessionQuery, setSessionQuery] = useState('');
  const [sessionFolder, setSessionFolder] = useState<string>(ALL_FOLDERS);
  const [resumeSessionId, setResumeSessionId] = useState<string>('');
  /** Whether the user has picked a folder themselves. The device's projects arrive asynchronously,
   *  so the default can't be a useState initialiser — and once it has been applied, a later refresh
   *  must not yank the picker back out from under a choice the user has made. */
  const folderTouchedRef = useRef(false);
  /** The `device|folder` pair the current `sessions` page was fetched for. The laptop now filters by
   *  folder BEFORE applying its cap, so a folder that is busier than the cap can only be seen in
   *  full by re-asking scoped to it — filtering the page we already have would silently show a
   *  truncated slice. Keyed by pair so switching folders re-pulls, and so the reply landing (which
   *  always sets an array, even an empty one) can't be mistaken for "still nothing, ask again". */
  const fetchedScopeRef = useRef<string>('');
  const now = useNowTick();

  const sortedDevices = sortDevices(devices);
  const selected = sortedDevices.find((d) => d.channelId === selectedId) ?? sortedDevices[0] ?? null;

  useEffect(() => {
    if (!selectedId && sortedDevices[0]) setSelectedId(sortedDevices[0].channelId);
  }, [selectedId, sortedDevices]);

  useEffect(() => {
    if (selected) onConnectDevice(selected.channelId);
  }, [selected?.channelId, onConnectDevice]);

  useEffect(() => {
    const deviceChanged = modeDeviceRef.current !== selected?.channelId;
    if (deviceChanged) {
      modeDeviceRef.current = selected?.channelId ?? null;
      modeTouchedRef.current = false;
    }
    if (!modeTouchedRef.current)
      setMode(selected?.defaultPermissionMode ?? 'default');
  }, [selected?.channelId, selected?.defaultPermissionMode]);

  useEffect(() => {
    if (!selected) return;
    const defaultProject = selected.projects.find((p) => p.name === selected.lastProjectName)
      ?? selected.projects.find((p) => p.isDefault)
      ?? selected.projects[0];
    setProjectName(defaultProject?.name ?? '');
  }, [selected?.channelId, selected?.projects, selected?.lastProjectName]);

  // --- resume derivations -----------------------------------------------------------------------
  const storeSessions = selected?.sessions ?? [];
  // Whether the resumable list has ever been pulled this run (undefined = never asked; the reply
  // always sets an array, even when empty). Drives "Load" vs "none found".
  const sessionsPulled = selected?.sessions !== undefined;
  // The folder this laptop is configured to default to. Sessions are almost always resumed in the
  // folder you work in, so the picker opens there rather than on the full unfiltered list.
  const defaultFolder = selected?.projects.find((p) => p.isDefault)?.path ?? null;
  // Registered projects and store cwds are different sets, so resume offers the union — see
  // folderOptions. New sessions stay registered-only, because you can only launch into a project.
  // The laptop's whole-store totals also keep every folder in the picker while the rows on hand are
  // scoped to one — without them, narrowing to a folder would empty the picker you narrowed with.
  const folderTotals = new Map<string, number>();
  for (const folder of selected?.sessionFolders ?? []) folderTotals.set(folder.cwd, folder.count);
  const folderChoices = folderOptions(
    storeSessions,
    selected?.projects.map((p) => p.path) ?? [],
    folderTotals.size > 0 ? folderTotals : undefined,
  );
  const activeFolder = folderChoices.some((f) => f.path === sessionFolder) ? sessionFolder : ALL_FOLDERS;
  const visibleSessions = filterStoredSessions(
    storeSessions,
    { query: sessionQuery, folder: activeFolder },
    folderChoices.map((f) => f.path),
  );

  // Sessions the phone is already driving, keyed by CLI session id: a store row that matches one is
  // "Open" (route to the card we have) rather than "Resume" (which would fork a second CLI).
  const liveBySessionId = new Map<string, SessionView>();
  for (const s of sessions) {
    if (s.meta.sessionId) liveBySessionId.set(s.meta.sessionId, s);
  }

  const chosenSession = visibleSessions.find((s) => s.sessionId === resumeSessionId) ?? null;
  const chosenLive = chosenSession ? liveBySessionId.get(chosenSession.sessionId) ?? null : null;

  useEffect(() => {
    if (folderTouchedRef.current || !defaultFolder) return;
    setSessionFolder(defaultFolder);
  }, [defaultFolder]);

  useEffect(() => {
    if (!nameEditing) return undefined;
    const keepNameVisible = (): void => {
      nameInputRef.current?.scrollIntoView({ block: 'center' });
    };
    const frame = window.requestAnimationFrame(keepNameVisible);
    window.visualViewport?.addEventListener('resize', keepNameVisible);
    return () => {
      window.cancelAnimationFrame(frame);
      window.visualViewport?.removeEventListener('resize', keepNameVisible);
    };
  }, [nameEditing]);

  // Opening the Resume tab is itself the request to see what is resumable, so pull the list rather
  // than parking behind a Load button — the empty and loading states already cover the wait. Only
  // while the device is connected: asking an offline laptop just produces a timeout. Re-pulls on
  // every folder change because the cap is applied by the laptop AFTER filtering.
  useEffect(() => {
    if (!resuming || !selected?.connected || selected.sessionsLoading) return;
    // The device's default folder arrives asynchronously with its project list; fetching "all"
    // first and then immediately re-fetching the default would flash a list we never meant to show.
    if (!folderTouchedRef.current && defaultFolder && sessionFolder !== defaultFolder) return;
    const scope = `${selected.channelId}|${sessionFolder}`;
    if (fetchedScopeRef.current === scope) return;
    fetchedScopeRef.current = scope;
    onRefreshSessions(selected.channelId, sessionFolder === ALL_FOLDERS ? null : sessionFolder);
  }, [
    resuming,
    selected?.channelId,
    selected?.connected,
    selected?.sessionsLoading,
    sessionFolder,
    defaultFolder,
    onRefreshSessions,
  ]);

  // A selection that scrolls out of the filtered list is no longer a thing the CTA can act on.
  useEffect(() => {
    if (resumeSessionId && !visibleSessions.some((s) => s.sessionId === resumeSessionId)) {
      setResumeSessionId('');
    }
  }, [resumeSessionId, visibleSessions]);

  const clearSessionFilters = (): void => {
    setSessionQuery('');
    // Clear returns to the device's default folder, not to everything — that default is the state
    // the screen opens in, so anything else would make Clear a different, wider view than the one
    // the user started from.
    folderTouchedRef.current = false;
    setSessionFolder(defaultFolder ?? ALL_FOLDERS);
  };

  const switchMode = (next: StartMode): void => {
    setStartMode(next);
    setError(null);
    setBlocked(null);
  };

  const applyStatus = (status: LifecycleStatusMsg): boolean => {
    if (requiresTakeoverConfirmation(status)) {
      setError(lifecycleFailureMessage(status.failure));
      setBlocked(status);
      setBusy(false);
      return false;
    }
    if (status.state !== 'failed') return true;
    setError(lifecycleFailureMessage(status.failure));
    setBlocked(null);
    setBusy(false);
    return false;
  };

  const submitNew = async (): Promise<void> => {
    if (!selected || !selected.connected || !projectName) return;
    setBusy(true);
    setError(null);
    try {
      applyStatus(await onOpen({
        deviceChannelId: selected.channelId,
        target: { kind: 'new', projectName },
        mode,
        name: name.trim() || null,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the session.');
      setBusy(false);
    }
  };

  const submitResume = async (): Promise<void> => {
    if (!selected || !selected.connected || !chosenSession) return;
    setBusy(true);
    setError(null);
    setBlocked(null);
    try {
      applyStatus(await onOpen({
        deviceChannelId: selected.channelId,
        target: {
          kind: 'existing',
          storeAuthority: null,
          sessionId: chosenSession.sessionId,
        },
        mode,
        title: chosenSession.title || chosenSession.cwd,
        cwd: chosenSession.cwd,
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the session.');
      setBusy(false);
    }
  };

  const submitTakeover = async (): Promise<void> => {
    if (!blocked) return;
    setBusy(true);
    setError(null);
    try {
      applyStatus(await onConfirmTakeover(blocked.operationId));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not take over the session.');
      setBusy(false);
    }
  };

  const onlineCount = sortedDevices.filter((d) => deviceStatus(d).tone === 'online').length;
  const deviceCountLabel = sortedDevices.length === 0
    ? 'No devices yet'
    : `${sortedDevices.length} device${sortedDevices.length === 1 ? '' : 's'} · ${onlineCount} online`;

  const forcing =
    blocked?.failure?.actions.includes('confirm-takeover') === true &&
    blocked.challenge?.sessionId === chosenSession?.sessionId;
  const ctaDisabled = busy
    || !selected
    || !selected.connected
    || (resuming ? !chosenSession : !projectName || selected.projectsLoading);
  const ctaLabel = resuming
    ? busy
      ? 'Resuming…'
      : chosenLive
        ? `Open ${chosenLive.meta.title || 'session'}`
        : forcing
          ? 'Close it and resume anyway'
          : `Resume on ${selected ? deviceLabel(selected) : 'device'}`
    : busy
      ? 'Starting…'
      : `Start on ${selected ? deviceLabel(selected) : 'device'}`;

  return (
    <main className={`weft-session join-session start-session-v2${nameEditing ? ' name-editing' : ''}`}>
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
          <span className="status-title">{resuming ? 'Resume a session' : 'Start a session'}</span>
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
            <p className="session-join-hint start-empty-explainer">
              A <strong>device</strong> is a laptop running <code>weft start</code>. Pair one here,
              then start <strong>sessions</strong> (live Copilot runs) on it from your phone.
            </p>
            <p>No devices saved yet.</p>
            <button type="button" className="session-primary-action" onClick={onScanListener}>
              Scan to connect
            </button>
          </section>
        ) : (
          <>
            <div className="start-mode-tabs" role="tablist" aria-label="New or resume">
              <button
                type="button"
                role="tab"
                aria-selected={!resuming}
                className={!resuming ? 'selected' : ''}
                onClick={() => switchMode('new')}
              >
                New session
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={resuming}
                className={resuming ? 'selected' : ''}
                onClick={() => switchMode('resume')}
              >
                Resume
              </button>
            </div>

            <section className="start-section">
              <h3 className="start-section-title">
                1. Device
                {sortedDevices.length > 1 && deviceOpen
                  ? <span className="start-section-count">{sortedDevices.length}</span>
                  : null}
                {deviceOpen || sortedDevices.length < 2 ? (
                  <button
                    type="button"
                    className="start-add-device"
                    onClick={onScanListener}
                    aria-label="Add a new device"
                  >
                    <span className="device-action-icon" aria-hidden="true"><PlusGlyph /></span>
                    Add device
                  </button>
                ) : (
                  <button
                    type="button"
                    className="session-link-btn"
                    onClick={() => setDeviceOpen(true)}
                  >
                    Change
                  </button>
                )}
              </h3>
              <div
                className="start-device-list"
                role={deviceOpen ? 'radiogroup' : undefined}
                aria-label={deviceOpen ? 'Device' : undefined}
              >
                {(deviceOpen ? sortedDevices : sortedDevices.filter((d) => d.channelId === selected?.channelId)).map((device) => {
                  const status = deviceStatus(device);
                  const isSelected = device.channelId === selected?.channelId;
                  const lastSeen = formatLastSeen(device.lastSeenAt, now);
                  return (
                    <button
                      key={device.channelId}
                      type="button"
                      role={deviceOpen ? 'radio' : undefined}
                      aria-checked={deviceOpen ? isSelected : undefined}
                      className={`start-device-card${isSelected ? ' selected' : ''}`}
                      onClick={() => (deviceOpen ? setSelectedId(device.channelId) : setDeviceOpen(true))}
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
                          {lastSeen ? ` · seen ${lastSeen}` : ''}
                          {device.connected && device.projectsLoading ? ' · refreshing projects…' : ''}
                        </span>
                      </span>
                      <span className="start-device-check" aria-hidden="true">✓</span>
                    </button>
                  );
                })}
              </div>

            </section>

            {resuming ? (
              <section className="start-section start-resume-section">
                <h3 className="start-section-title">
                  2. Folder &amp; session
                  <button
                    type="button"
                    className="session-link-btn"
                    onClick={() =>
                      selected &&
                      onRefreshSessions(
                        selected.channelId,
                        activeFolder === ALL_FOLDERS ? null : activeFolder,
                      )
                    }
                    disabled={!selected || selected.sessionsLoading}
                  >
                    {selected?.sessionsLoading ? 'Loading…' : sessionsPulled ? 'Refresh' : 'Load'}
                  </button>
                </h3>
                <div className="session-filter-bar">
                  <select
                    className="session-filter-folder"
                    aria-label="Folder"
                    value={activeFolder}
                    onChange={(e) => {
                      folderTouchedRef.current = true;
                      setSessionFolder(e.currentTarget.value);
                    }}
                  >
                    <option value={ALL_FOLDERS}>All folders ({storeSessions.length})</option>
                    {folderChoices.map((folder) => (
                      <option key={folder.path} value={folder.path} title={folder.path}>
                        {folder.label} ({folder.count})
                      </option>
                    ))}
                  </select>
                  <input
                    type="search"
                    className="session-filter-search"
                    placeholder="Search title, repo or branch"
                    aria-label="Search recent sessions"
                    value={sessionQuery}
                    onChange={(e) => setSessionQuery(e.currentTarget.value)}
                  />
                </div>
                {storeSessions.length === 0 ? (
                  <p className="session-join-hint">
                    {selected?.sessionsLoading
                      ? 'Loading sessions…'
                      : sessionsPulled
                        ? 'No resumable sessions found on this device.'
                        : selected?.connected
                          ? 'Loading sessions…'
                          : 'Device is offline — reconnect it to see resumable sessions.'}
                  </p>
                ) : (
                  <>
                    {isFiltering({ query: sessionQuery, folder: activeFolder }) ? (
                      <p className="device-card-sub session-filter-count">
                        Showing {visibleSessions.length} of {storeSessions.length}
                        <button type="button" className="session-link-btn" onClick={clearSessionFilters}>
                          Clear
                        </button>
                      </p>
                    ) : null}
                    {visibleSessions.length === 0 ? (
                      <p className="session-join-hint">No sessions match this filter.</p>
                    ) : (
                      <ul className="devices-list device-sessions-list" role="radiogroup" aria-label="Session to resume">
                        {visibleSessions.map((s) => {
                          const live = liveBySessionId.get(s.sessionId);
                          const subtitle = [s.repository, s.branch].filter(Boolean).join(' · ') || s.cwd;
                          const when = formatLastSeen(s.updatedAt ?? undefined, now);
                          const label = s.title || s.cwd;
                          const isChosen = s.sessionId === resumeSessionId;
                          return (
                            <li key={s.sessionId} className="device-card device-session-row">
                              <button
                                type="button"
                                role="radio"
                                aria-checked={isChosen}
                                className={`device-session-open${isChosen ? ' selected' : ''}`}
                                onClick={() => {
                                  setResumeSessionId(s.sessionId);
                                  setError(null);
                                }}
                              >
                                <span className="device-session-main">
                                  <span className="device-card-name">{label}</span>
                                  {when ? <span className="device-session-age">{when}</span> : null}
                                </span>
                                <span className="device-card-sub device-session-status">
                                  {live ? 'already on this phone' : 'resumable'}
                                  {subtitle ? ` · ${subtitle}` : ''}
                                </span>
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    )}
                  </>
                )}
                {selected?.error ? <p className="error-banner">{selected.error}</p> : null}
              </section>
            ) : (
              <section className="start-section">
                <h3 className="start-section-title">2. Folder</h3>
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
            )}

            <section className="start-section">
              <h3 className="start-section-title">3. Options</h3>
              {resuming ? null : (
                <label className="session-field start-name-field">
                  <span>Session name (optional)</span>
                  <input
                    ref={nameInputRef}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    onFocus={() => setNameEditing(true)}
                    onBlur={() => setNameEditing(false)}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || ctaDisabled) return;
                      e.preventDefault();
                      setNameEditing(false);
                      e.currentTarget.blur();
                      void submitNew();
                    }}
                    enterKeyHint="go"
                    placeholder="e.g. Mobile bug sweep"
                  />
                </label>
              )}
              <span className="start-field-label" id="start-mode-label">Permissions</span>
              <div className="start-mode-toggle" role="radiogroup" aria-labelledby="start-mode-label">
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'default'}
                  className={mode === 'default' ? 'selected' : ''}
                  onClick={() => {
                    modeTouchedRef.current = true;
                    setMode('default');
                  }}
                >
                  Default
                </button>
                <button
                  type="button"
                  role="radio"
                  aria-checked={mode === 'allow-all'}
                  className={mode === 'allow-all' ? 'selected' : ''}
                  onClick={() => {
                    modeTouchedRef.current = true;
                    setMode('allow-all');
                  }}
                >
                  Allow all
                </button>
              </div>
              {mode === 'allow-all' ? (
                <p className="start-mode-hint">
                  Grants full permissions: tools, file paths, and URLs run without confirmation.
                </p>
              ) : null}
            </section>

            {error ? <p className="error-banner">{error}</p> : null}

            <div className="start-footer">
              <button
                type="button"
                className="session-primary-action"
                disabled={ctaDisabled}
                title={selected && !selected.connected ? 'Device is offline — reconnect it to start a session.' : undefined}
                onClick={() => void (resuming ? (forcing ? submitTakeover() : submitResume()) : submitNew())}
              >
                {ctaLabel}
              </button>
            </div>
          </>
        )}
      </div>

      {drawerOpen ? (
        <WeftDrawer
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

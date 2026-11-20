import { useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { LifecycleStatusMsg, SpawnMode, StoredSession } from '@aasis21/weft-shared';
import type { ListenerDeviceState } from '@/session/model';
import type { SessionView } from '@/session/view';
import {
  lifecycleFailureMessage,
  requiresTakeoverConfirmation,
  type SessionOpenIntent,
} from '@/session/access/sessionAccess';
import { deviceLabel, deviceStatus, formatLastSeen, sortDevices } from '@/ui/screens/deviceDisplay';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
import { useNowTick } from '@/ui/hooks/useNowTick';
import { filterStoredSessions } from '@/ui/screens/sessionFilter';

/** Where the screen was opened from. Both lead to the same page: a composer for a new session and
 *  the folder's recent sessions below it. `resume` opens with session search ready. */
export type StartMode = 'new' | 'resume';

interface StartSessionScreenProps {
  hasSessions: boolean;
  devices: ListenerDeviceState[];
  /** Preselect a device (e.g. arriving from a device row) instead of the top of the sorted list. */
  initialChannelId?: string | undefined;
  initialMode?: StartMode;
  onConnectDevice(channelId: string): void;
  onOpen(intent: SessionOpenIntent): Promise<LifecycleStatusMsg>;
  onConfirmTakeover(operationId: string): Promise<LifecycleStatusMsg>;
  /** Pull the folder's recent CLI/app sessions from the device. */
  onRefreshSessions(channelId: string, cwd?: string | null): void;
  onScanListener(): void;
  /** Jump to the full DevicesScreen list (manage every device, not just pick one to start). */
  onManageDevices?(): void;
  onCancel(): void;
  sessions: SessionView[];
  activeId: string | null;
  onSelectSession(channelId: string): void;
  onRemoveSession(channelId: string): void;
  onRenameSession(channelId: string, title: string): void;
  onGoHome(): void;
}

const MAX_COMPOSER_HEIGHT = 220;

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
  const [projectName, setProjectName] = useState('');
  // Starts from the selected laptop's configured preference; a choice here wins until the device changes.
  const [mode, setMode] = useState<SpawnMode>('default');
  const modeTouchedRef = useRef(false);
  const modeDeviceRef = useRef<string | null>(null);
  const [message, setMessage] = useState('');
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const [busy, setBusy] = useState(false);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<LifecycleStatusMsg | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(initialMode === 'resume');
  const [query, setQuery] = useState('');
  /** The `device|folder|attempt` the current list was fetched for. The laptop caps its reply after
   *  filtering by folder, so every folder change re-asks rather than narrowing a page on hand; a
   *  reply always sets an array, so an empty answer is not mistaken for "ask again". */
  const fetchedScopeRef = useRef<string>('');
  const now = useNowTick();

  const sortedDevices = sortDevices(devices);
  const selected = sortedDevices.find((d) => d.channelId === selectedId) ?? sortedDevices[0] ?? null;
  const project = selected?.projects.find((p) => p.name === projectName) ?? null;
  const folderPath = project?.path ?? null;

  useEffect(() => {
    if (!selectedId && sortedDevices[0]) setSelectedId(sortedDevices[0].channelId);
  }, [selectedId, sortedDevices]);

  useEffect(() => {
    if (selected) onConnectDevice(selected.channelId);
  }, [selected?.channelId, onConnectDevice]);

  useEffect(() => {
    if (modeDeviceRef.current !== selected?.channelId) {
      modeDeviceRef.current = selected?.channelId ?? null;
      modeTouchedRef.current = false;
    }
    if (!modeTouchedRef.current) setMode(selected?.defaultPermissionMode ?? 'default');
  }, [selected?.channelId, selected?.defaultPermissionMode]);

  useEffect(() => {
    if (!selected) return;
    const fallback = selected.projects.find((p) => p.name === selected.lastProjectName)
      ?? selected.projects.find((p) => p.isDefault)
      ?? selected.projects[0];
    setProjectName((current) =>
      selected.projects.some((p) => p.name === current) ? current : fallback?.name ?? '');
  }, [selected?.channelId, selected?.projects, selected?.lastProjectName]);

  // Past sessions are limited to registered folders: the list always follows the folder a new
  // session would start in, and loads on its own when the page opens or the device/folder changes.
  useEffect(() => {
    if (!selected?.connected || !folderPath) {
      fetchedScopeRef.current = '';
      return;
    }
    if (selected.sessionsLoading) return;
    const scope = `${selected.channelId}|${folderPath}|${selected.lastAttemptAt ?? 0}`;
    if (fetchedScopeRef.current === scope) return;
    fetchedScopeRef.current = scope;
    onRefreshSessions(selected.channelId, folderPath);
  }, [
    selected?.channelId,
    selected?.connected,
    selected?.sessionsLoading,
    selected?.lastAttemptAt,
    folderPath,
    onRefreshSessions,
  ]);

  useEffect(() => {
    if (!selected?.connected || !folderPath) return undefined;
    const refreshOnReturn = (): void => {
      if (document.visibilityState === 'visible' && !selected.sessionsLoading) {
        onRefreshSessions(selected.channelId, folderPath);
      }
    };
    document.addEventListener('visibilitychange', refreshOnReturn);
    return () => document.removeEventListener('visibilitychange', refreshOnReturn);
  }, [selected?.channelId, selected?.connected, selected?.sessionsLoading, folderPath, onRefreshSessions]);

  const resizeComposer = (): void => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_HEIGHT)}px`;
  };

  const storeSessions = selected?.sessions ?? [];
  const sessionsPulled = selected?.sessions !== undefined;
  const folderSessions: StoredSession[] = folderPath
    ? filterStoredSessions(storeSessions, { query, folder: folderPath }, [folderPath])
    : [];
  const liveBySessionId = new Map<string, SessionView>();
  for (const s of sessions) {
    if (s.meta.sessionId) liveBySessionId.set(s.meta.sessionId, s);
  }

  const applyStatus = (status: LifecycleStatusMsg): void => {
    if (requiresTakeoverConfirmation(status)) {
      setError(lifecycleFailureMessage(status.failure));
      setBlocked(status);
      setBusy(false);
      setOpeningId(null);
      return;
    }
    if (status.state !== 'failed') return;
    setError(lifecycleFailureMessage(status.failure));
    setBlocked(null);
    setBusy(false);
    setOpeningId(null);
  };

  const fail = (err: unknown, fallback: string): void => {
    setError(err instanceof Error ? err.message : fallback);
    setBusy(false);
    setOpeningId(null);
  };

  const online = Boolean(selected?.connected);
  const canStart = !busy && online && Boolean(projectName) && !selected?.projectsLoading;

  const submitNew = async (): Promise<void> => {
    if (!selected || !canStart) return;
    setBusy(true);
    setError(null);
    setBlocked(null);
    const initialPrompt = message.trim();
    try {
      // The draft stays in state until the screen closes, so a refused launch keeps the text.
      applyStatus(await onOpen({
        deviceChannelId: selected.channelId,
        target: { kind: 'new', projectName },
        mode,
        name: null,
        ...(initialPrompt ? { initialPrompt } : {}),
      }));
    } catch (err) {
      fail(err, 'Could not start the session.');
    }
  };

  const openStored = async (stored: StoredSession): Promise<void> => {
    if (!selected || !online || busy) return;
    setBusy(true);
    setOpeningId(stored.sessionId);
    setError(null);
    setBlocked(null);
    try {
      applyStatus(await onOpen({
        deviceChannelId: selected.channelId,
        target: { kind: 'existing', storeAuthority: null, sessionId: stored.sessionId },
        mode,
        title: stored.title || stored.cwd,
        cwd: stored.cwd,
      }));
    } catch (err) {
      fail(err, 'Could not open the session.');
    }
  };

  const submitTakeover = async (): Promise<void> => {
    if (!blocked) return;
    setBusy(true);
    setError(null);
    try {
      applyStatus(await onConfirmTakeover(blocked.operationId));
    } catch (err) {
      fail(err, 'Could not take over the session.');
    }
  };

  const canTakeOver = blocked?.failure?.actions.includes('confirm-takeover') === true;
  const status = selected ? deviceStatus(selected) : null;
  const lastSeen = selected ? formatLastSeen(selected.lastSeenAt, now) : null;
  const hasText = message.trim().length > 0;
  const sendLabel = busy && !openingId ? 'Starting…' : hasText ? 'Start & send' : 'Start session';
  const folderLabel = project?.name ?? 'this folder';

  const listBody = (): JSX.Element => {
    if (!online) return <p className="start-hint">Sessions appear when {selected ? deviceLabel(selected) : 'the device'} is online.</p>;
    if (!folderPath) return <p className="start-hint">No folders on this device yet.</p>;
    if (selected?.sessionsLoading || !sessionsPulled) {
      return (
        <ul className="start-continue-list" aria-label="Loading sessions" aria-busy="true">
          {[0, 1, 2].map((i) => <li key={i} className="start-continue-skeleton" />)}
        </ul>
      );
    }
    if (folderSessions.length === 0) {
      return (
        <p className="start-hint">
          {query.trim() ? 'No sessions match your search.' : `No sessions in ${folderLabel} yet.`}
        </p>
      );
    }
    return (
      <ul className="start-continue-list" aria-label="Recent sessions">
        {folderSessions.map((s) => {
          const live = liveBySessionId.get(s.sessionId);
          const when = formatLastSeen(s.updatedAt ?? undefined, now);
          const detail = [s.branch, live ? 'open on this phone' : null].filter(Boolean).join(' · ');
          const opening = openingId === s.sessionId;
          return (
            <li key={s.sessionId}>
              <button
                type="button"
                className={`start-continue-row${opening ? ' opening' : ''}`}
                disabled={busy}
                onClick={() => void openStored(s)}
              >
                <span className="start-continue-main">
                  <span className="start-continue-title">{s.title || 'Untitled session'}</span>
                  <span className="start-continue-meta">
                    {s.running || live ? <span className="start-live-dot" aria-label="Running" /> : null}
                    {opening ? 'Opening…' : when}
                  </span>
                </span>
                {detail ? <span className="start-continue-detail">{detail}</span> : null}
              </button>
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <main className="weft-session join-session start-session-v3">
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
          <span className="status-title">New session</span>
          {selected && status ? (
            <span className={`status-line device-status-${status.tone}`}>
              <span className="device-status-dot" aria-hidden="true" />
              {status.tone === 'online' || !lastSeen ? status.label : `${status.label} · seen ${lastSeen}`}
            </span>
          ) : null}
        </div>
        {hasSessions ? (
          <button className="icon-btn" type="button" onClick={onCancel} aria-label="Close">
            ✕
          </button>
        ) : null}
      </header>

      <div className="session-join-inner start-page">
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
            <div className="start-pickers">
              <label className={`start-picker device-status-${status?.tone ?? 'offline'}`}>
                <span className="device-status-dot" aria-hidden="true" />
                <select
                  aria-label="Device"
                  value={selected?.channelId ?? ''}
                  onChange={(e) => setSelectedId(e.currentTarget.value)}
                >
                  {sortedDevices.map((device) => (
                    <option key={device.channelId} value={device.channelId}>
                      {`${deviceLabel(device)} · ${deviceStatus(device).label}`}
                    </option>
                  ))}
                </select>
              </label>
              <label className="start-picker">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path fill="currentColor" d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2h7A2.5 2.5 0 0 1 21 8.5v9a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5z" />
                </svg>
                <select
                  aria-label="Folder"
                  value={projectName}
                  disabled={!selected || selected.projects.length === 0}
                  onChange={(e) => {
                    setProjectName(e.currentTarget.value);
                    setError(null);
                    setBlocked(null);
                  }}
                >
                  {selected && selected.projects.length === 0 ? (
                    <option value="">{selected.projectsLoading ? 'Loading folders…' : 'No folders'}</option>
                  ) : null}
                  {selected?.projects.map((p) => (
                    <option key={p.name} value={p.name}>{p.name}</option>
                  ))}
                </select>
              </label>
            </div>

            <form
              className="composer-shell start-composer"
              aria-label="New session"
              onSubmit={(e) => {
                e.preventDefault();
                void submitNew();
              }}
            >
              <textarea
                ref={composerRef}
                className="composer-input start-composer-input"
                aria-label="First message"
                placeholder={online ? 'What should Copilot work on?' : `${selected ? deviceLabel(selected) : 'Device'} is offline`}
                rows={3}
                value={message}
                onChange={(e) => {
                  setMessage(e.currentTarget.value);
                  resizeComposer();
                }}
              />
              <div className="composer-controls">
                <div className="composer-controls-left">
                  <button
                    type="button"
                    className={`start-perm-chip${mode === 'allow-all' ? ' auto' : ''}`}
                    aria-label={`Permissions: ${mode === 'allow-all' ? 'Allow all' : 'Ask first'}`}
                    onClick={() => {
                      modeTouchedRef.current = true;
                      setMode(mode === 'allow-all' ? 'default' : 'allow-all');
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      {mode === 'allow-all'
                        ? <path fill="currentColor" d="M13 2 4 14h6l-1 8 9-12h-6z" />
                        : <path fill="currentColor" d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" />}
                    </svg>
                    {mode === 'allow-all' ? 'Allow all' : 'Ask first'}
                  </button>
                </div>
                <div className="composer-controls-right">
                  <button
                    type="submit"
                    className="send-btn"
                    disabled={!canStart}
                    aria-label={sendLabel}
                    title={sendLabel}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path fill="currentColor" d="M12 5l6.5 6.5-1.4 1.4L13 8.8V19h-2V8.8l-4.1 4.1-1.4-1.4z" />
                    </svg>
                  </button>
                </div>
              </div>
            </form>

            {error ? (
              <div className="error-banner start-error">
                <span>{error}</span>
                {canTakeOver ? (
                  <button type="button" className="session-link-btn" disabled={busy} onClick={() => void submitTakeover()}>
                    Close it and open here
                  </button>
                ) : null}
              </div>
            ) : null}
            {selected?.error ? <p className="error-banner">{selected.error}</p> : null}

            <section className="start-continue" aria-label="Continue a session">
              <div className="start-continue-head">
                <h2>Continue in {folderLabel}</h2>
                {online && folderPath ? (
                  <button
                    type="button"
                    className="icon-btn start-search-btn"
                    aria-label="Search sessions"
                    aria-expanded={searchOpen}
                    onClick={() => {
                      if (searchOpen) setQuery('');
                      setSearchOpen(!searchOpen);
                    }}
                  >
                    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                      <path fill="currentColor" d="M10.5 4a6.5 6.5 0 0 1 5.2 10.4l4.4 4.4-1.4 1.4-4.4-4.4A6.5 6.5 0 1 1 10.5 4zm0 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9z" />
                    </svg>
                  </button>
                ) : null}
              </div>
              {searchOpen && online && folderPath ? (
                <input
                  type="search"
                  className="start-search"
                  placeholder="Search by title or branch"
                  aria-label="Search recent sessions"
                  value={query}
                  autoFocus={initialMode !== 'resume'}
                  onChange={(e) => setQuery(e.currentTarget.value)}
                />
              ) : null}
              {listBody()}
            </section>
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

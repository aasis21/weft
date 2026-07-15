import { useState } from 'react';
import type { JSX } from 'react';
import type { SpawnMode } from '@aasis21/weft-shared';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { deviceLabel, deviceStatus, formatLastSeen } from '@/ui/screens/deviceDisplay';
import { DeviceAvatar } from '@/ui/screens/deviceGlyphs';
import { DebugPanel } from '@/ui/diagnostics/DebugPanel';
import { WeftDrawer } from '@/ui/sessions/WeftDrawer';
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
  /** On-demand pull of this device's recent resumable CLI sessions (the "Resume a session" list). */
  onRefreshSessions(channelId: string): void;
  /** Resume a past CLI session: spawn `copilot --resume=<id>` in its cwd and pair to it. */
  onResumeSession(deviceChannelId: string, sessionId: string, mode: SpawnMode, title: string, cwd: string): void;
  onSetDefault(channelId: string): Promise<void>;
  onForget(channelId: string): Promise<void>;
  onStartOnDevice(channelId: string): void;
  onOpenDeviceDetails?(channelId: string): void;
  onJoinOffer(deviceChannelId: string, offerChannelId: string): void;
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
  onRefreshSessions,
  onResumeSession,
  onSetDefault,
  onForget,
  onStartOnDevice,
  onOpenDeviceDetails,
  onJoinOffer,
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
  const [resumeMode, setResumeMode] = useState<SpawnMode>('allow-all');
  const status = deviceStatus(device);
  const lastSeen = formatLastSeen(device.lastSeenAt);
  const deviceKey = device.deviceId ?? device.channelId;
  const spawnedSessions = sessions
    .filter((s) => (s.meta.spawnedFromDeviceId ?? '') === deviceKey)
    .sort((a, b) => (b.lastEventAt ?? b.meta.addedAt) - (a.lastEventAt ?? a.meta.addedAt));
  // Sessions this laptop opened `/weft` in and is offering for one-tap adoption. Hide any whose
  // channel we already track (already joined) so a lingering offer can't show a duplicate row.
  const tracked = new Set(sessions.map((s) => s.meta.channelId));
  const offers = (device.offers ?? []).filter((o) => o && o.channelId && !tracked.has(o.channelId));

  // Dedupe the resumable-session list against sessions we're already driving: a store row whose CLI
  // sessionId matches a live/spawning card on the phone is "Open" (route to it), not "Resume" (which
  // would launch a second `copilot --resume` on an already-attached session). Keyed on meta.sessionId
  // — the CLI session UUID, populated from session_meta on live sessions.
  const liveBySessionId = new Map<string, SessionView>();
  for (const s of sessions) {
    if (s.meta.sessionId) liveBySessionId.set(s.meta.sessionId, s);
  }
  const storeSessions = device.sessions ?? [];
  // Whether the resumable-session list has ever been pulled this run (undefined = never asked; the
  // reply always sets it to an array, even if empty). Drives the "Load sessions" vs "none found"
  // empty state. The pull is strictly manual (a button) — never auto-run on mount — because the
  // session store is large and rewritten every turn, and the comms are async (the reply arrives
  // later via SESSION_LIST), so a blocking auto-load would just make the screen look stuck.
  const sessionsPulled = device.sessions !== undefined;

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

        {offers.length > 0 ? (
          <section className="session-join-fallback device-offers">
            <h3>Offered sessions</h3>
            <p className="device-card-sub">
              Sessions this laptop opened with <code>/weft</code> — tap to join, no QR needed.
            </p>
            <ul className="devices-list device-sessions-list">
              {offers.map((offer) => (
                <li key={offer.channelId} className="device-card device-session-row">
                  <button
                    type="button"
                    className="device-session-open"
                    onClick={() => onJoinOffer(device.channelId, offer.channelId)}
                  >
                    <span className="device-card-name">{offer.name || offer.cwd || 'Copilot session'}</span>
                    {offer.cwd && offer.name ? (
                      <span className="device-card-sub device-session-status">{offer.cwd}</span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <section className="session-join-fallback device-sessions device-resume">
          <div className="device-resume-head">
            <h3>Resume a session</h3>
            <button
              type="button"
              className="session-link-btn"
              onClick={() => onRefreshSessions(device.channelId)}
              disabled={device.sessionsLoading}
            >
              {device.sessionsLoading ? 'Loading…' : sessionsPulled ? 'Refresh' : 'Load'}
            </button>
          </div>
          <p className="device-card-sub">
            Recent Copilot CLI sessions on this laptop — tap Load, then pick one to reopen on your phone.
          </p>
          <div className="start-mode-toggle" role="radiogroup" aria-label="Permission mode for resumed session">
            <button
              type="button"
              role="radio"
              aria-checked={resumeMode === 'default'}
              className={resumeMode === 'default' ? 'selected' : ''}
              onClick={() => setResumeMode('default')}
            >
              Default
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={resumeMode === 'allow-all'}
              className={resumeMode === 'allow-all' ? 'selected' : ''}
              onClick={() => setResumeMode('allow-all')}
            >
              Allow all
            </button>
          </div>
          {storeSessions.length === 0 ? (
            <p className="device-card-sub">
              {device.sessionsLoading
                ? 'Loading sessions…'
                : sessionsPulled
                  ? 'No resumable sessions found.'
                  : 'Tap Load to fetch this laptop’s recent sessions.'}
            </p>
          ) : (
            <ul className="devices-list device-sessions-list">
              {storeSessions.map((s) => {
                const live = liveBySessionId.get(s.sessionId);
                const subtitle = [s.repository, s.branch].filter(Boolean).join(' · ') || s.cwd;
                const when = formatLastSeen(s.updatedAt ?? undefined);
                const label = s.title || s.cwd;
                return (
                  <li key={s.sessionId} className="device-card device-session-row">
                    <button
                      type="button"
                      className="device-session-open"
                      onClick={() =>
                        live
                          ? onOpenSession(live.meta.channelId)
                          : onResumeSession(device.channelId, s.sessionId, resumeMode, label, s.cwd)
                      }
                    >
                      <span className="device-card-name">{label}</span>
                      <span className="device-card-sub device-session-status">
                        {live ? 'live · Open' : 'Resume'}
                        {subtitle ? ` · ${subtitle}` : ''}
                        {when ? ` · ${when}` : ''}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
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
        <WeftDrawer
          sessions={sessions}
          activeId={activeId}
          devices={devices}
          onStartOnDevice={(id) => {
            setDrawerOpen(false);
            onStartOnDevice(id);
          }}
          onOpenDeviceDetails={onOpenDeviceDetails ? (id) => {
            setDrawerOpen(false);
            onOpenDeviceDetails(id);
          } : undefined}
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

      {settingsOpen ? <SettingsScreen onClose={() => setSettingsOpen(false)} laptopVersion={device.appVersion} /> : null}
    </main>
  );
}

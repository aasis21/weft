import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import type { SessionMode } from '@aasis21/weft-shared';
import { LandingScreen } from '@/ui/screens/LandingScreen';
import { JoinSessionScreen } from '@/ui/screens/JoinSessionScreen';
import { StartSessionScreen } from '@/ui/screens/StartSessionScreen';
import { DevicesScreen } from '@/ui/screens/DevicesScreen';
import { DeviceDetailsScreen } from '@/ui/screens/DeviceDetailsScreen';
import { SessionScreen } from '@/ui/screens/SessionScreen';
import { isNativeRuntime } from '@/ui/hooks/usePairing';
import { sessionRuntime } from '@/session/runtime/instance';

type ModalHistoryState = { weftView: 'devices' } | { weftView: 'device-details'; channelId: string } | null;

export default function App(): JSX.Element {
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startDeviceId, setStartDeviceId] = useState<string | undefined>(undefined);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [deviceDetailsChannelId, setDeviceDetailsChannelId] = useState<string | undefined>(undefined);
  const [addManual, setAddManual] = useState(false);
  // What the user tapped to get to the scanner — sets the JoinSessionScreen copy so "Add a
  // device" doesn't read as "Join a session" (or vice versa). The QR payload's own `kind`
  // still decides what actually happens; this only avoids the scanner looking mismatched (#weft-scan-ux).
  const [joinPurpose, setJoinPurpose] = useState<'session' | 'device'>('session');
  const [showLanding, setShowLanding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void sessionRuntime.init();
  }, []);

  // Devices / Device details have no dedicated in-page back button — the phone's own Back
  // gesture (or the browser Back button on web) closes them, via history entries we push when
  // opening each one. `null` state means "neither is open" (whatever screen would render below).
  useEffect(() => {
    const onPopState = (event: PopStateEvent): void => {
      const state = event.state as ModalHistoryState;
      if (state?.weftView === 'devices') {
        setDevicesOpen(true);
        setDeviceDetailsChannelId(undefined);
      } else if (state?.weftView === 'device-details') {
        setDevicesOpen(false);
        setDeviceDetailsChannelId(state.channelId);
      } else {
        setDevicesOpen(false);
        setDeviceDetailsChannelId(undefined);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openJoin = useCallback((manual = false, purpose: 'session' | 'device' = 'session'): void => {
    window.history.replaceState(null, '');
    setError(null);
    setAddManual(manual);
    setJoinPurpose(purpose);
    setStarting(false);
    setDevicesOpen(false);
    setDeviceDetailsChannelId(undefined);
    setAdding(true);
  }, []);

  const openStart = useCallback((channelId?: string): void => {
    window.history.replaceState(null, '');
    setError(null);
    setAdding(false);
    setDevicesOpen(false);
    setDeviceDetailsChannelId(undefined);
    setStartDeviceId(channelId);
    setStarting(true);
  }, []);

  const openDevices = useCallback((): void => {
    setError(null);
    setAdding(false);
    setStarting(false);
    setDeviceDetailsChannelId(undefined);
    setDevicesOpen(true);
    window.history.pushState({ weftView: 'devices' } satisfies ModalHistoryState, '');
  }, []);

  const openDeviceDetails = useCallback((channelId: string): void => {
    setError(null);
    setAdding(false);
    setStarting(false);
    setDevicesOpen(false);
    setDeviceDetailsChannelId(channelId);
    window.history.pushState({ weftView: 'device-details', channelId } satisfies ModalHistoryState, '');
  }, []);

  const handlePair = useCallback(async (raw: string): Promise<void> => {
    const route = await sessionRuntime.addByQr(raw);
    setAdding(false);
    setShowLanding(false);
    if (route.startsWith('listener:')) {
      openDeviceDetails(route.slice('listener:'.length));
    }
  }, [openDeviceDetails]);

  const closeDeviceScreens = useCallback((): void => {
    window.history.replaceState(null, '');
    setDevicesOpen(false);
    setDeviceDetailsChannelId(undefined);
  }, []);

  const handleVoiceModeChange = useCallback((channelId: string, active: boolean): void => {
    void sessionRuntime.setVoiceMode(active, channelId);
  }, []);

  const handleDemo = useCallback(async (): Promise<void> => {
    window.history.replaceState(null, '');
    await sessionRuntime.addDemo();
    setAdding(false);
    setShowLanding(false);
  }, []);

  const activeId = snapshot.activeId;
  const active = snapshot.sessions.find((s) => s.meta.channelId === activeId) ?? snapshot.sessions[0] ?? null;
  const hasSessions = snapshot.sessions.length > 0;

  // Desktop multi-tab convenience: reflect the active session name and total unread count
  // in the browser tab title, so a backgrounded Weft tab is distinguishable at a glance.
  // Mobile PWA installs also get this (harmless there — no tab strip to read it from).
  useEffect(() => {
    const unreadCount = snapshot.sessions.reduce((sum, s) => sum + (s.unread ? 1 : 0), 0);
    const prefix = unreadCount > 0 ? `(${unreadCount}) ` : '';
    document.title = active ? `${prefix}${active.meta.title} · Weft` : 'Weft';
    return () => {
      document.title = 'Weft';
    };
  }, [active, snapshot.sessions]);

  if (!snapshot.ready) {
    return (
      <main className="boot">
        <div className="boot-mark" aria-hidden="true">W</div>
        <p>Restoring your sessions…</p>
      </main>
    );
  }

  // Explicit "join another session" from within the app.
  if (adding) {
    return (
      <JoinSessionScreen
        hasSessions={hasSessions}
        initialManual={addManual}
        purpose={joinPurpose}
        error={error}
        onError={setError}
        onPair={handlePair}
        onCancel={() => {
          setError(null);
          setAddManual(false);
          setAdding(false);
        }}
      />
    );
  }

  // Explicit "Home" tap from the session screen: show the landing page even though
  // sessions exist, with links back into them.
  if (showLanding && hasSessions && active) {
    return (
      <LandingScreen
        hasSessions
        onOpenSessions={() => {
          setError(null);
          setShowLanding(false);
        }}
        onBeginPair={(manual) => {
          setError(null);
          setShowLanding(false);
          openJoin(!!manual);
        }}
        onStartDemo={handleDemo}
        onStartSession={() => openStart()}
        error={error}
        onError={setError}
      />
    );
  }

  // Full "connected devices" manager: every registered listener, live status, and per-device
  // actions — distinct from StartSessionScreen (launching ONE session) and JoinSessionScreen
  // (mirroring an existing session by QR).
  if (devicesOpen) {
    return (
      <DevicesScreen
        sessions={snapshot.sessions}
        activeId={activeId}
        devices={snapshot.devices}
        onRefreshProjects={(id) => void sessionRuntime.refreshProjects(id)}
        onSetDefault={(id) => sessionRuntime.setDefaultDevice(id)}
        onForget={(id) => sessionRuntime.forgetDevice(id)}
        onStartOnDevice={(id) => openStart(id)}
        onOpenDetails={(id) => openDeviceDetails(id)}
        onScanListener={() => openJoin(false, 'device')}
        onSelectSession={(id) => {
          closeDeviceScreens();
          sessionRuntime.setActive(id);
        }}
        onAddSession={() => openJoin(false, 'session')}
        onStartSession={() => openStart()}
        onOpenDevices={openDevices}
        onRemoveSession={(id) => void sessionRuntime.remove(id)}
        onRenameSession={(id, title) => sessionRuntime.renameSession(id, title)}
        onGoHome={() => {
          closeDeviceScreens();
          setError(null);
          setShowLanding(true);
        }}
      />
    );
  }

  // Single-device drill-down: live status, event log, and every session ever spawned from this
  // device (matched by its stable deviceId, so it survives weft restarts).
  if (deviceDetailsChannelId) {
    const device = snapshot.devices.find((d) => d.channelId === deviceDetailsChannelId);
    if (device) {
      return (
        <DeviceDetailsScreen
          device={device}
          activeId={activeId}
          sessions={snapshot.sessions}
          devices={snapshot.devices}
          onRefreshProjects={(id) => void sessionRuntime.refreshProjects(id)}
          onSetDefault={(id) => sessionRuntime.setDefaultDevice(id)}
          onForget={async (id) => {
            await sessionRuntime.forgetDevice(id);
            closeDeviceScreens();
          }}
          onStartOnDevice={(id) => openStart(id)}
          onOpenSession={(id) => {
            closeDeviceScreens();
            sessionRuntime.setActive(id);
          }}
          onSelectSession={(id) => {
            closeDeviceScreens();
            sessionRuntime.setActive(id);
          }}
          onAddSession={() => openJoin(false, 'session')}
          onStartSession={() => openStart()}
          onOpenDevices={openDevices}
          onRemoveSession={(id) => void sessionRuntime.remove(id)}
          onRenameSession={(id, title) => sessionRuntime.renameSession(id, title)}
          onGoHome={() => {
            closeDeviceScreens();
            setError(null);
            setShowLanding(true);
          }}
        />
      );
    }
    // Device vanished (forgotten elsewhere) — fall through to the normal screen below.
  }

  if (starting) {
    return (
      <StartSessionScreen
        hasSessions={hasSessions}
        devices={snapshot.devices}
        initialChannelId={startDeviceId}
        onConnectDevice={(id) => void sessionRuntime.connectDevice(id)}
        onStart={async (id, opts) => {
          await sessionRuntime.spawnSession(id, opts);
          setStarting(false);
          setStartDeviceId(undefined);
          setShowLanding(false);
        }}
        onScanListener={() => openJoin(false, 'device')}
        onManageDevices={openDevices}
        onCancel={() => {
          setStarting(false);
          setStartDeviceId(undefined);
          setError(null);
        }}
        sessions={snapshot.sessions}
        activeId={activeId}
        onSelectSession={(id) => {
          setStarting(false);
          setStartDeviceId(undefined);
          sessionRuntime.setActive(id);
        }}
        onRemoveSession={(id) => void sessionRuntime.remove(id)}
        onRenameSession={(id, title) => sessionRuntime.renameSession(id, title)}
        onGoHome={() => {
          setStarting(false);
          setStartDeviceId(undefined);
          setError(null);
          setShowLanding(true);
        }}
      />
    );
  }

  // First run / no active session: web shows the onboarding landing; the native app
  // skips marketing and goes straight to the scan/pair screen.
  if (!hasSessions || !active) {
    return isNativeRuntime() ? (
      <JoinSessionScreen
        firstRun
        hasSessions={false}
        error={error}
        onError={setError}
        onPair={handlePair}
      />
    ) : (
      <LandingScreen
        onBeginPair={(manual) => {
          openJoin(!!manual);
        }}
        onStartDemo={handleDemo}
        onStartSession={() => openStart()}
        error={error}
        onError={setError}
      />
    );
  }

  return (
    <SessionScreen
      active={active}
      sessions={snapshot.sessions}
      activeId={active.meta.channelId}
      onPrompt={(text, attachments) => void sessionRuntime.sendPrompt(active.meta.channelId, text, attachments)}
      onApprove={(requestId, optionId) => void sessionRuntime.sendApproval(active.meta.channelId, requestId, optionId)}
      onElicitationRespond={(requestId, action, content) =>
        void sessionRuntime.sendElicitation(active.meta.channelId, requestId, action, content)
      }
      onInterrupt={() => void sessionRuntime.sendInterrupt(active.meta.channelId)}
      onModeChange={(mode: SessionMode) => void sessionRuntime.sendMode(active.meta.channelId, mode)}
      onRetry={(itemId) => void sessionRuntime.retryPrompt(active.meta.channelId, itemId)}
      onSelectSession={(id) => sessionRuntime.setActive(id)}
      onAddSession={() => {
        setAddManual(false);
        setJoinPurpose('session');
        setAdding(true);
      }}
      onStartSession={() => openStart()}
      onOpenDevices={openDevices}
      devices={snapshot.devices}
      onStartOnDevice={(id) => openStart(id)}
      onOpenDeviceDetails={(id) => openDeviceDetails(id)}
      onVoiceModeChange={handleVoiceModeChange}
      onRemoveSession={(id) => void sessionRuntime.remove(id)}
      onRenameSession={(id, title) => sessionRuntime.renameSession(id, title)}
      onPinSession={(id, pinned) => void sessionRuntime.pin(id, pinned)}
      onArchiveSession={(id) => sessionRuntime.archive(id)}
      onReconnect={(id) => void sessionRuntime.reconnect(id)}
      onGoHome={() => {
        setError(null);
        setShowLanding(true);
      }}
      onLoadEarlier={() => {}}
    />
  );
}

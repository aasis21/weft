import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import type { SessionMode } from '@aasis21/helm-shared';
import { LandingScreen } from '@/ui/screens/LandingScreen';
import { JoinSessionScreen } from '@/ui/screens/JoinSessionScreen';
import { StartSessionScreen } from '@/ui/screens/StartSessionScreen';
import { DevicesScreen } from '@/ui/screens/DevicesScreen';
import { DeviceDetailsScreen } from '@/ui/screens/DeviceDetailsScreen';
import { SessionScreen } from '@/ui/screens/SessionScreen';
import { isNativeRuntime } from '@/ui/hooks/usePairing';
import { sessionRuntime } from '@/session/runtime/instance';

export default function App(): JSX.Element {
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const [adding, setAdding] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startDeviceId, setStartDeviceId] = useState<string | undefined>(undefined);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const [deviceDetailsChannelId, setDeviceDetailsChannelId] = useState<string | undefined>(undefined);
  const [addManual, setAddManual] = useState(false);
  const [showLanding, setShowLanding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void sessionRuntime.init();
  }, []);

  const handlePair = useCallback(async (raw: string): Promise<void> => {
    const route = await sessionRuntime.addByQr(raw);
    setAdding(false);
    if (route.startsWith('listener:')) setStarting(true);
    setShowLanding(false);
  }, []);

  const openJoin = useCallback((manual = false): void => {
    setError(null);
    setAddManual(manual);
    setStarting(false);
    setDevicesOpen(false);
    setDeviceDetailsChannelId(undefined);
    setAdding(true);
  }, []);

  const openStart = useCallback((channelId?: string): void => {
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
  }, []);

  const openDeviceDetails = useCallback((channelId: string): void => {
    setError(null);
    setAdding(false);
    setStarting(false);
    setDevicesOpen(false);
    setDeviceDetailsChannelId(channelId);
  }, []);

  const handleVoiceModeChange = useCallback((channelId: string, active: boolean): void => {
    void sessionRuntime.setVoiceMode(active, channelId);
  }, []);

  const handleDemo = useCallback(async (): Promise<void> => {
    await sessionRuntime.addDemo();
    setAdding(false);
    setShowLanding(false);
  }, []);

  const activeId = snapshot.activeId;
  const active = snapshot.sessions.find((s) => s.meta.channelId === activeId) ?? snapshot.sessions[0] ?? null;
  const hasSessions = snapshot.sessions.length > 0;

  // Desktop multi-tab convenience: reflect the active session name and total unread count
  // in the browser tab title, so a backgrounded Helm tab is distinguishable at a glance.
  // Mobile PWA installs also get this (harmless there — no tab strip to read it from).
  useEffect(() => {
    const unreadCount = snapshot.sessions.reduce((sum, s) => sum + (s.unread ? 1 : 0), 0);
    const prefix = unreadCount > 0 ? `(${unreadCount}) ` : '';
    document.title = active ? `${prefix}${active.meta.title} · Helm` : 'Helm';
    return () => {
      document.title = 'Helm';
    };
  }, [active, snapshot.sessions]);

  if (!snapshot.ready) {
    return (
      <main className="boot">
        <div className="boot-mark" aria-hidden="true">H</div>
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
        hasSessions={hasSessions}
        devices={snapshot.devices}
        onRefreshProjects={(id) => void sessionRuntime.refreshProjects(id)}
        onSetDefault={(id) => sessionRuntime.setDefaultDevice(id)}
        onForget={(id) => sessionRuntime.forgetDevice(id)}
        onStartOnDevice={(id) => openStart(id)}
        onOpenDetails={(id) => openDeviceDetails(id)}
        onScanListener={() => openJoin(false)}
        onCancel={() => {
          setDevicesOpen(false);
          setError(null);
        }}
      />
    );
  }

  // Single-device drill-down: live status, event log, and every session ever spawned from this
  // device (matched by its stable deviceId, so it survives helm-cli restarts).
  if (deviceDetailsChannelId) {
    const device = snapshot.devices.find((d) => d.channelId === deviceDetailsChannelId);
    if (device) {
      return (
        <DeviceDetailsScreen
          device={device}
          sessions={snapshot.sessions}
          onRefreshProjects={(id) => void sessionRuntime.refreshProjects(id)}
          onSetDefault={(id) => sessionRuntime.setDefaultDevice(id)}
          onForget={async (id) => {
            await sessionRuntime.forgetDevice(id);
            setDeviceDetailsChannelId(undefined);
          }}
          onStartOnDevice={(id) => openStart(id)}
          onOpenSession={(id) => {
            sessionRuntime.setActive(id);
            setDeviceDetailsChannelId(undefined);
          }}
          onBack={() => setDeviceDetailsChannelId(undefined)}
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
        onRefreshProjects={(id) => void sessionRuntime.refreshProjects(id)}
        onStart={async (id, opts) => {
          await sessionRuntime.spawnSession(id, opts);
          setStarting(false);
          setStartDeviceId(undefined);
          setShowLanding(false);
        }}
        onForget={(id) => sessionRuntime.forgetDevice(id)}
        onSetDefault={(id) => sessionRuntime.setDefaultDevice(id)}
        onScanListener={() => openJoin(false)}
        onManageDevices={openDevices}
        onCancel={() => {
          setStarting(false);
          setStartDeviceId(undefined);
          setError(null);
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
        setAdding(true);
      }}
      onStartSession={() => openStart()}
      onOpenDevices={openDevices}
      onVoiceModeChange={handleVoiceModeChange}
      onRemoveSession={(id) => void sessionRuntime.remove(id)}
      onRenameSession={(id, title) => sessionRuntime.renameSession(id, title)}
      onReconnect={(id) => void sessionRuntime.reconnect(id)}
      onGoHome={() => {
        setError(null);
        setShowLanding(true);
      }}
      onLoadEarlier={() => {}}
    />
  );
}

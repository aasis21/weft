import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import type { SessionMode } from '@aasis21/helm-shared';
import { LandingScreen } from '@/ui/screens/LandingScreen';
import { JoinSessionScreen } from '@/ui/screens/JoinSessionScreen';
import { SessionScreen } from '@/ui/screens/SessionScreen';
import { isNativeRuntime } from '@/ui/hooks/usePairing';
import { sessionRuntime } from '@/session/runtime/instance';

export default function App(): JSX.Element {
  const snapshot = useSyncExternalStore(sessionRuntime.subscribe, sessionRuntime.getSnapshot);
  const [adding, setAdding] = useState(false);
  const [addManual, setAddManual] = useState(false);
  const [showLanding, setShowLanding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void sessionRuntime.init();
  }, []);

  const handlePair = useCallback(async (raw: string): Promise<void> => {
    await sessionRuntime.addByQr(raw);
    setAdding(false);
    setShowLanding(false);
  }, []);

  const handleDemo = useCallback(async (): Promise<void> => {
    await sessionRuntime.addDemo();
    setAdding(false);
    setShowLanding(false);
  }, []);

  const activeId = snapshot.activeId;
  const active = snapshot.sessions.find((s) => s.meta.channelId === activeId) ?? snapshot.sessions[0] ?? null;
  const hasSessions = snapshot.sessions.length > 0;

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
        onStartDemo={handleDemo}
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
          setAddManual(!!manual);
          setShowLanding(false);
          setAdding(true);
        }}
        onStartDemo={handleDemo}
        error={error}
        onError={setError}
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
        onStartDemo={handleDemo}
      />
    ) : (
      <LandingScreen
        onBeginPair={(manual) => {
          setError(null);
          setAddManual(!!manual);
          setAdding(true);
        }}
        onStartDemo={handleDemo}
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

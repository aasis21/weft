import { useCallback, useEffect, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { PromptAttachment, SessionMode } from '@aasis21/helm-shared';
import type { SessionView } from '@/session/view';
import { ChatThread } from '@/ui/thread/ChatThread';
import { Composer } from '@/ui/composer/Composer';
import { DebugPanel } from '@/ui/diagnostics/DebugPanel';
import { ElicitationCard } from '@/ui/prompts/ElicitationCard';
import { SessionDrawer } from '@/ui/sessions/SessionDrawer';
import { StatusBar } from '@/ui/sessions/StatusBar';
import { SettingsScreen } from '@/ui/settings/SettingsScreen';
import { VoiceModeOverlay } from '@/ui/voice/VoiceModeOverlay';
import { getStableDeviceId } from '@/lib/helmClient';

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const BOOKKEEPING_ARG_KEYS = new Set([
  'kind',
  'toolCallId',
  'sessionId',
  'requestId',
  'toolName',
  'name',
  'id',
  'eventType',
  'eventSubtype',
  'senderId',
  'senderName',
  'channelId',
  'ts',
  'timestamp',
]);

function isBookkeepingOnlyArgs(rec: Record<string, unknown>): boolean {
  const keys = Object.keys(rec).filter((key) => rec[key] != null);
  return keys.length > 0 && keys.every((key) => BOOKKEEPING_ARG_KEYS.has(key));
}

/**
 * Build a readable view of an approval's tool args: a concise one-liner (the command,
 * path, url, …) plus the full pretty-printed payload when there is more to reveal.
 * Returning the args is the whole point of the approval — the user must see what they
 * are about to allow, not just the tool name.
 */
function describeArgs(args: unknown): { line: string; full: string | null } | null {
  if (args == null) return null;
  if (typeof args === 'string') {
    const s = args.trim();
    if (!s) return null;
    return { line: oneLine(s), full: s.length > 100 || s.includes('\n') ? s : null };
  }
  if (typeof args !== 'object') {
    return { line: String(args), full: null };
  }
  const rec = args as Record<string, unknown>;
  const primary =
    pickString(rec.command) ??
    pickString(rec.cmd) ??
    pickString(rec.script) ??
    pickString(rec.path) ??
    pickString(rec.file_path) ??
    pickString(rec.filePath) ??
    pickString(rec.file) ??
    pickString(rec.url) ??
    pickString(rec.query) ??
    pickString(rec.pattern);
  if (!primary && isBookkeepingOnlyArgs(rec)) {
    return { line: 'No command preview available', full: null };
  }
  let full: string;
  try {
    full = JSON.stringify(args, null, 2);
  } catch {
    full = String(args);
  }
  const line = primary ?? oneLine(full);
  return { line, full: full.trim() && full.trim() !== line ? full : null };
}

function truncate(value: string, max = 96): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function approvalSummary(toolName: string, args: { line: string } | null): string {
  return truncate(args ? `${toolName}: ${args.line}` : toolName);
}

function isRecommendedOption(option: unknown): boolean {
  const rec = readRecord(option);
  return rec.recommended === true || rec.isRecommended === true || rec.recommendedAction === true;
}

function vibrate(pattern: VibratePattern): void {
  try {
    if (typeof navigator !== 'undefined') navigator.vibrate?.(pattern);
  } catch {
    // Unsupported or blocked vibration should never affect the approval flow.
  }
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function toMillis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === 'string' && value.trim()) {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) return toMillis(asNumber);
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function durationMillis(value: unknown, unit: 'ms' | 's' | 'auto' = 'auto'): number | null {
  const duration =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(duration) || duration <= 0) return null;
  if (unit === 'ms') return duration;
  if (unit === 's') return duration * 1000;
  return duration < 1000 ? duration * 1000 : duration;
}

function pickTime(record: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = toMillis(record[key]);
    if (value != null) return value;
  }
  return null;
}

function pickDuration(record: Record<string, unknown>): number | null {
  return (
    durationMillis(record.timeoutMs, 'ms') ??
    durationMillis(record.timeoutMillis, 'ms') ??
    durationMillis(record.timeoutSeconds, 's') ??
    durationMillis(record.timeoutSec, 's') ??
    durationMillis(record.timeout, 'auto') ??
    durationMillis(record.expiresInMs, 'ms') ??
    durationMillis(record.expiresInSeconds, 's') ??
    durationMillis(record.expiresIn, 'auto')
  );
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`;
}

interface SessionScreenProps {
  active: SessionView;
  sessions: SessionView[];
  activeId: string;
  onPrompt(text: string, attachments?: PromptAttachment[]): void;
  onApprove(requestId: string, optionId: string): void;
  onElicitationRespond(
    requestId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, string | number | boolean | string[]>,
  ): void;
  onInterrupt(): void;
  onModeChange(mode: SessionMode): void;
  onRetry(itemId: string): void;
  onSelectSession(channelId: string): void;
  onAddSession(): void;
  onStartSession?(): void;
  onVoiceModeChange?(channelId: string, active: boolean): void;
  onRemoveSession(channelId: string): void;
  onRenameSession(channelId: string, title: string): void;
  onReconnect(channelId: string): void;
  onGoHome(): void;
  onLoadEarlier(): void;
}

export function SessionScreen({
  active,
  sessions,
  activeId,
  onPrompt,
  onApprove,
  onElicitationRespond,
  onInterrupt,
  onModeChange,
  onRetry,
  onSelectSession,
  onAddSession,
  onStartSession,
  onVoiceModeChange,
  onRemoveSession,
  onRenameSession,
  onReconnect,
  onGoHome,
  onLoadEarlier,
}: SessionScreenProps): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [debugOpen, setDebugOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [approvalMountTimes, setApprovalMountTimes] = useState<Record<string, number>>({});
  const confirmDialogRef = useRef<HTMLDivElement | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const composerDockRef = useRef<HTMLDivElement | null>(null);
  const approvalStackRef = useRef<HTMLDivElement | null>(null);
  const prevApprovalCount = useRef(0);
  const elicitationStackRef = useRef<HTMLDivElement | null>(null);
  const prevElicitationCount = useRef(0);
  const { timeline, status, meta } = active;
  const ended = status === 'ended';
  // A turn is in flight whenever the agent reports it's busy (text/reasoning/tool) —
  // which is exactly what the phone Stop aborts. Fall back to a running tool so a
  // tool-first turn still shows Stop even if the activity signal is missed.
  const agentBusy =
    status === 'live' &&
    (timeline.busy || timeline.items.some((i) => i.kind === 'tool' && i.status === 'running'));
  // Approval/elicitation decisions can only reach the laptop while it's on the line. Off-live, disable
  // the controls so a decision isn't fired into a dead socket and silently lost (it would optimistically
  // dismiss, hang, then restore); the offline banner already explains the state (#90).
  const responsive = status === 'live';
  const cold = active.cold === true;
  // Manual "Reconnect" must not be offered for warm-idle (socket still open, just missed a heartbeat):
  // tapping it needlessly closes a live client and redoes the ECDH handshake, dropping in-flight output
  // (#126). Offer it only for cold-idle (evicted, no socket), error, or ended.
  const canReconnect = meta.kind === 'live' && (status === 'ended' || status === 'error' || (status === 'idle' && cold));
  const offline = status === 'initializing' || status === 'connecting' || status === 'idle';
  // Cold-idle (no socket) and warm-idle (socket alive) must read differently so the banner stops
  // contradicting the header's "Quiet"/"Offline" (#127).
  const offlineLabel =
    status === 'initializing'
      ? `Starting your session${active.spawning?.deviceName ? ` on ${active.spawning.deviceName}` : ''}…`
      : status === 'connecting'
      ? 'Connecting to your session…'
      : cold
        ? 'Session offline — tap Reconnect to resume.'
        : 'Session quiet — reconnecting automatically…';
  // The initial connecting-skeleton is owned by LIVENESS (+ a bounded grace), not by whether a history
  // reply has landed: a dead host never replies, so coupling the loader to the reply spins it forever.
  // Show it only while the thread is genuinely empty AND we're connecting or in the brief post-Live
  // settle window. The moment we hear the laptop we're ready (the composer is already enabled).
  const threadEmpty = timeline.items.length === 0 && timeline.history.length === 0;
  const initialLoading =
    threadEmpty && (status === 'initializing' || status === 'connecting' || (status === 'live' && active.settling === true));
  const latestAssistant =
    [...timeline.items].reverse().find((item) => item.kind === 'assistant') ?? null;
  const approveRequest = (requestId: string, optionId: string, isDeny: boolean): void => {
    vibrate(isDeny ? [8, 40, 8] : 10);
    onApprove(requestId, optionId);
  };
  const requestRemove = (id: string): void => {
    setDrawerOpen(false);
    setConfirmRemoveId(id);
  };
  const cancelRemove = (): void => setConfirmRemoveId(null);
  const confirmRemove = (): void => {
    if (!confirmRemoveId) return;
    onRemoveSession(confirmRemoveId);
    setConfirmRemoveId(null);
  };
  const handleVoiceModeActive = useCallback(
    (active: boolean): void => onVoiceModeChange?.(activeId, active),
    [activeId, onVoiceModeChange],
  );

  useEffect(() => {
    if (!confirmRemoveId) return undefined;
    confirmDialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setConfirmRemoveId(null);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [confirmRemoveId]);

  // When a new approval arrives, move focus to the (announced) approvals stack so
  // screen-reader and keyboard users are taken straight to the safety-critical
  // Allow/Deny controls instead of silently missing them (#32).
  useEffect(() => {
    const count = timeline.approvals.length;
    if (count > prevApprovalCount.current && count > 0) {
      approvalStackRef.current?.focus();
    }
    prevApprovalCount.current = count;
  }, [timeline.approvals.length]);

  // Mirror the approval focus behavior for ask_user prompts so a newly arrived elicitation pulls
  // screen-reader/keyboard focus to the form instead of it being missed below the fold (#107).
  useEffect(() => {
    const count = timeline.elicitations.length;
    if (count > prevElicitationCount.current && count > 0) {
      elicitationStackRef.current?.focus();
    }
    prevElicitationCount.current = count;
  }, [timeline.elicitations.length]);

  useEffect(() => {
    if (timeline.approvals.length === 0) {
      setApprovalMountTimes((prev) => (Object.keys(prev).length === 0 ? prev : {}));
      return;
    }
    const currentIds = new Set(timeline.approvals.map((req) => req.requestId));
    setApprovalMountTimes((prev) => {
      let changed = false;
      const next: Record<string, number> = {};
      for (const req of timeline.approvals) {
        next[req.requestId] = prev[req.requestId] ?? Date.now();
        changed = changed || next[req.requestId] !== prev[req.requestId];
      }
      changed = changed || Object.keys(prev).some((id) => !currentIds.has(id));
      return changed ? next : prev;
    });
  }, [timeline.approvals]);

  useEffect(() => {
    if (timeline.approvals.length === 0) return undefined;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [timeline.approvals.length]);

  // Keep the composer above the iOS/Android soft keyboard. The session surface is
  // position:fixed, so the layout viewport doesn't shrink when the keyboard opens and
  // the composer gets hidden behind it. Track the visual viewport and lift the surface
  // by the keyboard's height via the --helm-kb custom property (#59).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return undefined;
    // Address-bar show/hide on scroll can resize visualViewport without a keyboard.
    // Only lift the fixed shell while a text-entry control is focused, so browser
    // chrome animation never moves the composer.
    const MIN_KEYBOARD_INSET = 160;
    const isTextEntryFocused = (): boolean => {
      const active = document.activeElement;
      if (!(active instanceof HTMLElement)) return false;
      if (active.isContentEditable) return true;
      const tag = active.tagName.toLowerCase();
      if (tag === 'textarea') return true;
      if (tag !== 'input') return false;
      return !['button', 'checkbox', 'file', 'hidden', 'radio', 'range', 'reset', 'submit'].includes(
        (active as HTMLInputElement).type,
      );
    };
    const apply = (): void => {
      const el = rootRef.current;
      if (!el) return;
      const raw = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
      const keyboardThreshold = Math.max(MIN_KEYBOARD_INSET, Math.round(window.innerHeight * 0.18));
      const inset = isTextEntryFocused() && raw >= keyboardThreshold ? raw : 0;
      el.style.setProperty('--helm-kb', `${inset}px`);
    };
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    window.addEventListener('focusin', apply);
    window.addEventListener('focusout', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
      window.removeEventListener('focusin', apply);
      window.removeEventListener('focusout', apply);
    };
  }, []);

  // The "jump to latest" pill floats above the composer. Track the composer dock's
  // live height in --composer-h so the pill always clears it (even when the composer
  // grows with multi-line drafts or queued messages), instead of overlapping it.
  useEffect(() => {
    const dock = composerDockRef.current;
    const root = rootRef.current;
    if (!dock || !root) return undefined;
    const apply = (): void => {
      root.style.setProperty('--composer-h', `${dock.offsetHeight}px`);
    };
    apply();
    const observer = new ResizeObserver(apply);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="helm-session" ref={rootRef}>
      <StatusBar
        title={meta.title}
        cwd={meta.cwd}
        status={status}
        busy={agentBusy}
        canReconnect={canReconnect}
        onOpenDrawer={() => setDrawerOpen(true)}
        onAddSession={onAddSession}
        onStartSession={onStartSession}
        onReconnect={() => onReconnect(activeId)}
        onRemove={() => requestRemove(activeId)}
        onGoHome={onGoHome}
        onOpenDebug={() => setDebugOpen(true)}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      {debugOpen ? (
        <DebugPanel
          events={active.events}
          title={meta.title}
          detail={{
            channelId: meta.channelId,
            ...(meta.sessionId ? { sessionId: meta.sessionId } : {}),
            ...(meta.channelHistory ? { channelHistory: meta.channelHistory } : {}),
            senderId: getStableDeviceId(),
            addedAt: meta.addedAt,
            lastHeartbeat: active.timeline.lastHeartbeat ?? null,
            lastEventAt: active.lastEventAt ?? null,
            status: active.status,
            mode: active.timeline.mode,
          }}
          onClose={() => setDebugOpen(false)}
        />
      ) : null}

      {settingsOpen ? <SettingsScreen onClose={() => setSettingsOpen(false)} /> : null}

      {voiceOpen ? (
        <VoiceModeOverlay
          latestAssistant={latestAssistant}
          agentBusy={agentBusy}
          disabled={ended || offline}
          onPrompt={onPrompt}
          onInterrupt={onInterrupt}
          onActiveChange={handleVoiceModeActive}
          onClose={() => setVoiceOpen(false)}
        />
      ) : null}

      <main className="thread-scroll">
        <ChatThread
          items={timeline.items}
          history={timeline.history}
          streaming={status === 'live'}
          busy={agentBusy}
          offline={offline}
          offlineLabel={offlineLabel}
          onRetry={onRetry}
          onLoadEarlier={onLoadEarlier}
          historyHasMore={timeline.historyHasMore}
          historyLoading={timeline.historyLoading}
          initialLoading={initialLoading}
        />
      </main>

      <div className="composer-dock" ref={composerDockRef}>
        {ended ? (
          <div className="ended-banner">
            <span>Session ended{timeline.endedReason ? ` · ${timeline.endedReason}` : ''}.</span>
            {canReconnect ? (
              <button type="button" className="reconnect-btn" onClick={() => onReconnect(activeId)}>
                ↻ Reconnect
              </button>
            ) : null}
          </div>
        ) : null}

        {active.error && !ended ? (
          <div className="ended-banner" role="alert">
            <span>{active.error}</span>
            {canReconnect ? (
              <button type="button" className="reconnect-btn" onClick={() => onReconnect(activeId)}>
                ↻ Reconnect
              </button>
            ) : meta.kind === 'spawning' ? (
              <button type="button" className="reconnect-btn" onClick={() => onRemoveSession(activeId)}>
                Dismiss
              </button>
            ) : null}
          </div>
        ) : null}

        {timeline.approvals.length > 0 ? (
          <div
            className="approval-stack"
            ref={approvalStackRef}
            role="group"
            aria-live="assertive"
            aria-label={`${timeline.approvals.length} action${
              timeline.approvals.length === 1 ? '' : 's'
            } need your approval`}
            tabIndex={-1}
          >
            {timeline.approvals.map((req) => {
              const args = describeArgs(req.toolArgs);
              const error = timeline.approvalErrors[req.requestId];
              const summary = approvalSummary(req.toolName, args);
              const reqRecord = readRecord(req);
              const requestedAt =
                pickTime(reqRecord, ['requestedAt', 'createdAt', 'created_at', 'timestamp', 'ts']) ??
                approvalMountTimes[req.requestId] ??
                now;
              const timeoutMs = pickDuration(reqRecord);
              const deadlineAt = pickTime(reqRecord, [
                'deadline',
                'deadlineAt',
                'deadline_at',
                'expiresAt',
                'expires_at',
                'expiration',
                'timeoutAt',
                'timeout_at',
              ]);
              const hasExplicitTimeout = timeoutMs != null || deadlineAt != null;
              const totalMs = timeoutMs ?? (deadlineAt != null ? Math.max(deadlineAt - requestedAt, 1000) : null);
              const remainingMs =
                hasExplicitTimeout && totalMs != null
                  ? Math.max(0, (deadlineAt ?? requestedAt + totalMs) - now)
                  : null;
              const elapsedMs = Math.max(0, now - requestedAt);
              const countdownText =
                remainingMs != null
                  ? remainingMs > 0
                    ? `Auto-denies in ${formatDuration(remainingMs)}`
                    : 'Approval timed out'
                  : `Waiting ${formatDuration(elapsedMs)}`;
              const countdownWidth =
                remainingMs != null && totalMs != null
                  ? `${Math.max(0, Math.min(100, (remainingMs / totalMs) * 100))}%`
                  : `${20 + ((Math.floor(elapsedMs / 1000) % 20) / 20) * 60}%`;
              return (
                <div
                  key={req.requestId}
                  className="approval-banner"
                  role="group"
                  aria-label={`Approval required: ${req.toolName}${args ? ` — ${args.line}` : ''}`}
                >
                  <div className="approval-head">
                    <span className="approval-warn" aria-hidden="true">⚠</span>
                    <span className="approval-body">
                      <span className="approval-tool">{req.toolName}</span>
                      <span className="approval-hint">needs your approval</span>
                    </span>
                  </div>

                 {args ? (
                   args.full ? (
                     <details className="approval-args">
                       <summary>
                         <code className="approval-args-line">{args.line}</code>
                         <span className="approval-args-more" aria-hidden="true">details</span>
                       </summary>
                       <pre className="approval-args-full">{args.full}</pre>
                     </details>
                   ) : (
                     <code className="approval-args-line solo">{args.line}</code>
                   )
                 ) : null}

                 <div className="approval-countdown">
                   <span>{countdownText}</span>
                   <span
                     className="approval-countdown-bar"
                     aria-hidden="true"
                     style={{
                       opacity: remainingMs == null ? 0.45 : undefined,
                       width: countdownWidth,
                     }}
                   />
                 </div>

                 {error ? (
                   <p className="approval-error" role="alert">
                     ⚠ {error}
                   </p>
                 ) : null}

                 <div className="approval-actions">
                   {req.options.map((opt) => {
                     const recommended = isRecommendedOption(opt);
                     const isDeny = /deny|reject|cancel|suggest_changes|\bno\b/i.test(opt.id);
                     const isSecondary = !isDeny && /always|session|all/i.test(opt.id);
                     const variant = isDeny ? 'deny' : isSecondary ? 'allow secondary' : 'allow';
                     const decisionLabel = `${opt.label}: ${summary}${
                       recommended ? ' (recommended)' : ''
                     }`;
                     return (
                       <button
                         key={opt.id}
                         type="button"
                         className={`approval-btn ${variant}`}
                         aria-label={decisionLabel}
                         title={decisionLabel}
                         disabled={!responsive}
                         onClick={() => approveRequest(req.requestId, opt.id, isDeny)}
                       >
                         <span className="approval-btn-icon" aria-hidden="true">{isDeny ? '✕' : '✓'}</span>
                         {opt.label}
                         {recommended ? <span className="approval-recommended">Recommended</span> : null}
                       </button>
                     );
                   })}
                 </div>
               </div>
             );
           })}
          </div>
        ) : null}

        {timeline.elicitations.length > 0 ? (
          <div className="elicit-stack" ref={elicitationStackRef} tabIndex={-1}>
            {timeline.elicitations.map((req) => (
              <ElicitationCard
                key={req.requestId}
                req={req}
                {...(timeline.elicitationErrors[req.requestId]
                  ? { error: timeline.elicitationErrors[req.requestId] }
                  : {})}
                disabled={!responsive}
                onSubmit={(content) => onElicitationRespond(req.requestId, 'accept', content)}
                onDecline={() => onElicitationRespond(req.requestId, 'decline')}
                onCancel={() => onElicitationRespond(req.requestId, 'cancel')}
              />
            ))}
          </div>
        ) : null}

        <Composer
          sessionId={activeId}
          disabled={ended || offline}
          {...(ended || offline ? { disabledReason: ended ? 'ended' as const : 'offline' as const } : {})}
          busy={agentBusy}
          mode={timeline.mode}
          cwd={meta.cwd}
          onPrompt={onPrompt}
          onInterrupt={onInterrupt}
          onModeChange={onModeChange}
          onOpenVoiceMode={() => setVoiceOpen(true)}
        />
      </div>

      {drawerOpen ? (
        <SessionDrawer
          sessions={sessions}
          activeId={activeId}
          onSelect={(id) => {
            onSelectSession(id);
            setDrawerOpen(false);
          }}
          onAddSession={() => {
            setDrawerOpen(false);
            onAddSession();
          }}
          onStartSession={() => {
            setDrawerOpen(false);
            onStartSession?.();
          }}
          onRemove={requestRemove}
          onRename={onRenameSession}
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

      {confirmRemoveId ? (
        <div
          ref={confirmDialogRef}
          className="approval-banner"
          role="dialog"
          aria-modal="true"
          aria-labelledby="leave-session-title"
          tabIndex={-1}
          style={{
            position: 'fixed',
            left: '1rem',
            right: '1rem',
            bottom: 'calc(env(safe-area-inset-bottom, 0px) + 1rem)',
            zIndex: 50,
            boxShadow: '0 18px 60px rgba(0, 0, 0, 0.35)',
          }}
        >
          <div className="approval-head">
            <span className="approval-warn" aria-hidden="true">⚠</span>
            <div className="approval-body">
              <h2 id="leave-session-title" className="approval-tool" style={{ margin: 0 }}>
                Leave this session?
              </h2>
              <span className="approval-hint">This also clears its saved history on this phone.</span>
            </div>
          </div>
          <div className="approval-actions">
            <button type="button" className="reconnect-btn" onClick={cancelRemove}>
              Cancel
            </button>
            <button
              type="button"
              className="bar-menu-item danger"
              onClick={confirmRemove}
              style={{ width: 'auto' }}
            >
              Leave
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

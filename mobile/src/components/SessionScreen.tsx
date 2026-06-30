import { useState } from 'react';
import type { JSX } from 'react';
import type { SessionMode } from '@aasis21/helm-shared';
import type { SessionView } from '../lib/sessionManager';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { SessionDrawer } from './SessionDrawer';
import { StatusBar } from './StatusBar';

function pickString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
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
  let full: string;
  try {
    full = JSON.stringify(args, null, 2);
  } catch {
    full = String(args);
  }
  const line = primary ?? oneLine(full);
  return { line, full: full.trim() && full.trim() !== line ? full : null };
}

interface SessionScreenProps {
  active: SessionView;
  sessions: SessionView[];
  activeId: string;
  onPrompt(text: string): void;
  onApprove(requestId: string, optionId: string): void;
  onInterrupt(): void;
  onModeChange(mode: SessionMode): void;
  onSelectSession(channelId: string): void;
  onAddSession(): void;
  onRemoveSession(channelId: string): void;
  onReconnect(channelId: string): void;
  onGoHome(): void;
}

export function SessionScreen({
  active,
  sessions,
  activeId,
  onPrompt,
  onApprove,
  onInterrupt,
  onModeChange,
  onSelectSession,
  onAddSession,
  onRemoveSession,
  onReconnect,
  onGoHome,
}: SessionScreenProps): JSX.Element {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const { timeline, status, meta } = active;
  const ended = status === 'ended';
  // A turn is in flight whenever the agent reports it's busy (text/reasoning/tool) —
  // which is exactly what the phone Stop aborts. Fall back to a running tool so a
  // tool-first turn still shows Stop even if the activity signal is missed.
  const agentBusy =
    status === 'live' &&
    (timeline.busy || timeline.items.some((i) => i.kind === 'tool' && i.status === 'running'));
  const canReconnect = meta.kind !== 'demo' && (status === 'ended' || status === 'error' || status === 'idle');

  return (
    <div className="helm-session">
      <StatusBar
        title={meta.title}
        cwd={meta.cwd}
        status={status}
        sessionCount={sessions.length}
        canReconnect={canReconnect}
        onOpenDrawer={() => setDrawerOpen(true)}
        onAddSession={onAddSession}
        onReconnect={() => onReconnect(activeId)}
        onRemove={() => onRemoveSession(activeId)}
        onGoHome={onGoHome}
      />

      <main className="thread-scroll">
        <ChatThread items={timeline.items} history={timeline.history} streaming={status === 'live'} />
      </main>

      <div className="composer-dock">
        {ended ? (
          <div className="ended-banner">
            <span>Session ended{timeline.endedReason ? ` · ${timeline.endedReason}` : ''}.</span>
            {meta.kind !== 'demo' ? (
              <button type="button" className="reconnect-btn" onClick={() => onReconnect(activeId)}>
                ↻ Reconnect
              </button>
            ) : null}
          </div>
        ) : null}

        {timeline.approvals.map((req) => {
          const args = describeArgs(req.toolArgs);
          const error = timeline.approvalErrors[req.requestId];
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

              {error ? (
                <p className="approval-error" role="alert">
                  ⚠ {error}
                </p>
              ) : null}

              <div className="approval-actions">
                {req.options.map((opt) => {
                  const isDeny = /deny|reject|cancel|\bno\b/i.test(opt.id);
                  const isSecondary = !isDeny && /always|session|all/i.test(opt.id);
                  const variant = isDeny ? 'deny' : isSecondary ? 'allow secondary' : 'allow';
                  return (
                    <button
                      key={opt.id}
                      type="button"
                      className={`approval-btn ${variant}`}
                      onClick={() => onApprove(req.requestId, opt.id)}
                    >
                      <span className="approval-btn-icon" aria-hidden="true">{isDeny ? '✕' : '✓'}</span>
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}

        <Composer
          disabled={ended}
          busy={agentBusy}
          mode={timeline.mode}
          cwd={meta.cwd}
          onPrompt={onPrompt}
          onInterrupt={onInterrupt}
          onModeChange={onModeChange}
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
          onRemove={onRemoveSession}
          onClose={() => setDrawerOpen(false)}
        />
      ) : null}
    </div>
  );
}

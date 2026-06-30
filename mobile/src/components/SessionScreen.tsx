import { useState } from 'react';
import type { JSX } from 'react';
import type { SessionMode } from '@aasis21/helm-shared';
import type { SessionView } from '../lib/sessionManager';
import { ChatThread } from './ChatThread';
import { Composer } from './Composer';
import { SessionDrawer } from './SessionDrawer';
import { StatusBar } from './StatusBar';

interface SessionScreenProps {
  active: SessionView;
  sessions: SessionView[];
  activeId: string;
  onPrompt(text: string): void;
  onApprove(requestId: string, optionId: string): void;
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

        {timeline.approvals.map((req) => (
          <div key={req.requestId} className="approval-banner">
            <span className="approval-warn" aria-hidden="true">⚠</span>
            <span className="approval-body">
              <span className="approval-tool">{req.toolName}</span>
              <span className="approval-hint">needs your approval</span>
            </span>
            <span className="approval-actions">
              {req.options.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`approval-btn${opt.id.includes('deny') ? ' deny' : ' allow'}`}
                  onClick={() => onApprove(req.requestId, opt.id)}
                >
                  {opt.label}
                </button>
              ))}
            </span>
          </div>
        ))}

        <Composer
          disabled={ended}
          mode={timeline.mode}
          cwd={meta.cwd}
          onPrompt={onPrompt}
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

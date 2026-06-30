import { useEffect, useRef } from 'react';
import type { AppState } from '../App';
import type { SessionMode } from '@aasis21/helm-shared';
import { ApprovalCard } from './ApprovalCard';
import { ModeSelector } from './ModeSelector';
import { PromptComposer } from './PromptComposer';

interface LiveStreamViewProps {
  channelId: string;
  state: AppState;
  onApprove(requestId: string, optionId: string): Promise<void>;
  onModeChange(mode: SessionMode): Promise<void>;
  onPrompt(text: string): Promise<void>;
  onRePair(): Promise<void>;
}

export function LiveStreamView({
  channelId,
  state,
  onApprove,
  onModeChange,
  onPrompt,
  onRePair,
}: LiveStreamViewProps): JSX.Element {
  const endRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [state.transcript.length, state.tools.length, state.approvals.length]);

  const heartbeatAge = state.lastHeartbeat ? Math.max(0, Math.round((Date.now() - state.lastHeartbeat) / 1000)) : null;

  return (
    <main className="live-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Channel {channelId.slice(0, 8)}</p>
          <h1>Live Copilot stream</h1>
          {state.cwd ? <p className="cwd">{state.cwd}</p> : null}
        </div>
        <div className={`status-pill ${state.connected && !state.sessionEnded ? 'online' : 'offline'}`}>
          <span />
          {state.sessionEnded ? 'Session ended' : state.connected ? `Live${heartbeatAge === null ? '' : ` · ${heartbeatAge}s`}` : 'Connecting'}
        </div>
      </header>

      {state.sessionEnded ? (
        <section className="session-ended">
          <h2>Session Ended</h2>
          <p>The terminal stopped sending control heartbeats or emitted a session end event.</p>
          <button className="primary-action compact" type="button" onClick={() => void onRePair()}>
            Re-pair
          </button>
        </section>
      ) : null}

      <section className="stream-grid">
        <div className="transcript-panel">
          <div className="panel-heading">
            <span>Transcript</span>
            <ModeSelector mode={state.mode} onChange={onModeChange} />
          </div>
          <div className="transcript-list" aria-live="polite">
            {state.transcript.length === 0 ? (
              <p className="empty-state">Waiting for encrypted stream messages…</p>
            ) : (
              state.transcript.map((item) => (
                <article key={item.id} className={`bubble ${item.role} ${item.level ?? ''}`}>
                  <span className="stamp">{formatTime(item.ts)}</span>
                  <p>{item.content}</p>
                </article>
              ))
            )}
            <div ref={endRef} />
          </div>
        </div>

        <aside className="side-rail">
          {state.approvals.map((request) => (
            <ApprovalCard key={request.requestId} request={request} onApprove={onApprove} />
          ))}
          <section className="tool-panel">
            <h2>Tool timeline</h2>
            {state.tools.length === 0 ? (
              <p className="empty-state">Tool activity will land here.</p>
            ) : (
              state.tools.map((tool) => (
                <article key={tool.id} className={`tool-row ${tool.status}`}>
                  <div>
                    <strong>{tool.name}</strong>
                    <span>{tool.status === 'running' ? 'Running' : tool.success ? 'Complete' : 'Failed'}</span>
                  </div>
                  {tool.args ? <pre>{JSON.stringify(tool.args, null, 2)}</pre> : null}
                  {tool.resultPreview ? <p>{tool.resultPreview}</p> : null}
                </article>
              ))
            )}
          </section>
        </aside>
      </section>

      <PromptComposer disabled={state.sessionEnded} onPrompt={onPrompt} />
    </main>
  );
}

function formatTime(ts: number): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(ts);
}

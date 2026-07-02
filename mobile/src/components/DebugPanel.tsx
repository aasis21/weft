import { useMemo, useState } from 'react';
import type { JSX } from 'react';
import type { DebugEvent } from '../lib/eventLog';

interface DebugPanelProps {
  events: DebugEvent[];
  title: string;
  onClose(): void;
}

function fmtTime(ts: number): string {
  try {
    const t = new Date(ts).toLocaleTimeString(undefined, { hour12: false });
    return `${t}.${String(ts % 1000).padStart(3, '0')}`;
  } catch {
    return String(ts);
  }
}

/**
 * Per-session debug overlay: the raw wire event chain, newest-first. Each row shows direction
 * (↓ received from the laptop / ↑ sent from this phone), the eventType.eventSubtype, the sender
 * label, and a timestamp; tap a row to expand its (compacted) payload. The list is persisted per
 * session, so it survives reloads and reconnects.
 */
export function DebugPanel({ events, title, onClose }: DebugPanelProps): JSX.Element {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const ordered = useMemo(() => [...events].reverse(), [events]);
  const toggle = (id: string): void => setExpanded((m) => ({ ...m, [id]: !m[id] }));

  return (
    <div className="debug-overlay" role="dialog" aria-modal="true" aria-label="Debug events">
      <div className="debug-panel">
        <header className="debug-head">
          <div className="debug-head-text">
            <span className="debug-title">Event log</span>
            <span className="debug-sub">
              {title} · {events.length} event{events.length === 1 ? '' : 's'}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn debug-close"
            onClick={onClose}
            aria-label="Close debug events"
            title="Close"
          >
            ✕
          </button>
        </header>

        {ordered.length === 0 ? (
          <p className="debug-empty">No events captured yet.</p>
        ) : (
          <ol className="debug-list">
            {ordered.map((e) => {
              const kind = `${e.eventType}.${e.eventSubtype}`;
              const open = expanded[e.id] === true;
              return (
                <li key={e.id} className={`debug-row ${e.dir}`}>
                  <button
                    type="button"
                    className="debug-row-head"
                    onClick={() => toggle(e.id)}
                    aria-expanded={open}
                  >
                    <span className={`debug-dir ${e.dir}`} aria-hidden="true">
                      {e.dir === 'in' ? '↓' : '↑'}
                    </span>
                    <span className="debug-kind">{kind}</span>
                    <span className="debug-sender">{e.senderName}</span>
                    <span className="debug-time">{fmtTime(e.ts)}</span>
                  </button>
                  {open ? <pre className="debug-msg">{JSON.stringify(e.msg, null, 2)}</pre> : null}
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </div>
  );
}

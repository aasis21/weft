import { useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type { DebugEvent } from '@/lib/eventLog';

export interface DebugDetail {
  sessionId?: string;
  channelId: string;
  channelHistory?: { channelId: string; startedAt: number; endedAt?: number }[];
  senderId: string;
  addedAt: number;
  lastHeartbeat: number | null;
  lastEventAt: number | null;
  status: string;
  mode?: string;
  /** #163 lifecycle: user-pinned (exempt from auto-delete/eviction). */
  pinned?: boolean;
  /** #163 lifecycle: evicted from the warm pool (no live socket) — "Archived". */
  cold?: boolean;
  /** Transport kind this session is currently paired over (local/supabase/devtunnel) —
   *  see SessionMeta.transport / TransportDescriptor in shared/transport.d.ts. Undefined for
   *  sessions restored before this field existed, until their next re-pair. */
  transport?: string;
}

interface DebugPanelProps {
  events: DebugEvent[];
  title: string;
  detail?: DebugDetail;
  onClose(): void;
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function isFocusable(element: HTMLElement): boolean {
  return element.tabIndex >= 0 && !element.hasAttribute('disabled') && element.getClientRects().length > 0;
}

function fmtTime(ts: number): string {
  try {
    const t = new Date(ts).toLocaleTimeString(undefined, { hour12: false });
    return `${t}.${String(ts % 1000).padStart(3, '0')}`;
  } catch {
    return String(ts);
  }
}

function fmtStamp(ts: number | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, { hour12: false });
  } catch {
    return String(ts);
  }
}

// #163 lifecycle windows (mirrors sessionRuntime constants) — for the Dev-detail countdowns only.
const AUTO_ARCHIVE_MS = 2 * 60 * 60 * 1_000;
const AUTO_DELETE_MS = 2 * 24 * 60 * 60 * 1_000;

/** Coarse "2h 14m" / "1d 3h" style duration for the lifecycle countdown. */
function fmtCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalMin = Math.floor(ms / 60_000);
  const d = Math.floor(totalMin / (60 * 24));
  const h = Math.floor((totalMin % (60 * 24)) / 60);
  const m = totalMin % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

/** Present the lifecycle state + next-transition countdown from a {@link DebugDetail}. Best-effort:
 *  the archive clock uses the in-memory heartbeat; the delete clock is a wall-clock approximation of
 *  the witnessed-silence rule (the exact witnessed math lives in the runtime). */
function lifecycleSummary(detail: DebugDetail): string {
  const now = Date.now();
  const parts: string[] = [];
  if (detail.status === 'ended') parts.push('Ended');
  else if (detail.cold) parts.push('Archived');
  else if (detail.status === 'error') parts.push('Offline');
  else if (detail.status === 'live' || detail.status === 'idle') parts.push('Active');
  else parts.push(detail.status);
  if (detail.pinned) parts.push('📌 Pinned');

  const beat = detail.lastHeartbeat;
  if (beat) {
    if (!detail.cold && detail.status !== 'ended') {
      parts.push(`archives in ${fmtCountdown(AUTO_ARCHIVE_MS - (now - beat))}`);
    }
    if (!detail.pinned && detail.status !== 'ended') {
      parts.push(`deletes in ~${fmtCountdown(AUTO_DELETE_MS - (now - beat))}`);
    } else if (detail.pinned) {
      parts.push('never auto-deletes');
    }
  }
  return parts.join(' · ');
}

export function DebugPanel({ events, title, detail, onClose }: DebugPanelProps): JSX.Element {
  const [tab, setTab] = useState<'log' | 'detail'>('log');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const ordered = useMemo(() => [...events].reverse(), [events]);
  const toggle = (id: string): void => setExpanded((m) => ({ ...m, [id]: !m[id] }));

  const overlayRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const active = document.activeElement;
    triggerRef.current = active instanceof HTMLElement ? active : null;

    const getFocusable = (): HTMLElement[] => {
      if (!overlayRef.current) return [];
      return Array.from(overlayRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isFocusable);
    };

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab' || !overlayRef.current) return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        overlayRef.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;
      if (!overlayRef.current.contains(current)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    closeButtonRef.current?.focus();

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      const trigger = triggerRef.current;
      if (trigger && document.contains(trigger) && isFocusable(trigger)) trigger.focus();
    };
  }, []);

  return (
    <div
      className="debug-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="Debug events"
      ref={overlayRef}
      tabIndex={-1}
    >
      <div className="debug-panel">
        <header className="debug-head">
          <div className="debug-head-text">
            <span className="debug-title">Debug</span>
            <span className="debug-sub">
              {title} · {events.length} event{events.length === 1 ? '' : 's'}
            </span>
          </div>
          <button
            type="button"
            className="icon-btn debug-close"
            ref={closeButtonRef}
            onClick={onClose}
            aria-label="Close debug events"
            title="Close"
          >
            ✕
          </button>
        </header>

        {detail ? (
          <div className="debug-tabs" role="tablist" aria-label="Debug views">
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'log'}
              className={`debug-tab ${tab === 'log' ? 'active' : ''}`}
              onClick={() => setTab('log')}
            >
              Event log
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === 'detail'}
              className={`debug-tab ${tab === 'detail' ? 'active' : ''}`}
              onClick={() => setTab('detail')}
            >
              Dev detail
            </button>
          </div>
        ) : null}

        {detail && tab === 'detail' ? (
          <dl className="debug-detail" aria-label="Session detail">
            <dt>Session id</dt>
            <dd className="mono">{detail.sessionId ?? '— (not yet reported)'}</dd>
            <dt>Latest channel id</dt>
            <dd className="mono">{detail.channelId}</dd>
            <dt>Transport</dt>
            <dd className="mono">{detail.transport ?? '— (rescan to learn)'}</dd>
            <dt>Previous channels</dt>
            <dd className="mono">
              {detail.channelHistory && detail.channelHistory.length > 0
                ? detail.channelHistory.map((c) => c.channelId).join(', ')
                : '— (none)'}
            </dd>
            <dt>Sender (device) id</dt>
            <dd className="mono">{detail.senderId}</dd>
            <dt>Status / mode</dt>
            <dd>
              {detail.status}
              {detail.mode ? ` · ${detail.mode}` : ''}
            </dd>
            <dt>Lifecycle</dt>
            <dd>{lifecycleSummary(detail)}</dd>
            <dt>Started</dt>
            <dd>{fmtStamp(detail.addedAt)}</dd>
            <dt>Latest heartbeat</dt>
            <dd>{fmtStamp(detail.lastHeartbeat)}</dd>
            <dt>Latest event</dt>
            <dd>{fmtStamp(detail.lastEventAt)}</dd>
          </dl>
        ) : ordered.length === 0 ? (
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

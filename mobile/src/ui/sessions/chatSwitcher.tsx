import { useEffect, useRef, useState } from 'react';
import type { JSX, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';
import type { SessionView } from '@/session/view';
import type { ListenerDeviceState } from '@/session/model';
import { deriveStatus, isWorking } from './sessionStatus';
import { deviceLabel } from '@/ui/screens/deviceDisplay';
import { useBackHandler } from '@/ui/gestures/backNavigation';
import { hapticTick } from '@/ui/gestures/touchGestures';

export function fmtRelative(ts: number | null): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

export function lastActivity(session: SessionView): number | null {
  // Phone-domain only. `lastEventAt` is stamped on the phone as events arrive; timeline `item.ts`
  // is the LAPTOP's clock, and feeding it to a `Date.now() - ts` age would misreport "N ago" (even
  // negative "in the future") under cross-clock skew. Fall back to scan/add time (also phone-domain).
  return session.lastEventAt ?? session.meta.scannedAt ?? session.meta.addedAt ?? null;
}

export interface DrawerGroups {
  activeGroup: SessionView[];
  offlineGroup: SessionView[];
  archivedGroup: SessionView[];
}

/** The drawer's grouping, shared so the header swipe walks chats in the order the user sees. */
export function groupDrawerSessions(sessions: SessionView[]): DrawerGroups {
  // Order: pinned first (their whole point is to stay reachable), then stably by when each
  // session's QR was last scanned. Deliberately NOT by last activity, so incoming
  // events/heartbeats never reshuffle the list under the user. A re-scan bumps scannedAt so
  // that card jumps to the top. Fall back to addedAt for legacy/demo cards without a scan time.
  const scannedAt = (s: SessionView): number => s.meta.scannedAt ?? s.meta.addedAt ?? 0;
  const sorted = [...sessions].sort((a, b) => {
    const pinDelta = Number(b.pinned ?? false) - Number(a.pinned ?? false);
    if (pinDelta !== 0) return pinDelta;
    return scannedAt(b) - scannedAt(a);
  });
  // #163: three buckets so "something broke" (Offline) is never mixed with the calm "Archived".
  const groups: DrawerGroups = { activeGroup: [], offlineGroup: [], archivedGroup: [] };
  for (const s of sorted) {
    const derived = deriveStatus(s, { busy: isWorking(s.timeline) });
    if (derived.active) groups.activeGroup.push(s);
    else if (derived.tone === 'error') groups.offlineGroup.push(s);
    else groups.archivedGroup.push(s);
  }
  return groups;
}

export function drawerSessionOrder(sessions: SessionView[]): SessionView[] {
  const { activeGroup, offlineGroup, archivedGroup } = groupDrawerSessions(sessions);
  return [...activeGroup, ...offlineGroup, ...archivedGroup];
}

const RECENT_KEY = 'weft.recentChats';
const RECENT_LIMIT = 12;
let memoryRecent: string[] = [];

function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
    if (Array.isArray(parsed)) return parsed.filter((id): id is string => typeof id === 'string');
  } catch {
    // Storage can be unavailable (private mode); fall back to this tab's memory.
  }
  return memoryRecent;
}

/** Most-recently-visited chat ids, newest first. */
export function recentChatIds(): string[] {
  return readRecent();
}

export function noteChatVisit(channelId: string): void {
  const next = [channelId, ...readRecent().filter((id) => id !== channelId)].slice(0, RECENT_LIMIT);
  memoryRecent = next;
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    // Keep the in-memory copy.
  }
}

/** Up to `max` chats other than the current one: recently visited first, then drawer order. */
export function switcherSessions(sessions: SessionView[], activeId: string | null, max = 4): SessionView[] {
  const byId = new Map(sessions.map((s) => [s.meta.channelId, s]));
  const picked: SessionView[] = [];
  const seen = new Set<string>(activeId ? [activeId] : []);
  const add = (s: SessionView | undefined): void => {
    if (!s || seen.has(s.meta.channelId) || picked.length >= max) return;
    seen.add(s.meta.channelId);
    picked.push(s);
  };
  for (const id of recentChatIds()) add(byId.get(id));
  for (const s of drawerSessionOrder(sessions)) add(s);
  return picked;
}

const LONG_PRESS_MS = 450;
const DOUBLE_TAP_MS = 300;
const MOVE_SLOP = 8;
const SWIPE_COMMIT = 80;
const FLICK_SPEED = 0.5;
/** The left-edge drawer swipe owns touches that start this close to the screen edge. */
const EDGE_ZONE = 40;

type GestureMode = 'idle' | 'pending' | 'swipe' | 'hold' | 'ignored';

export interface TitleGestureOptions {
  enabled: boolean;
  sessions: SessionView[];
  activeId: string | null;
  onSwitch?(channelId: string): void;
}

export interface TitleGestures {
  handlers: {
    onPointerDown(e: ReactPointerEvent<HTMLElement>): void;
    onPointerMove(e: ReactPointerEvent<HTMLElement>): void;
    onPointerUp(e: ReactPointerEvent<HTMLElement>): void;
    onPointerCancel(): void;
    onContextMenu(e: ReactMouseEvent<HTMLElement>): void;
  };
  dragX: number;
  peek: SessionView | null;
  enter: 'next' | 'prev' | null;
  clearEnter(): void;
  switcherOpen: boolean;
  closeSwitcher(): void;
  highlightId: string | null;
  choices: SessionView[];
  pick(channelId: string): void;
}

/** Swipe the chat title for next/previous, long-press for the recent-chats card, double-tap to go back. */
export function useTitleGestures({ enabled, sessions, activeId, onSwitch }: TitleGestureOptions): TitleGestures {
  const [dragX, setDragX] = useState(0);
  const [enter, setEnter] = useState<'next' | 'prev' | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [choices, setChoices] = useState<SessionView[]>([]);
  const mode = useRef<GestureMode>('idle');
  const start = useRef({ x: 0, y: 0, t: 0 });
  const neighbours = useRef<{ prev: SessionView | null; next: SessionView | null }>({ prev: null, next: null });
  const timer = useRef<number | null>(null);
  const lastTap = useRef(0);
  const highlightRef = useRef<string | null>(null);
  const active = enabled && Boolean(onSwitch);

  const clearTimer = (): void => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clearTimer, []);

  const openSwitcher = (): void => {
    setChoices(switcherSessions(sessions, activeId));
    highlightRef.current = null;
    setHighlightId(null);
    setSwitcherOpen(true);
  };
  const closeSwitcher = (): void => {
    setSwitcherOpen(false);
    highlightRef.current = null;
    setHighlightId(null);
  };
  const pick = (channelId: string): void => {
    closeSwitcher();
    if (channelId !== activeId) onSwitch?.(channelId);
  };

  const reset = (): void => {
    clearTimer();
    mode.current = 'idle';
    setDragX(0);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>): void => {
    if (!active || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (e.pointerType !== 'mouse' && e.clientX < EDGE_ZONE) {
      mode.current = 'ignored';
      return;
    }
    start.current = { x: e.clientX, y: e.clientY, t: performance.now() };
    const order = drawerSessionOrder(sessions);
    const index = order.findIndex((s) => s.meta.channelId === activeId);
    neighbours.current = {
      prev: index > 0 ? order[index - 1] ?? null : null,
      next: index >= 0 ? order[index + 1] ?? null : null,
    };
    mode.current = 'pending';
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Synthetic pointers (tests) cannot be captured.
    }
    clearTimer();
    timer.current = window.setTimeout(() => {
      timer.current = null;
      if (mode.current !== 'pending') return;
      mode.current = 'hold';
      hapticTick();
      openSwitcher();
    }, LONG_PRESS_MS);
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLElement>): void => {
    const dx = e.clientX - start.current.x;
    const dy = e.clientY - start.current.y;
    if (mode.current === 'pending') {
      if (Math.abs(dx) < MOVE_SLOP && Math.abs(dy) < MOVE_SLOP) return;
      clearTimer();
      mode.current = Math.abs(dx) > Math.abs(dy) ? 'swipe' : 'ignored';
    }
    if (mode.current === 'swipe') {
      const target = dx < 0 ? neighbours.current.next : neighbours.current.prev;
      setDragX(target ? dx : dx * 0.25);
      return;
    }
    if (mode.current === 'hold') {
      const hit = document.elementFromPoint?.(e.clientX, e.clientY);
      const id = hit instanceof Element ? hit.closest<HTMLElement>('[data-switch-id]')?.dataset.switchId ?? null : null;
      if (id !== highlightRef.current) {
        highlightRef.current = id;
        setHighlightId(id);
        if (id) hapticTick();
      }
    }
  };

  const onPointerUp = (e: ReactPointerEvent<HTMLElement>): void => {
    const current = mode.current;
    clearTimer();
    mode.current = 'idle';
    if (current === 'pending') {
      const now = performance.now();
      if (now - lastTap.current < DOUBLE_TAP_MS) {
        lastTap.current = 0;
        const previous = switcherSessions(sessions, activeId, 1)[0];
        if (previous) {
          hapticTick();
          onSwitch?.(previous.meta.channelId);
        }
      } else {
        lastTap.current = now;
      }
      return;
    }
    if (current === 'swipe') {
      const dx = e.clientX - start.current.x;
      const speed = Math.abs(dx) / Math.max(1, performance.now() - start.current.t);
      const target = dx < 0 ? neighbours.current.next : neighbours.current.prev;
      setDragX(0);
      if (target && (Math.abs(dx) >= SWIPE_COMMIT || (Math.abs(dx) > 30 && speed > FLICK_SPEED))) {
        hapticTick();
        setEnter(dx < 0 ? 'next' : 'prev');
        onSwitch?.(target.meta.channelId);
      }
      return;
    }
    if (current === 'hold' && highlightRef.current) pick(highlightRef.current);
  };

  const onContextMenu = (e: ReactMouseEvent<HTMLElement>): void => {
    if (!active) return;
    e.preventDefault();
    if (!switcherOpen) openSwitcher();
  };

  const peek = dragX < 0 ? neighbours.current.next : dragX > 0 ? neighbours.current.prev : null;
  return {
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: reset, onContextMenu },
    dragX,
    peek,
    enter,
    clearEnter: () => setEnter(null),
    switcherOpen,
    closeSwitcher,
    highlightId,
    choices,
    pick,
  };
}

interface ChatSwitcherProps {
  choices: SessionView[];
  devices: ListenerDeviceState[];
  highlightId: string | null;
  anchor: HTMLElement | null;
  onPick(channelId: string): void;
  onAllChats(): void;
  onClose(): void;
}

function folderName(cwd: string | null | undefined): string | null {
  return cwd ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? null : null;
}

/** The long-press card: up to four recent chats over a blurred backdrop. */
export function ChatSwitcher({ choices, devices, highlightId, anchor, onPick, onAllChats, onClose }: ChatSwitcherProps): JSX.Element {
  const cardRef = useRef<HTMLDivElement | null>(null);
  const swipeStart = useRef<number | null>(null);
  const top = anchor ? Math.round(anchor.getBoundingClientRect().bottom) : 0;
  useBackHandler(true, onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(cardRef.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
      if (!items.length) return;
      e.preventDefault();
      const index = items.findIndex((el) => el === document.activeElement);
      const step = e.key === 'ArrowDown' ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    // Focus the card itself so arrow keys work without a row looking pre-selected on touch.
    cardRef.current?.focus({ preventScroll: true });
  }, []);

  // Rendered in place, not portaled: the theme variables are scoped to `.weft-session`.
  return (
    <div className="chat-switcher-layer" style={{ top: `${top}px` }}>
      <div className="chat-switcher-scrim" onClick={onClose} aria-hidden="true" />
      <div
        ref={cardRef}
        className="chat-switcher"
        role="dialog"
        aria-label="Switch chat"
        tabIndex={-1}
        onTouchStart={(e) => { swipeStart.current = e.touches[0]?.clientY ?? null; }}
        onTouchEnd={(e) => {
          const startY = swipeStart.current;
          swipeStart.current = null;
          const endY = e.changedTouches[0]?.clientY;
          if (startY !== null && endY !== undefined && startY - endY > 50) onClose();
        }}
      >
        <div className="chat-switcher-head">Switch to</div>
        {choices.length === 0 ? (
          <p className="chat-switcher-empty">No other chats yet.</p>
        ) : (
          <ul className="chat-switcher-list">
            {choices.map((session) => {
              const id = session.meta.channelId;
              const derived = deriveStatus(session, { busy: isWorking(session.timeline) });
              const attention = session.needsAttention ??
                (session.timeline.approvals.length + session.timeline.elicitations.length);
              const device = session.meta.spawnedFromDeviceId
                ? devices.find((d) => d.deviceId === session.meta.spawnedFromDeviceId)
                : undefined;
              const where = [folderName(session.meta.cwd), device ? deviceLabel(device) : session.meta.spawnedFromDeviceName]
                .filter(Boolean)
                .join(' · ');
              return (
                <li key={id}>
                  <button
                    type="button"
                    className={`chat-switcher-row${highlightId === id ? ' highlighted' : ''}`}
                    data-switch-id={id}
                    onClick={() => onPick(id)}
                  >
                    <span className={`status-dot ${derived.tone}`} aria-hidden="true" />
                    <span className="chat-switcher-text">
                      <span className="chat-switcher-title">
                        {session.pinned ? <span className="pin-mark" aria-hidden="true">📌</span> : null}
                        {session.meta.title}
                      </span>
                      {where ? <span className="chat-switcher-where">{where}</span> : null}
                    </span>
                    <span className="chat-switcher-meta">
                      {attention > 0 ? <span className="chat-switcher-flag" aria-label="Waiting for you">⚑</span> : null}
                      <span className="chat-switcher-time">{fmtRelative(lastActivity(session))}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <button type="button" className="chat-switcher-all" onClick={() => { onClose(); onAllChats(); }}>
          All chats <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}

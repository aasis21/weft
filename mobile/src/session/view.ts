import type { TimelineState } from '@/lib/timeline';
import type { DebugEvent, ListenerDeviceState, SessionMeta, SessionStatus } from './model';

export type { SessionMeta, SessionStatus };

/**
 * The immutable, React-facing projection of ONE session. This is the SHELL's contract: components
 * only ever read this shape (never the internal `Session` aggregate). Built by `toSessionView` and
 * kept structurally identical to the pre-refactor manager view so the UI is untouched by the port.
 */
export interface SessionView {
  meta: SessionMeta;
  status: SessionStatus;
  /** The flat timeline the thread renders (items + history + mode + cwd/title). */
  timeline: TimelineState;
  unread?: boolean;
  /** Count of unread host turns/events accrued while this session was not active (0 = none). */
  unreadCount?: number;
  /** Last real host activity (ms). Drives the sidebar's newest-first ordering; survives reload. */
  lastEventAt?: number;
  /** True during the brief, bounded post-Live grace while the first history page is still arriving —
   *  the UI shows the connecting skeleton instead of flashing the empty-welcome. */
  settling?: boolean;
  /** True when the session was evicted from the warm pool (no live socket) — the header shows
   *  "Offline" and reconnect is offered, instead of the warm-idle "Quiet". */
  cold?: boolean;
  /** User-pinned (#163): shown with a marker and exempt from auto-delete/eviction. */
  pinned?: boolean;
  /** Last observed heartbeat pulse (ms) — liveness clock; drives the drawer's live/offline dot and
   *  the archived "expires in Nd" hint. */
  lastHeartbeatAt?: number;
  /** Raw wire events exchanged with the laptop (both directions), oldest-first — the debug panel
   *  renders them newest-first. Persisted per session and restored on reload. */
  events: DebugEvent[];
  error?: string;
  spawning?: {
    requestId: string;
    deviceId: string;
    deviceName?: string;
    projectName: string;
  };
}

/** The whole app state the SHELL subscribes to: readiness, the active session, and every card. */
export interface ManagerSnapshot {
  ready: boolean;
  activeId: string | null;
  sessions: SessionView[];
  devices: ListenerDeviceState[];
}

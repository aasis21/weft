import type { SessionView } from '@/session/view';

/** The visual tone of a status pill — maps 1:1 to a `.status-line.<tone>` CSS class. */
export type StatusTone =
  | 'live'
  | 'idle'
  | 'busy'
  | 'connecting'
  | 'initializing'
  | 'archived'
  | 'error'
  | 'ended';

export interface DerivedStatus {
  /** Human label shown in the pill (e.g. "Live", "Quiet", "Archived"). */
  label: string;
  /** CSS tone/class for the pill + dot. */
  tone: StatusTone;
  /** True when the session currently holds (or is establishing) a live subscription — i.e. it belongs
   *  in the drawer's **Active** group. Archived / Offline / Ended sessions are `false`. */
  active: boolean;
}

/**
 * The single source of truth for how a session's connection state is presented (#163). Both the
 * detail-header `StatusBar` and the sidebar drawer derive their pill from this, so "Live" in the
 * header can never disagree with the row in the list.
 *
 * The key distinction the design draws:
 * - **Archived** (`cold`, no socket) — calm, expected, "tap to reconnect". NOT an error.
 * - **Offline** (`error`) — something went wrong reaching the laptop, "reconnect".
 *
 * `busy` isn't on {@link SessionView}; the header passes it so a working turn reads "Working…".
 */
export function deriveStatus(view: Pick<SessionView, 'status' | 'cold' | 'error'>, opts: { busy?: boolean } = {}): DerivedStatus {
  const { status, cold, error } = view;

  if (status === 'ended') return { label: 'Ended', tone: 'ended', active: false };

  // A reachability error always wins over a stale "Live"/"Quiet" (the #185 invariant): the pill must
  // never contradict the offline banner below it.
  if (error) return { label: 'Offline', tone: 'error', active: false };

  if (opts.busy && status === 'live') return { label: 'Working…', tone: 'busy', active: true };

  // Evicted-from-warm (no live socket) but otherwise healthy → Archived, not Offline.
  if (cold && (status === 'idle' || status === 'live')) {
    return { label: 'Archived', tone: 'archived', active: false };
  }

  switch (status) {
    case 'live':
      return { label: 'Live', tone: 'live', active: true };
    case 'idle':
      return { label: 'Quiet', tone: 'idle', active: true };
    case 'connecting':
      return { label: 'Connecting…', tone: 'connecting', active: true };
    case 'initializing':
    default:
      return { label: 'Initializing…', tone: 'initializing', active: false };
  }
}

import type { SessionView } from '@/session/view';
import type { TimelineState } from '@/lib/timeline';

/**
 * Whether a session's agent is mid-turn ("Working…"). The authoritative `timeline.busy` (set/cleared
 * by ACTIVITY / HEARTBEAT / STATE_SNAPSHOT) is the primary signal; a still-`running` tool item is a
 * safe fallback so a tool-first turn whose ACTIVITY(true) edge was missed still reads as working.
 * The fallback can't wedge: an authoritative idle settles any lingering running tool to `error`
 * (see applyEnvelope.noteBusySignal). Shared by the main SessionScreen (Stop control) AND the
 * sidebar/header pill so they can never disagree.
 */
export function isWorking(timeline: Pick<TimelineState, 'busy' | 'items'>): boolean {
  return timeline.busy || timeline.items.some((i) => i.kind === 'tool' && i.status === 'running');
}


/** The visual tone of a status pill — maps 1:1 to a `.status-line.<tone>` CSS class. */
export type StatusTone =
  | 'live'
  | 'idle'
  | 'busy'
  | 'listening'
  | 'speaking'
  | 'connecting'
  | 'initializing'
  | 'archived'
  | 'error'
  | 'ended';

/**
 * What the composer is doing right now, when that's more specific than "the agent is busy".
 * Fed by Vox (mic on / speaking aloud) and by plain dictation, so the header pill mirrors the
 * composer rather than sitting on a flat "Live" while the phone is clearly listening (#184).
 */
export type ComposerActivity = 'listening' | 'speaking';

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
 * `activity` is what the *composer* is doing (Vox listening / speaking aloud) and outranks `busy`,
 * because "the phone has your mic open" is the more urgent fact — and the dock itself is now silent
 * while a turn is in flight, so the pill is where that shows (#184).
 */
export function deriveStatus(
  view: Pick<SessionView, 'status' | 'cold' | 'error'>,
  opts: { busy?: boolean; activity?: ComposerActivity } = {},
): DerivedStatus {
  const { status, cold, error } = view;

  if (status === 'ended') return { label: 'Ended', tone: 'ended', active: false };

  // A reachability error always wins over a stale "Live"/"Quiet" (the #185 invariant): the pill must
  // never contradict the offline banner below it.
  if (error) return { label: 'Offline', tone: 'error', active: false };

  if (status === 'live' && opts.activity === 'listening') {
    return { label: 'Listening…', tone: 'listening', active: true };
  }
  if (status === 'live' && opts.activity === 'speaking') {
    return { label: 'Speaking…', tone: 'speaking', active: true };
  }

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

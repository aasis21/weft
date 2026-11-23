import { useEffect, useId, useState } from 'react';
import type { JSX } from 'react';
import type { ListenerDeviceState, RecoveryState } from '@/session/model';
import type { SessionView } from '@/session/view';
import { formatLastSeen } from '@/ui/screens/deviceDisplay';
import '@/ui/recovery/recovery.css';

/** Every row the recovery bar can show (LLD §7.3 copy table). */
export type RecoveryReason =
  | 'quiet'
  | 'connecting'
  | 'offline'
  | 'retrying'
  | 'asking'
  | 'repairing'
  | 'resuming'
  | 'linking'
  | 'done'
  | 'unreachable'
  | 'controller-conflict'
  | 'not-found'
  | 'update-required'
  | 'no-station'
  | 'ended'
  | 'owner-unknown'
  | 'needs-attention';

export type RecoveryAction =
  | 'reconnect'
  | 'cancel'
  | 'try-again'
  | 'take-over'
  | 'new-session'
  | 'how'
  | 'resume'
  | 'scan'
  | 'details';

interface CopyRow {
  bar: string;
  /** null = no action; `cancel` renders the ✕ button. */
  action: { id: RecoveryAction; label: string } | null;
  details: string;
}

const DEVICE = '‹device›';
const AGO = '‹ago›';

/** Copy, verbatim from LLD §7.3. ‹device› / ‹ago› are filled in at render time. */
export const RECOVERY_COPY: Record<RecoveryReason, CopyRow> = {
  quiet: {
    bar: 'Waiting for the laptop to reply…',
    action: null,
    details: "The connection is open but the laptop hasn't answered for a while. Weft keeps checking.",
  },
  connecting: {
    bar: 'Connecting to your session…',
    action: null,
    details: 'Setting up the secure link to the laptop.',
  },
  offline: {
    bar: 'This session is offline',
    action: { id: 'reconnect', label: 'Reconnect' },
    details: `Last seen ${AGO} on ${DEVICE}. Reconnect tries again and, if needed, asks the laptop to reopen it.`,
  },
  retrying: {
    bar: 'Trying to reconnect…',
    action: { id: 'cancel', label: '✕' },
    details: 'Retrying the link from your phone.',
  },
  asking: {
    bar: 'Asking your laptop to reopen the session…',
    action: { id: 'cancel', label: '✕' },
    details: `Request sent to ${DEVICE} through Station.`,
  },
  repairing: {
    bar: 'Reconnecting to the running session…',
    action: { id: 'cancel', label: '✕' },
    details: 'The session is still open on the laptop. Reconnecting to it.',
  },
  resuming: {
    bar: 'Opening the session in a new terminal…',
    action: { id: 'cancel', label: '✕' },
    details: 'Its terminal was closed. A new one is starting with this session resumed.',
  },
  linking: {
    bar: 'Connecting your phone to the session…',
    action: { id: 'cancel', label: '✕' },
    details: 'The laptop is ready. Finishing the secure link.',
  },
  done: {
    bar: 'Back online and ready',
    action: null,
    details: 'Reconnected to the running session / Opened in a new terminal.',
  },
  unreachable: {
    bar: "Your laptop isn't reachable right now",
    action: { id: 'try-again', label: 'Try again' },
    details: 'Wake the laptop and start Station: run weft, then Control → Start Station.',
  },
  'controller-conflict': {
    bar: 'Another phone is using this session',
    action: { id: 'take-over', label: 'Take over' },
    details: 'Taking over disconnects the other phone.',
  },
  'not-found': {
    bar: "This session isn't on the laptop anymore",
    action: { id: 'new-session', label: 'New session' },
    details: 'It was removed or belongs to another account.',
  },
  'update-required': {
    bar: 'Weft on your laptop needs an update',
    action: { id: 'how', label: 'How?' },
    details: 'Run weft update on the laptop, then restart Station.',
  },
  'no-station': {
    bar: 'This session is offline',
    action: { id: 'try-again', label: 'Try again' },
    details: 'If its terminal was closed, run /weft there and scan the new QR.',
  },
  ended: {
    bar: 'This session ended on the laptop',
    action: { id: 'resume', label: 'Resume' },
    details: 'Resume reopens it in a new terminal. Without Station, run /weft and scan.',
  },
  'owner-unknown': {
    bar: "Can't tell which process owns this session",
    action: { id: 'details', label: 'Details' },
    details: 'Close other Copilot windows using it, then Try again.',
  },
  'needs-attention': {
    bar: "Your laptop can't reconnect this session",
    action: { id: 'reconnect', label: 'Reconnect' },
    details: 'Station tried twice. See Control Center → Sessions.',
  },
};

const WORKING: ReadonlySet<RecoveryReason> = new Set(['retrying', 'asking', 'repairing', 'resuming', 'linking']);

export interface RecoveryStation {
  /** A Station device is known for this session. */
  known: boolean;
  /** That device's channel is connected right now. */
  reachable: boolean;
}

/** The Station device for a session, mirroring the runtime's choice (launched-from, lists it, only one). */
export function stationForSession(session: SessionView, devices: ListenerDeviceState[] | undefined): ListenerDeviceState | undefined {
  const list = devices ?? [];
  const from = session.meta.spawnedFromDeviceId;
  const sessionId = session.meta.sessionId;
  return (from ? list.find((d) => d.deviceId === from || d.channelId === from) : undefined)
    ?? (sessionId ? list.find((d) => d.sessions?.some((s) => s.sessionId === sessionId)) : undefined)
    ?? (list.length === 1 ? list[0] : undefined);
}

/**
 * Which row the bar shows for a session, or null when it is plainly linked. An active recover() run
 * wins; then the link (update required), the laptop's own end, Station's health verdict, and finally
 * the phone's connection state. `phone-away` is never an error.
 */
export function recoveryReason(session: SessionView, station: RecoveryStation): RecoveryReason | null {
  if (session.meta.kind !== 'live') return null;
  if (session.recovery) return session.recovery.phase;
  if (session.link?.updateRequired === 'laptop') return 'update-required';
  if (session.status === 'ended') return 'ended';
  if (session.status === 'live') return null;
  switch (session.health?.reason) {
    case 'owner-unknown':
      return 'owner-unknown';
    case 'needs-attention':
    case 'config-error':
      return 'needs-attention';
    case 'update-required':
      return 'update-required';
    case 'controller-conflict':
      return 'controller-conflict';
    default:
      break;
  }
  if (session.status === 'connecting' || session.status === 'initializing') return 'connecting';
  if (session.status === 'idle' && !session.cold) return 'quiet';
  if (!station.known) return 'no-station';
  return station.reachable ? 'offline' : 'unreachable';
}

/** `a-very-long-laptop-name` → `a-very-l…op-name`, keeping both ends readable. */
export function middleTruncate(text: string, max = 24): string {
  if (text.length <= max) return text;
  const keep = max - 1;
  const head = Math.ceil(keep / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (keep - head))}`;
}

const NARROW_QUERY = '(max-width: 320px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function' &&
    window.matchMedia(NARROW_QUERY)?.matches === true);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia(NARROW_QUERY);
    if (!media || typeof media.addEventListener !== 'function') return undefined;
    const update = (): void => setNarrow(media.matches === true);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  return narrow;
}

function activeStep(reason: RecoveryReason): number {
  switch (reason) {
    case 'retrying':
      return 0;
    case 'asking':
      return 1;
    case 'repairing':
    case 'resuming':
    case 'controller-conflict':
      return 2;
    case 'linking':
      return 3;
    case 'done':
      return 4;
    default:
      return -1;
  }
}

const NARROW_ICONS: Partial<Record<RecoveryAction, string>> = {
  'take-over': '⇄',
  how: '?',
  details: '?',
  'new-session': '+',
  scan: '⌗',
};

export interface RecoveryBarProps {
  reason: RecoveryReason;
  deviceName?: string | undefined;
  /** Last laptop contact (ms) for the offline details line. */
  lastSeenAt?: number | null | undefined;
  doneVia?: RecoveryState['doneVia'];
  /** Station is known, so `ended` offers Resume rather than Scan QR. */
  canResume?: boolean;
  /** Force the narrow (icon action) layout; defaults to a `max-width: 320px` media query. */
  compact?: boolean;
  now?: number;
  onAction(action: RecoveryAction): void;
}

/** One row (max two lines) attached to the top of the composer: icon | text | one action. */
export function RecoveryBar({
  reason,
  deviceName,
  lastSeenAt,
  doneVia,
  canResume = true,
  compact,
  now = Date.now(),
  onAction,
}: RecoveryBarProps): JSX.Element {
  const narrowQuery = useNarrow();
  const narrow = compact ?? narrowQuery;
  const [open, setOpen] = useState(false);
  const popoverId = useId();
  const copy = RECOVERY_COPY[reason];
  const device = deviceName ? middleTruncate(deviceName) : 'your laptop';
  const details = reason === 'done'
    ? (doneVia === 'resume' ? 'Opened in a new terminal.' : 'Reconnected to the running session.')
    : copy.details
      .replace(DEVICE, device)
      .replace(AGO, formatLastSeen(lastSeenAt ?? undefined, now) ?? 'a while ago');
  const action = reason === 'ended' && !canResume ? { id: 'scan' as const, label: 'Scan QR' } : copy.action;
  const working = WORKING.has(reason);
  const step = activeStep(reason);
  const tone = reason === 'done' ? 'ok' : working || reason === 'connecting' || reason === 'quiet' ? 'busy' : 'warn';
  const icon = tone === 'ok' ? '✓' : tone === 'busy' ? '↻' : '!';
  const runAction = (id: RecoveryAction): void => {
    if (id === 'how' || id === 'details') {
      setOpen(true);
      return;
    }
    onAction(id);
  };
  const steps = [
    'Retry the link from this phone',
    `Ask Station on ${device}`,
    doneVia === 'resume' || reason === 'resuming' ? 'Open the session in a new terminal' : 'Reconnect to the running session',
    'Connect your phone',
  ];
  return (
    <div
      className={`recovery-bar tone-${tone}${working ? ' is-working' : ''}${reason === 'done' ? ' is-done' : ''}${narrow ? ' is-narrow' : ''}`}
      role="status"
      aria-live="polite"
      data-reason={reason}
    >
      {working ? <span className="recovery-progress" aria-hidden="true" /> : null}
      {open ? (
        <div className="recovery-popover" id={popoverId} role="dialog" aria-label="Connection details">
          <div className="recovery-popover-device" title={deviceName}>{device}</div>
          <p className="recovery-popover-details">{details}</p>
          {step >= 0 ? (
            <ol className="recovery-steps">
              {steps.map((label, index) => (
                <li
                  key={label}
                  className={index < step ? 'is-done' : index === step ? 'is-active' : 'is-pending'}
                  {...(index === step ? { 'aria-current': 'step' as const } : {})}
                >
                  {label}
                </li>
              ))}
            </ol>
          ) : null}
        </div>
      ) : null}
      <span className="recovery-icon" aria-hidden="true">{icon}</span>
      <button
        type="button"
        className="recovery-text"
        aria-expanded={open}
        {...(open ? { 'aria-controls': popoverId } : {})}
        onClick={() => setOpen((value) => !value)}
      >
        {copy.bar}
      </button>
      {action ? (
        action.id === 'cancel' ? (
          <button type="button" className="recovery-action recovery-cancel" aria-label="Cancel" onClick={() => runAction('cancel')}>
            ✕
          </button>
        ) : narrow ? (
          <button
            type="button"
            className="recovery-action recovery-action-icon"
            aria-label={action.label}
            onClick={() => runAction(action.id)}
          >
            <span aria-hidden="true">{NARROW_ICONS[action.id] ?? '↻'}</span>
          </button>
        ) : (
          <button type="button" className="recovery-action" onClick={() => runAction(action.id)}>
            {action.label}
          </button>
        )
      ) : null}
    </div>
  );
}

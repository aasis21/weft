import type { LifecycleStatusMsg, OpenChallenge, OpenReason } from '@aasis21/weft-shared';

/** Plain words for a protocol v3 open request that did not finish (`lifecycle_status.reason`). */
export function openReasonMessage(reason: OpenReason | null | undefined): string {
  switch (reason) {
    case 'not-found':
      return 'This session isn\u2019t on the laptop anymore.';
    case 'owner-unknown':
      return 'Can\u2019t tell which process owns this session. Close other Copilot windows using it, then try again.';
    case 'controller-conflict':
      return 'Another phone is using this session.';
    case 'takeover-stale':
      return 'The session changed before the takeover was confirmed. Try again.';
    case 'update-required':
      return 'Weft on your laptop needs an update.';
    case 'config-error':
      return 'Weft on the laptop can\u2019t reach the relay. See Control Center \u2192 Sessions.';
    case 'launch-failed':
      return 'The laptop could not open a terminal for this session.';
    case 'runtime-unavailable':
      return 'The laptop is not reachable right now.';
    case 'link-failed':
      return 'The session is open, but the phone could not connect to it.';
    case 'timeout':
      return 'The laptop did not respond in time.';
    case 'invalid-request':
      return 'The laptop could not understand this request.';
    default:
      return 'The session could not be opened.';
  }
}

/** The message to show for a finished-but-unsuccessful open request; null while it is in flight. */
export function openStatusMessage(status: LifecycleStatusMsg): string | null {
  if (status.outcome === 'done') return null;
  if (status.outcome === 'cancelled') {
    return status.result?.mayBeRunning
      ? 'Cancelled. The session may still be starting on the laptop.'
      : 'The request was cancelled.';
  }
  if (status.outcome === 'outcome-unknown') {
    return 'The laptop may have opened the session; Weft will reconcile it before retrying.';
  }
  if (status.outcome === 'failed') return status.result?.message || openReasonMessage(status.reason);
  if (status.stage === 'awaiting-confirmation') return openReasonMessage(status.reason ?? 'controller-conflict');
  return null;
}

/** Station is waiting for the user to confirm a takeover bound to this exact challenge. */
export function requiresTakeoverConfirmation(
  status: LifecycleStatusMsg,
): status is LifecycleStatusMsg & { result: { challenge: OpenChallenge } } {
  const challenge = status.result?.challenge;
  return (
    status.outcome === null &&
    status.stage === 'awaiting-confirmation' &&
    typeof challenge?.challengeId === 'string' &&
    challenge.challengeId.length > 0
  );
}

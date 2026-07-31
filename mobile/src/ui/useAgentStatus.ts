import { useEffect, useState } from 'react';

/**
 * The one place that decides what a busy agent is called, so the chat thread and the Vox status
 * label can never drift apart.
 *
 * Precedence: what the agent said it is doing, then a live "Thinking… Ns" counter, then a plain
 * fallback. The seconds are counted here on this device from a locally stamped start time — the
 * laptop only ever tells us that thinking started, never when, so clock skew between the phone and
 * the laptop cannot produce a nonsense duration.
 */
export function useAgentStatus(
  intent: string | null | undefined,
  thinkingSince: number | null | undefined,
  fallback: string,
): string {
  const thinking = typeof thinkingSince === 'number' ? thinkingSince : null;
  const [seconds, setSeconds] = useState(() => elapsedSeconds(thinking));

  useEffect(() => {
    if (thinking === null) return;
    setSeconds(elapsedSeconds(thinking));
    // Only tick while a block is actually running, so an idle session holds no timer.
    const timer = setInterval(() => setSeconds(elapsedSeconds(thinking)), 1000);
    return () => clearInterval(timer);
  }, [thinking]);

  if (intent) return intent;
  if (thinking !== null) return `Thinking… ${seconds}s`;
  return fallback;
}

function elapsedSeconds(since: number | null): number {
  if (since === null) return 0;
  return Math.max(0, Math.floor((Date.now() - since) / 1000));
}

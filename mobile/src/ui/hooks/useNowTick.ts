import { useEffect, useState } from 'react';

export function useNowTick(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const tick = (): void => setNow(Date.now());
    const interval = window.setInterval(tick, intervalMs);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') tick();
    };

    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);

  return now;
}

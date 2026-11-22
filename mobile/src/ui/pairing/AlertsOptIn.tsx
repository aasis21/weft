import { useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ensureNotificationPermission, notificationPermission } from '@/lib/notifications';
import { ALERTS_PROMPT_KEY, isFlagDone, markFlagDone } from '@/lib/firstRun';

/**
 * In-context notification opt-in, shown once after a real pairing instead of a permission
 * prompt at launch. Hidden when permission was already decided or the card was answered.
 */
export function AlertsOptIn(): JSX.Element | null {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    let live = true;
    void Promise.all([notificationPermission(), isFlagDone(ALERTS_PROMPT_KEY)]).then(([permission, done]) => {
      if (live) setVisible(permission === 'prompt' && !done);
    });
    return () => {
      live = false;
    };
  }, []);

  if (!visible) return null;

  const answer = (allow: boolean): void => {
    setVisible(false);
    void markFlagDone(ALERTS_PROMPT_KEY);
    if (allow) void ensureNotificationPermission();
  };

  return (
    <section className="alerts-optin" aria-label="Approval alerts">
      <svg className="alerts-optin-icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
        strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="M6 9a6 6 0 0 1 12 0c0 6 2.5 7.5 2.5 7.5h-17S6 15 6 9" />
        <path d="M10.2 20a2 2 0 0 0 3.6 0" />
      </svg>
      <div className="alerts-optin-copy">
        <strong>Get approval alerts</strong>
        <span>A heads-up when Copilot needs your decision while Weft is in the background.</span>
      </div>
      <div className="alerts-optin-actions">
        <button type="button" className="alerts-optin-allow" onClick={() => answer(true)}>Allow</button>
        <button type="button" className="alerts-optin-later" onClick={() => answer(false)}>Not now</button>
      </div>
    </section>
  );
}

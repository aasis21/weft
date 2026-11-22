// Local, per-install "seen it" flags for first-run guidance. Not synced and not a credential:
// clearing app/site data resets them. A storage failure must never block pairing, so reads
// fall back to "not done" and writes are best-effort.
import { preferencesStorage } from '@/services/persistence/preferencesStorage';
import type { PersistStorage } from '@/services/persistence/preferencesStorage';

export const ONBOARDING_KEY = 'weft.onboarding.v1';
export const ALERTS_PROMPT_KEY = 'weft.alertsPrompt.v1';

export async function isFlagDone(key: string, storage: PersistStorage = preferencesStorage): Promise<boolean> {
  try {
    return (await storage.getItem(key)) === 'done';
  } catch {
    return false;
  }
}

export async function markFlagDone(key: string, storage: PersistStorage = preferencesStorage): Promise<void> {
  try {
    await storage.setItem(key, 'done');
  } catch {
    /* best-effort */
  }
}

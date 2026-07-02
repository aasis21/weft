import { Preferences } from '@capacitor/preferences';

export interface PersistStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export function createPreferencesStorage(): PersistStorage {
  return {
    async getItem(key) {
      try {
        const { value } = await Preferences.get({ key });
        return value ?? getLocalStorage()?.getItem(key) ?? null;
      } catch {
        return getLocalStorage()?.getItem(key) ?? null;
      }
    },
    async setItem(key, value) {
      let wrotePreferences = false;
      try {
        await Preferences.set({ key, value });
        wrotePreferences = true;
      } catch {
        // Fall through to the web storage mirror below.
      }
      const localStorage = getLocalStorage();
      if (localStorage) {
        localStorage.setItem(key, value);
        return;
      }
      if (!wrotePreferences) throw new Error('No Preferences or localStorage backend is available.');
    },
    async removeItem(key) {
      let removedPreferences = false;
      try {
        await Preferences.remove({ key });
        removedPreferences = true;
      } catch {
        // Fall through to the web storage mirror below.
      }
      const localStorage = getLocalStorage();
      if (localStorage) {
        localStorage.removeItem(key);
        return;
      }
      if (!removedPreferences) throw new Error('No Preferences or localStorage backend is available.');
    },
  };
}

export const preferencesStorage = createPreferencesStorage();

function getLocalStorage(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

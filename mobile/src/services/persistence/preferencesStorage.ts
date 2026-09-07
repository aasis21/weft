import { Preferences } from '@capacitor/preferences';
import { Capacitor } from '@capacitor/core';

export interface PersistStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

interface PreferencesStorageOptions {
  isNativePlatform?: () => boolean;
}

export function createPreferencesStorage(options: PreferencesStorageOptions = {}): PersistStorage {
  const isNativePlatform = options.isNativePlatform ?? detectNativePlatform;
  return {
    async getItem(key) {
      if (isNativePlatform()) {
        const { value } = await Preferences.get({ key });
        const localStorage = getLocalStorage();
        const legacy = localStorage?.getItem(key) ?? null;
        if (legacy !== null) {
          // Legacy native builds treated localStorage as the recovery source when a Preferences
          // write failed. Prefer that final mirror during the one-time migration so newer pending
          // operations are not replaced by an older Preferences snapshot.
          await Preferences.set({ key, value: legacy });
          localStorage?.removeItem(key);
          return legacy;
        }
        return value;
      }
      try {
        const { value } = await Preferences.get({ key });
        return value ?? getLocalStorage()?.getItem(key) ?? null;
      } catch {
        return getLocalStorage()?.getItem(key) ?? null;
      }
    },
    async setItem(key, value) {
      if (isNativePlatform()) {
        await Preferences.set({ key, value });
        getLocalStorage()?.removeItem(key);
        return;
      }
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
      if (isNativePlatform()) {
        let preferenceError: unknown;
        let localStorageError: unknown;
        try {
          await Preferences.remove({ key });
        } catch (error) {
          preferenceError = error;
        }
        try {
          getLocalStorage()?.removeItem(key);
        } catch (error) {
          localStorageError = error;
        }
        if (preferenceError) throw preferenceError;
        if (localStorageError) throw localStorageError;
        return;
      }
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

function detectNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

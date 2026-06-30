import { Preferences } from '@capacitor/preferences';

const PAIRING_KEY = 'helm.pairing.v1';

export interface StoredPairing {
  channelId: string;
  peerPublicKeyB64: string;
  publicKeyB64: string;
  privateKeyJwk: JsonWebKey;
  deviceId: string;
  savedAt: number;
}

export async function loadStoredPairing(): Promise<StoredPairing | null> {
  try {
    const { value } = await Preferences.get({ key: PAIRING_KEY });
    const raw = value ?? globalThis.localStorage?.getItem(PAIRING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredPairing;
  } catch {
    return null;
  }
}

export async function saveStoredPairing(pairing: StoredPairing): Promise<void> {
  const value = JSON.stringify(pairing);
  await Preferences.set({ key: PAIRING_KEY, value });
  globalThis.localStorage?.setItem(PAIRING_KEY, value);
}

export async function clearStoredPairing(): Promise<void> {
  await Preferences.remove({ key: PAIRING_KEY });
  globalThis.localStorage?.removeItem(PAIRING_KEY);
}

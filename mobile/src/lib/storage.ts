import type { TransportDescriptor } from '@aasis21/weft-shared';
import { preferencesStorage } from '@/services/persistence/preferencesStorage';

const PAIRING_KEY = 'weft.pairing.v1';

export interface StoredPairing {
  channelId: string;
  peerPublicKeyB64: string;
  publicKeyB64: string;
  privateKeyJwk: JsonWebKey;
  deviceId: string;
  savedAt: number;
  /** Pairing protocol used by the laptop. Missing means legacy version 1. */
  pairVersion?: 1 | 2;
  /** Which transport + endpoint this session was paired with — reused verbatim on reconnect. */
  transport: TransportDescriptor;
  /** The paired laptop's Weft version at pairing time (from the QR/pairing payload). Optional —
   *  older laptops omit it. Persisted with the session so Settings can show it after a reload. */
  appVersion?: string;
}

export async function loadStoredPairing(): Promise<StoredPairing | null> {
  try {
    const raw = await preferencesStorage.getItem(PAIRING_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as StoredPairing;
  } catch {
    return null;
  }
}

export async function saveStoredPairing(pairing: StoredPairing): Promise<void> {
  await preferencesStorage.setItem(PAIRING_KEY, JSON.stringify(pairing));
}

export async function clearStoredPairing(): Promise<void> {
  await preferencesStorage.removeItem(PAIRING_KEY);
}

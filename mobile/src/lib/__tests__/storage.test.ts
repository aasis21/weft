import { Preferences } from '@capacitor/preferences';
import { clearStoredPairing, loadStoredPairing, saveStoredPairing, type StoredPairing } from '@/lib/storage';

const pairing: StoredPairing = {
  channelId: 'ch1',
  peerPublicKeyB64: 'peer',
  publicKeyB64: 'pub',
  privateKeyJwk: { kty: 'oct', k: 'secret-key-material' },
  deviceId: 'device1',
  savedAt: 123,
  transport: { kind: 'local' },
};

describe('pairing storage', () => {
  it('returns null when missing', async () => {
    await expect(loadStoredPairing()).resolves.toBeNull();
  });

  it('save/load round-trips all fields and writes a localStorage mirror', async () => {
    await saveStoredPairing(pairing);

    await expect(loadStoredPairing()).resolves.toEqual(pairing);
    expect(localStorage.getItem('weft.pairing.v1')).toBe(JSON.stringify(pairing));
  });

  it('clear removes the pairing', async () => {
    await saveStoredPairing(pairing);
    await clearStoredPairing();

    await expect(loadStoredPairing()).resolves.toBeNull();
    expect(localStorage.getItem('weft.pairing.v1')).toBeNull();
  });

  it('returns null instead of throwing for corrupt JSON', async () => {
    await Preferences.set({ key: 'weft.pairing.v1', value: '{not-json' });

    await expect(loadStoredPairing()).resolves.toBeNull();
  });
});

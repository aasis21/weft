import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import {
  loadPendingOperations,
  upsertPendingOperation,
  type PendingOperation,
} from '@/lib/pendingOperations';
import { loadSessions, upsertSession, type StoredSession } from '@/lib/sessions';
import type { StoredPairing } from '@/lib/storage';

const privateKeyJwk = {
  kty: 'EC',
  crv: 'P-256',
  x: 'public-x',
  y: 'public-y',
  d: 'private-secret',
} satisfies JsonWebKey;

function pairing(channelId: string): StoredPairing {
  return {
    channelId,
    peerPublicKeyB64: `peer-${channelId}`,
    publicKeyB64: `phone-${channelId}`,
    privateKeyJwk,
    deviceId: 'phone-id',
    savedAt: 100,
    transport: { kind: 'local' },
  };
}

describe('native private-key persistence', () => {
  beforeEach(() => {
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
  });

  it('stores session and pending-operation key material only in Preferences', async () => {
    const storedPairing = pairing('session-1');
    const session: StoredSession = {
      pairing: storedPairing,
      title: 'Session',
      cwd: null,
      addedAt: 100,
      lastSeenAt: 100,
    };
    const pending: PendingOperation = {
      requestId: 'request-1',
      tempId: 'temp-1',
      kind: 'new',
      deviceId: 'listener-1',
      spawnedFromDeviceId: 'listener-1',
      projectName: 'weft',
      mode: 'default',
      createdAt: 100,
      stage: 'ready',
      phoneIdentity: {
        publicKeyB64: 'phone-public',
        privateKeyJwk,
        deviceId: 'phone-id',
      },
    };

    await upsertSession(session);
    await upsertPendingOperation(pending);

    for (const key of ['weft.sessions.v1', 'weft.pendingOperations.v1']) {
      expect(localStorage.getItem(key)).toBeNull();
      expect((await Preferences.get({ key })).value).toContain('private-secret');
    }
  });

  it('migrates legacy native localStorage key material once and removes the browser copies', async () => {
    const session = {
      sessions: [
        {
          pairing: pairing('session-legacy'),
          title: null,
          cwd: null,
          addedAt: 100,
          lastSeenAt: 100,
        },
      ],
      lastActiveId: null,
    };
    const pending = {
      operations: [
        {
          requestId: 'request-legacy',
          tempId: 'temp-legacy',
          kind: 'new',
          deviceId: 'listener-legacy',
          spawnedFromDeviceId: 'listener-legacy',
          projectName: 'weft',
          mode: 'default',
          createdAt: 100,
          stage: 'ready',
          phoneIdentity: {
            publicKeyB64: 'phone-public',
            privateKeyJwk,
            deviceId: 'phone-id',
          },
        },
      ],
    };
    localStorage.setItem('weft.sessions.v1', JSON.stringify(session));
    localStorage.setItem('weft.pendingOperations.v1', JSON.stringify(pending));

    await expect(loadSessions()).resolves.toHaveLength(1);
    await expect(loadPendingOperations()).resolves.toHaveLength(1);

    for (const key of ['weft.sessions.v1', 'weft.pendingOperations.v1']) {
      expect(localStorage.getItem(key)).toBeNull();
      expect((await Preferences.get({ key })).value).toContain('private-secret');
    }
  });
});

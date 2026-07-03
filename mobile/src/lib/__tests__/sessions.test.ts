import { loadSessions, patchSession, removeSession, upsertSession, type StoredSession } from '@/lib/sessions';
import { saveStoredPairing, type StoredPairing } from '@/lib/storage';

function pairing(channelId: string, savedAt = 1): StoredPairing {
  return {
    channelId,
    peerPublicKeyB64: `peer-${channelId}`,
    publicKeyB64: `pub-${channelId}`,
    privateKeyJwk: { kty: 'oct', k: `key-${channelId}` },
    deviceId: `device-${channelId}`,
    savedAt,
  };
}

function session(channelId: string, overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    pairing: pairing(channelId, overrides.addedAt ?? 10),
    title: `Title ${channelId}`,
    cwd: `C:\\${channelId}`,
    addedAt: 10,
    lastSeenAt: 10,
    ...overrides,
  };
}

describe('sessions storage', () => {
  it('loads empty, upserts, replaces by channel id, patches existing sessions, and removes', async () => {
    await expect(loadSessions()).resolves.toEqual([]);

    await upsertSession(session('ch1', { sessionId: 's1' }));
    expect(await loadSessions()).toEqual([session('ch1', { sessionId: 's1' })]);

    await upsertSession(session('ch1', { title: 'Replacement', cwd: 'D:\\repo', sessionId: 's2', lastSeenAt: 20 }));
    let loaded = await loadSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ title: 'Replacement', cwd: 'D:\\repo', sessionId: 's2', lastSeenAt: 20 });

    await patchSession('ch1', { title: 'Patched', cwd: 'E:\\repo', lastSeenAt: 30, sessionId: 's3', lastEventAt: 31, unread: true });
    loaded = await loadSessions();
    expect(loaded[0]).toMatchObject({ title: 'Patched', cwd: 'E:\\repo', lastSeenAt: 30, sessionId: 's3', lastEventAt: 31, unread: true });

    await patchSession('missing', { title: 'Noop' });
    expect(await loadSessions()).toEqual(loaded);

    await removeSession('ch1');
    expect(await loadSessions()).toEqual([]);
  });

  it('dedupes real session ids by newest lastSeenAt while preserving position', async () => {
    const old = session('old', { sessionId: 'same', lastSeenAt: 10 });
    const distinct = session('distinct', { sessionId: 'other', lastSeenAt: 12 });
    const newer = session('newer', { sessionId: 'same', lastSeenAt: 20 });
    await upsertSession(old);
    await upsertSession(distinct);
    await upsertSession(newer);

    const loaded = await loadSessions();
    expect(loaded.map((s) => s.pairing.channelId)).toEqual(['newer', 'distinct']);
    expect(loaded[0]).toMatchObject({ sessionId: 'same', lastSeenAt: 20 });
  });

  it('prefers the freshly re-scanned channel (newer savedAt) even if its open time is older (#130)', async () => {
    // Simulate a crash between a `copilot --resume` re-scan and channel_up: the OLD dead channel was
    // opened more recently (higher lastSeenAt), but the NEW channel was scanned later (higher
    // pairing.savedAt). The newer scan must win, not the newer open.
    const stale = {
      pairing: pairing('stale-ch', 100),
      title: 'Session',
      cwd: null,
      addedAt: 100,
      lastSeenAt: 500, // opened most recently
      sessionId: 'dur',
    } satisfies StoredSession;
    const rescanned = {
      pairing: pairing('fresh-ch', 900), // scanned later
      title: 'Session',
      cwd: null,
      addedAt: 900,
      lastSeenAt: 200,
      sessionId: 'dur',
    } satisfies StoredSession;
    await upsertSession(stale);
    await upsertSession(rescanned);

    const loaded = await loadSessions();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].pairing.channelId).toBe('fresh-ch');
  });

  it('does not collapse missing, null, or unknown-session session ids', async () => {
    await upsertSession(session('none-a', { sessionId: undefined }));
    await upsertSession(session('none-b', { sessionId: undefined }));
    await upsertSession(session('null-a', { sessionId: null }));
    await upsertSession(session('null-b', { sessionId: null }));
    await upsertSession(session('unknown-a', { sessionId: 'unknown-session' }));
    await upsertSession(session('unknown-b', { sessionId: 'unknown-session' }));
    await upsertSession(session('real-a', { sessionId: 'real-a' }));
    await upsertSession(session('real-b', { sessionId: 'real-b' }));

    expect((await loadSessions()).map((s) => s.pairing.channelId)).toEqual([
      'none-a',
      'none-b',
      'null-a',
      'null-b',
      'unknown-a',
      'unknown-b',
      'real-a',
      'real-b',
    ]);
  });

  it('migrates a legacy pairing into the sessions list and persists it', async () => {
    const legacy = pairing('legacy', 123);
    await saveStoredPairing(legacy);

    const loaded = await loadSessions();
    expect(loaded).toEqual([{ pairing: legacy, title: null, cwd: null, addedAt: 123, lastSeenAt: 123 }]);

    localStorage.removeItem('helm.pairing.v1');
    expect(await loadSessions()).toEqual(loaded);
    expect(localStorage.getItem('helm.sessions.v1')).toBe(JSON.stringify(loaded));
  });
});

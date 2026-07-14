import {
  loadLastActiveSessionId,
  loadSessions,
  patchSession,
  removeSession,
  setLastActiveSessionId,
  upsertSession,
  type StoredSession,
} from '@/lib/sessions';
import { saveStoredPairing, type StoredPairing } from '@/lib/storage';
import { Preferences } from '@capacitor/preferences';

function pairing(channelId: string, savedAt = 1): StoredPairing {
  return {
    channelId,
    peerPublicKeyB64: `peer-${channelId}`,
    publicKeyB64: `pub-${channelId}`,
    privateKeyJwk: { kty: 'oct', k: `key-${channelId}` },
    deviceId: `device-${channelId}`,
    savedAt,
    transport: { kind: 'local' },
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

  it('persists the #163 lifecycle clocks and pin flag through patchSession', async () => {
    await upsertSession(session('ch-life', { sessionId: 's-life' }));

    await patchSession('ch-life', {
      lastHeartbeatAt: 1_000,
      lastSubscribedAt: 2_000,
      pinned: true,
    });
    let loaded = await loadSessions();
    expect(loaded[0]).toMatchObject({
      lastHeartbeatAt: 1_000,
      lastSubscribedAt: 2_000,
      pinned: true,
    });

    // A later liveness write advances the witnessed-subscription clock without clobbering the pin.
    await patchSession('ch-life', { lastHeartbeatAt: 5_000, lastSubscribedAt: 6_000 });
    loaded = await loadSessions();
    expect(loaded[0]).toMatchObject({ lastHeartbeatAt: 5_000, lastSubscribedAt: 6_000, pinned: true });

    // Unpin persists as false.
    await patchSession('ch-life', { pinned: false });
    loaded = await loadSessions();
    expect(loaded[0]).toMatchObject({ pinned: false });
  });

  it('still persists channel IDs to the localStorage mirror when the Preferences backend throws (#186)', async () => {
    const { Preferences } = await import('@capacitor/preferences');
    const setSpy = vi.spyOn(Preferences, 'set').mockRejectedValue(new Error('no Preferences backend'));
    try {
      await upsertSession(session('ch-web', { sessionId: 'sw' }));
      // The write must not throw, and the joined channel must survive because the localStorage mirror
      // was written even though Preferences.set rejected.
      expect(localStorage.getItem('weft.sessions.v1')).toContain('ch-web');
      expect(await loadSessions()).toEqual([session('ch-web', { sessionId: 'sw' })]);
    } finally {
      setSpy.mockRestore();
    }
  });

  it('persists last active id as top-level session-list metadata', async () => {
    await upsertSession(session('ch1'));
    await setLastActiveSessionId('ch1');
    expect(await loadLastActiveSessionId()).toBe('ch1');

    await patchSession('ch1', { title: 'Still here' });
    expect(await loadLastActiveSessionId()).toBe('ch1');
    expect(await loadSessions()).toEqual([session('ch1', { title: 'Still here' })]);

    await setLastActiveSessionId(null);
    expect(await loadLastActiveSessionId()).toBeNull();
  });

  it('reads legacy array-shaped session stores as sessions with no last active id', async () => {
    const legacy = [session('legacy')];
    localStorage.setItem('weft.sessions.v1', JSON.stringify(legacy));

    expect(await loadSessions()).toEqual(legacy);
    expect(await loadLastActiveSessionId()).toBeNull();
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

    localStorage.removeItem('weft.pairing.v1');
    expect(await loadSessions()).toEqual(loaded);
    expect(JSON.parse(localStorage.getItem('weft.sessions.v1') ?? '{}')).toEqual({
      sessions: loaded,
      lastActiveId: null,
    });
  });
});

describe('loadSessions source cleanup', () => {
  const TRANSCRIPT = (ch: string) => `weft.transcript.v1.${ch}`;
  const EVENTLOG = (ch: string) => `weft.eventlog.v1.${ch}`;

  function seedTranscript(ch: string): void {
    localStorage.setItem(TRANSCRIPT(ch), JSON.stringify({ v: 1, savedAt: 1, data: {} }));
    localStorage.setItem(EVENTLOG(ch), JSON.stringify({ v: 1, savedAt: 1, events: [] }));
  }
  async function seedRawStore(sessions: unknown[]): Promise<void> {
    await Preferences.set({
      key: 'weft.sessions.v1',
      value: JSON.stringify({ sessions, lastActiveId: null }),
    });
  }
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('clears transcript + event-log for a legacy session dropped by isStoredSession', async () => {
    // A pre-transport-refactor entry (no pairing.transport) is silently rejected on load.
    const legacy = { ...session('legacy'), pairing: { ...pairing('legacy'), transport: undefined } };
    await seedRawStore([legacy, session('good')]);
    seedTranscript('legacy');
    seedTranscript('good');

    const loaded = await loadSessions();
    await flush();

    expect(loaded.map((s) => s.pairing.channelId)).toEqual(['good']);
    expect(localStorage.getItem(TRANSCRIPT('legacy'))).toBeNull();
    expect(localStorage.getItem(EVENTLOG('legacy'))).toBeNull();
    expect(localStorage.getItem(TRANSCRIPT('good'))).toBeTruthy();
    expect(localStorage.getItem(EVENTLOG('good'))).toBeTruthy();
  });

  it('clears transcript + event-log for the loser of a dedupeBySessionId collapse', async () => {
    // Two cards share sessionId 's1'; the higher pairing.savedAt (chNew) wins, chOld is dropped.
    const chOld = { ...session('chOld', { sessionId: 's1' }), pairing: pairing('chOld', 10) };
    const chNew = { ...session('chNew', { sessionId: 's1' }), pairing: pairing('chNew', 20) };
    await seedRawStore([chOld, chNew]);
    seedTranscript('chOld');
    seedTranscript('chNew');

    const loaded = await loadSessions();
    await flush();

    expect(loaded.map((s) => s.pairing.channelId)).toEqual(['chNew']);
    expect(localStorage.getItem(TRANSCRIPT('chOld'))).toBeNull();
    expect(localStorage.getItem(EVENTLOG('chOld'))).toBeNull();
    expect(localStorage.getItem(TRANSCRIPT('chNew'))).toBeTruthy();
    expect(localStorage.getItem(EVENTLOG('chNew'))).toBeTruthy();
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { loadSessions, setLastActiveSessionId, upsertSession } from '@/lib/sessions';
import { fakePairing } from '@/test/helpers/fakeWeftClient';
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';
import * as B from '@/test/helpers/builders';

const HOUR = 60 * 60 * 1_000;
const AUTO_ARCHIVE_MS = 6 * HOUR;

describe('scenario: #163 auto-archive (6h witnessed silence → cold/Archived)', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });

  afterEach(() => {
    h?.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('watchdog cools a non-active session to Archived after 6h of silence, sparing the active one', async () => {
    h = makeManager();
    await h.init();
    const { client: c1 } = await h.pair('c1');
    // Pairing c2 second makes it the active card; c1 becomes a background (non-active) session.
    const { client: c2 } = await h.pair('c2');
    expect(h.active()?.meta.channelId).toBe('c2');

    c1.emit(B.heartbeat(1, false));
    c2.emit(B.heartbeat(1, false));
    await h.flush();
    expect(h.byChannel('c1')).toMatchObject({ status: 'live' });

    // Cross the 6h archive window. The background session cools to Archived; the active session the
    // user is looking at is never archived out from under them (it merely goes Offline).
    await vi.advanceTimersByTimeAsync(AUTO_ARCHIVE_MS + 5_000);

    expect(h.byChannel('c1')?.cold).toBe(true);
    expect(h.byChannel('c1')).toMatchObject({ status: 'idle' });
    expect(h.byChannel('c2')?.cold).toBeFalsy();
  });

  it('boots a witnessed-silence >6h (but <2d) session straight into Archived, without deleting it', async () => {
    const now = Date.now();
    const base = { title: 't', cwd: '/repo', addedAt: 1, lastSeenAt: 1 };

    // 8h of witnessed silence → archive (not delete). Not the active card, so not spared.
    await upsertSession({
      ...base,
      pairing: fakePairing('stale'),
      lastHeartbeatAt: now - 8 * HOUR,
      lastSubscribedAt: now,
    });
    // 5m of witnessed silence → stays a normal warm session.
    await upsertSession({
      ...base,
      pairing: fakePairing('fresh'),
      lastHeartbeatAt: now - 5 * 60 * 1_000,
      lastSubscribedAt: now,
    });
    await setLastActiveSessionId('fresh');

    h = makeManager();
    await h.init();
    await h.flush();

    expect(h.byChannel('stale')?.cold).toBe(true);
    expect(h.byChannel('stale')).toMatchObject({ status: 'idle' });
    expect(h.byChannel('fresh')?.cold).toBeFalsy();

    // Neither is purged — archive is calm and reversible; only 2-day silence deletes.
    const stored = (await loadSessions()).map((s) => s.pairing.channelId).sort();
    expect(stored).toEqual(['fresh', 'stale']);
  });

  it('spares a pinned session from auto-archive even past the 6h window', async () => {
    const now = Date.now();
    await upsertSession({
      pairing: fakePairing('pinned'),
      title: 't',
      cwd: '/repo',
      addedAt: 1,
      lastSeenAt: 1,
      pinned: true,
      lastHeartbeatAt: now - 8 * HOUR,
      lastSubscribedAt: now,
    });
    await setLastActiveSessionId('other-active');

    h = makeManager();
    await h.init();
    await h.flush();

    expect(h.byChannel('pinned')?.cold).toBeFalsy();
  });
});

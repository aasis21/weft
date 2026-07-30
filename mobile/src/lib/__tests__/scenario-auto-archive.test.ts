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
const DAY = 24 * HOUR;
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

describe('scenario: archive when both liveness clocks have gone stale', () => {
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

  const base = { title: 't', cwd: '/repo', addedAt: 1, lastSeenAt: 1 };

  it('archives a session the phone last saw days ago, even though its witnessed silence is tiny', async () => {
    const now = Date.now();
    // The shape a closed phone leaves behind: we subscribed, got a pulse moments later, then the app
    // stopped running. Witnessed silence is ~1 minute forever, so the 6h rule can never fire — this
    // is exactly the card that sat in Offline showing a twelve-day-old message.
    await upsertSession({
      ...base,
      pairing: fakePairing('put-down'),
      lastHeartbeatAt: now - 11 * DAY,
      lastSubscribedAt: now - 11 * DAY + 60_000,
    });
    // A second, healthy card to hold the active slot — the session the user is looking at is always
    // spared, and with only one stored session that would be this one.
    await upsertSession({
      ...base,
      pairing: fakePairing('current'),
      lastHeartbeatAt: now - 60_000,
      lastSubscribedAt: now,
    });
    await setLastActiveSessionId('current');

    h = makeManager();
    await h.init();
    await h.flush();

    expect(h.byChannel('put-down')?.cold).toBe(true);
    // Archived, not deleted: witnessed silence never crossed the delete window, so the transcript
    // survives and the user can tap to reconnect.
    const stored = (await loadSessions()).map((s) => s.pairing.channelId);
    expect(stored).toContain('put-down');
  });

  it('leaves a session alone when only one of the two clocks is stale', async () => {
    const now = Date.now();
    // Laptop shut for the weekend, phone still checking in: the heartbeat is ancient but we have
    // been watching, so the witness is fresh. Rule 1 owns this case on its own schedule.
    await upsertSession({
      ...base,
      pairing: fakePairing('checked-recently'),
      lastHeartbeatAt: now - 5 * DAY,
      lastSubscribedAt: now - 60_000,
    });
    // The mirror image: paired long ago, beating away happily, the phone just hasn't looked lately.
    await upsertSession({
      ...base,
      pairing: fakePairing('beating-fine'),
      lastHeartbeatAt: now - 60_000,
      lastSubscribedAt: now - 5 * DAY,
    });
    await setLastActiveSessionId('someone-else');

    h = makeManager();
    await h.init();
    await h.flush();

    // 'checked-recently' has 5 days of witnessed silence, so the delete sweep claims it before any
    // archive rule can — that is rule 1 working, not the composite one.
    expect(h.byChannel('beating-fine')?.cold).toBeFalsy();
  });

  it('spares a pinned session from the stale-clock rule too', async () => {
    const now = Date.now();
    await upsertSession({
      ...base,
      pairing: fakePairing('pinned-old'),
      pinned: true,
      lastHeartbeatAt: now - 11 * DAY,
      lastSubscribedAt: now - 11 * DAY + 60_000,
    });
    await upsertSession({
      ...base,
      pairing: fakePairing('current'),
      lastHeartbeatAt: now - 60_000,
      lastSubscribedAt: now,
    });
    await setLastActiveSessionId('current');

    h = makeManager();
    await h.init();
    await h.flush();

    expect(h.byChannel('pinned-old')?.cold).toBeFalsy();
  });
});

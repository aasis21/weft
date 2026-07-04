import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@capacitor/app', () => ({
  App: { addListener: vi.fn().mockResolvedValue({ remove: vi.fn() }) },
}));
import { loadSessions, setLastActiveSessionId, upsertSession } from '@/lib/sessions';
import { fakePairing } from '@/test/helpers/fakeHelmClient';
import { App } from '@capacitor/app';
import { makeManager } from '@/test/helpers/makeManager';

const DAY = 24 * 60 * 60 * 1_000;

describe('scenario: #163 lifecycle — boot witnessed-silence delete sweep', () => {
  let h: ReturnType<typeof makeManager> | undefined;

  beforeEach(() => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-01T00:00:00Z'));
  });

  afterEach(() => {
    h?.dispose();
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('purges only witnessed-silence-expired, non-pinned, non-spared sessions on init', async () => {
    const now = Date.now();
    const base = {
      title: 't',
      cwd: '/repo',
      addedAt: 1,
      lastSeenAt: 1,
    };

    // Eligible: the app *witnessed* 3 days of silence (subscribed but heartbeat never advanced).
    await upsertSession({
      ...base,
      pairing: fakePairing('doomed'),
      lastHeartbeatAt: now - 3 * DAY,
      lastSubscribedAt: now,
    });
    // Pinned — same witnessed silence, but pin is an unconditional shield.
    await upsertSession({
      ...base,
      pairing: fakePairing('pinned'),
      pinned: true,
      lastHeartbeatAt: now - 3 * DAY,
      lastSubscribedAt: now,
    });
    // Phone-off-safe: the laptop was alive, phone just wasn't running to witness it, so the two
    // clocks stayed close — only ~1h of *witnessed* silence. Must survive.
    await upsertSession({
      ...base,
      pairing: fakePairing('phone-off'),
      lastHeartbeatAt: now - 10 * DAY,
      lastSubscribedAt: now - 10 * DAY + 60 * 60 * 1_000,
    });
    // Never witnessed a pulse (missing a clock) — never eligible.
    await upsertSession({
      ...base,
      pairing: fakePairing('never-witnessed'),
      lastHeartbeatAt: now - 5 * DAY,
    });

    h = makeManager();
    await h.init();
    await h.flush();

    const surviving = h.sessions().map((s) => s.meta.channelId).sort();
    expect(surviving).toEqual(['never-witnessed', 'phone-off', 'pinned']);

    const stored = (await loadSessions()).map((s) => s.pairing.channelId).sort();
    expect(stored).toEqual(['never-witnessed', 'phone-off', 'pinned']);
  });

  it('spares the last-active session even when its witnessed silence is expired', async () => {
    const now = Date.now();
    await upsertSession({
      pairing: fakePairing('spare-me'),
      title: 't',
      cwd: '/repo',
      addedAt: 1,
      lastSeenAt: 1,
      lastHeartbeatAt: now - 3 * DAY,
      lastSubscribedAt: now,
    });
    await setLastActiveSessionId('spare-me');

    h = makeManager();
    await h.init();
    await h.flush();

    expect(h.sessions().map((s) => s.meta.channelId)).toEqual(['spare-me']);
  });
});

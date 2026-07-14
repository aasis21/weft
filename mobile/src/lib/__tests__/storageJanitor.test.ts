import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  estimateUsageChars,
  freeSpaceUntilFitsSync,
  sweepStorage,
  usageSnapshot,
} from '@/lib/storageJanitor';
import { loadSessions, upsertSession, type StoredSession } from '@/lib/sessions';
import type { StoredPairing } from '@/lib/storage';

const TRANSCRIPT = (ch: string) => `weft.transcript.v1.${ch}`;
const EVENTLOG = (ch: string) => `weft.eventlog.v1.${ch}`;

/** Write a transcript-shaped envelope of roughly `size` chars for a channel, stamped `savedAt`. */
function putTranscript(ch: string, savedAt: number, size = 200): void {
  const data = { pad: 'x'.repeat(Math.max(0, size)) };
  localStorage.setItem(TRANSCRIPT(ch), JSON.stringify({ v: 1, savedAt, data }));
}
/** Write a realistically-shaped transcript with `items` + `history` arrays so compaction has
 *  something to trim. */
function putRealTranscript(ch: string, savedAt: number, itemCount: number, histCount: number): void {
  const data = {
    items: Array.from({ length: itemCount }, (_, i) => ({ id: `i${i}`, kind: 'assistant', text: 'z'.repeat(100) })),
    history: Array.from({ length: histCount }, (_, i) => ({ turnIndex: i, role: 'user', text: 'h'.repeat(100) })),
    historyCursor: null,
    historyHasMore: false,
    mode: 'interactive',
    title: 't',
    cwd: null,
    latestTurnIndex: null,
  };
  localStorage.setItem(TRANSCRIPT(ch), JSON.stringify({ v: 1, savedAt, data }));
}
function putEventLog(ch: string, savedAt: number, size = 200): void {
  const events = [{ pad: 'y'.repeat(Math.max(0, size)) }];
  localStorage.setItem(EVENTLOG(ch), JSON.stringify({ v: 1, savedAt, events }));
}

function pairing(channelId: string): StoredPairing {
  return {
    channelId,
    peerPublicKeyB64: `peer-${channelId}`,
    publicKeyB64: `pub-${channelId}`,
    privateKeyJwk: { kty: 'oct', k: `key-${channelId}` },
    deviceId: `device-${channelId}`,
    savedAt: 1,
    transport: { kind: 'local' },
  };
}
function session(channelId: string): StoredSession {
  return { pairing: pairing(channelId), title: channelId, cwd: null, addedAt: 10, lastSeenAt: 10 };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('storageJanitor.sweepStorage', () => {
  it('evicts orphaned transcripts/event-logs but keeps live channels and precious keys', async () => {
    localStorage.setItem('weft.sessions.v1', JSON.stringify({ sessions: [], lastActiveId: null }));
    localStorage.setItem('weft.devices.v1', 'devices');
    localStorage.setItem('weft.settings.v1', 'settings');
    putTranscript('live', 100);
    putEventLog('live', 100);
    putTranscript('orphan', 100);
    putEventLog('orphan', 100);

    const res = await sweepStorage({ validChannelIds: ['live'], protectChannelIds: ['live'] });

    expect(res.evicted).toBe(2);
    expect(localStorage.getItem(TRANSCRIPT('orphan'))).toBeNull();
    expect(localStorage.getItem(EVENTLOG('orphan'))).toBeNull();
    expect(localStorage.getItem(TRANSCRIPT('live'))).toBeTruthy();
    expect(localStorage.getItem(EVENTLOG('live'))).toBeTruthy();
    // Precious keys are never touched.
    expect(localStorage.getItem('weft.sessions.v1')).toBeTruthy();
    expect(localStorage.getItem('weft.devices.v1')).toBe('devices');
    expect(localStorage.getItem('weft.settings.v1')).toBe('settings');
  });

  it('trims oldest cold entries toward budget while protecting the active channel', async () => {
    putTranscript('active', 500, 4000);
    putTranscript('cold-new', 300, 4000);
    putTranscript('cold-old', 100, 4000);

    const res = await sweepStorage({
      validChannelIds: ['active', 'cold-new', 'cold-old'],
      protectChannelIds: ['active'],
      budgetChars: 9000, // room for ~2 of the ~4000-char entries
    });

    expect(res.evicted).toBeGreaterThanOrEqual(1);
    expect(localStorage.getItem(TRANSCRIPT('active'))).toBeTruthy(); // protected
    expect(localStorage.getItem(TRANSCRIPT('cold-old'))).toBeNull(); // oldest evicted first
    expect(estimateUsageChars()).toBeLessThanOrEqual(9000);
  });

  it('compacts a cold transcript to its recent tail instead of dropping the whole chat', async () => {
    putRealTranscript('archived', 100, 100, 100); // 100 items + 100 history

    const res = await sweepStorage({
      validChannelIds: ['archived'],
      protectChannelIds: [], // cold/archived (not warm) → eligible for compaction
      budgetChars: 8000,
    });

    const raw = localStorage.getItem(TRANSCRIPT('archived'));
    expect(raw).toBeTruthy(); // chat preserved, NOT evicted
    expect(res.compacted).toBe(1);
    expect(res.evicted).toBe(0);

    const data = JSON.parse(raw as string).data;
    expect(data.items).toHaveLength(40); // trimmed to the last 40 items
    expect(data.items[0].id).toBe('i60'); // kept the most recent tail (i60..i99)
    expect(data.history).toHaveLength(0); // history dropped (re-pulls from laptop)
    expect(data.historyHasMore).toBe(true); // UI can offer to load older turns again
  });

  it('reports usage via usageSnapshot', () => {
    putTranscript('a', 1, 1000);
    const snap = usageSnapshot();
    expect(snap.chars).toBeGreaterThan(1000);
    expect(snap.bytes).toBe(snap.chars * 2);
  });
});

describe('storageJanitor.freeSpaceUntilFitsSync', () => {
  it('evicts prunable entries until a quota-limited setItem succeeds', () => {
    putTranscript('orphan-1', 100, 2000);
    putTranscript('orphan-2', 200, 2000);
    putTranscript('orphan-3', 300, 2000);

    // Simulate a real ~2500-char cap: a write throws while the OTHER keys already exceed it, and only
    // starts fitting once enough prunable weight is evicted.
    const real = Storage.prototype.setItem;
    const CAP = 2500;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      let other = 0;
      for (let i = 0; i < this.length; i++) {
        const kk = this.key(i);
        if (!kk || kk === k) continue;
        other += kk.length + (this.getItem(kk)?.length ?? 0);
      }
      if (other + k.length + v.length > CAP) throw new DOMException('quota', 'QuotaExceededError');
      return real.call(this, k, v);
    });

    const ok = freeSpaceUntilFitsSync('weft.sessions.v1', 'the-list', {
      validChannelIds: [],
      protectChannelIds: [],
    });

    expect(ok).toBe(true);
    expect(localStorage.getItem('weft.sessions.v1')).toBe('the-list');
    // Two oldest orphans were sacrificed to make room; the newest survives.
    expect(localStorage.getItem(TRANSCRIPT('orphan-1'))).toBeNull();
    expect(localStorage.getItem(TRANSCRIPT('orphan-2'))).toBeNull();
    expect(localStorage.getItem(TRANSCRIPT('orphan-3'))).toBeTruthy();
  });
});

describe('sessions.ts quota-safe write', () => {
  it('keeps the session list on a QuotaExceededError by evicting regenerable transcripts', async () => {
    // A heavy orphan transcript occupies the store; the session-list write hits quota, the janitor
    // frees the orphan, and the retry lands — so the list survives the refresh.
    putTranscript('orphan', 100, 5000);

    const real = Storage.prototype.setItem;
    const CAP = 4000;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
      let other = 0;
      for (let i = 0; i < this.length; i++) {
        const kk = this.key(i);
        if (!kk || kk === k) continue;
        other += kk.length + (this.getItem(kk)?.length ?? 0);
      }
      if (other + k.length + v.length > CAP) throw new DOMException('quota', 'QuotaExceededError');
      return real.call(this, k, v);
    });

    await upsertSession(session('ch1'));

    const loaded = await loadSessions();
    expect(loaded.map((s) => s.pairing.channelId)).toEqual(['ch1']);
    expect(localStorage.getItem(TRANSCRIPT('orphan'))).toBeNull();
  });
});

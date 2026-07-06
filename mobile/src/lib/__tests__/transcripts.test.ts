import { Preferences } from '@capacitor/preferences';
import { reduceTimeline, toPersisted, type PersistedTimeline } from '@/lib/timeline';
import {
  allowTranscriptWrites,
  clearTranscript,
  discardTranscriptWrites,
  loadTranscript,
  saveTranscript,
} from '@/lib/transcripts';
import * as B from '@/test/helpers/builders';

function persisted(): PersistedTimeline {
  const state = reduceTimeline(reduceTimeline(emptyBase(), B.stamp(B.assistantMessage('hello', 'm1'), { ts: 1 })), B.historyPage([B.historyItem(1, 'user', 'old', 1)], { nextCursor: 1, hasMore: true }));
  return toPersisted({ ...state, title: 'T', cwd: 'C:\\repo', latestTurnIndex: 1 });
}

function emptyBase() {
  return {
    items: [],
    approvals: [],
    approvalErrors: {},
    elicitations: [],
    elicitationErrors: {},
    busy: false,
    busyFrom: null,
    mode: 'interactive' as const,
    cwd: null,
    title: null,
    lastHeartbeat: null,
    sessionEnded: false,
    history: [],
    historyCursor: null,
    historyHasMore: false,
    historyLoading: false,
    latestTurnIndex: null,
  };
}

describe('transcript storage', () => {
  it('save/load round-trips a persisted timeline and writes a localStorage mirror', async () => {
    const data = persisted();
    await saveTranscript('ch1', data);

    expect(await loadTranscript('ch1')).toEqual(data);
    const raw = localStorage.getItem('weft.transcript.v1.ch1');
    expect(raw).toBeTruthy();
    expect(JSON.parse(raw as string)).toMatchObject({ v: 1, data });
  });

  it('clear removes a transcript', async () => {
    await saveTranscript('ch1', persisted());
    await clearTranscript('ch1');

    expect(await loadTranscript('ch1')).toBeNull();
    expect(localStorage.getItem('weft.transcript.v1.ch1')).toBeNull();
  });

  it('returns null for wrong envelope versions', async () => {
    await Preferences.set({ key: 'weft.transcript.v1.bad', value: JSON.stringify({ v: 2, savedAt: 1, data: persisted() }) });

    await expect(loadTranscript('bad')).resolves.toBeNull();
  });

  it('treats empty channel ids as no-ops', async () => {
    await saveTranscript('', persisted());
    expect(await loadTranscript('')).toBeNull();

    await clearTranscript('');
    expect(localStorage.length).toBe(0);
  });

  it('drops transcript writes after a channel is discarded until it is allowed again', async () => {
    const data = persisted();
    discardTranscriptWrites('removed');
    await saveTranscript('removed', data);
    expect(await loadTranscript('removed')).toBeNull();

    allowTranscriptWrites('removed');
    await saveTranscript('removed', data);
    expect(await loadTranscript('removed')).toEqual(data);
  });
});

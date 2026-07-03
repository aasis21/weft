import { describe, expect, it } from 'vitest';
import * as B from '@/test/helpers/builders';
import { emptySession, type Session, type SessionMeta } from '../model';
import sessionsReducer, {
  approvalDismissed,
  coldSet,
  envelopeReceived,
  readySet,
  sessionActivated,
  sessionAdded,
  sessionReconciled,
  statusSet,
  titleSet,
} from '../sessionsSlice';
import { routeEnvelope } from '../routeEnvelope';
import { selectManagerSnapshot } from '../selectors';

function makeSession(id: string, meta: Partial<SessionMeta> = {}): Session {
  return emptySession(id, {
    channelId: `ch-${id}`,
    title: `Session ${id}`,
    cwd: null,
    kind: 'live',
    addedAt: 1,
    ...meta,
  });
}

describe('sessionsSlice', () => {
  it('dismisses approval requests through the slice API', () => {
    let state = sessionsReducer(undefined, sessionAdded(makeSession('s1')));
    const req = B.stamp(B.approvalRequest('a1', 'shell', { cmd: 'pwd' }, [{ id: 'allow', label: 'Allow' }]), { ts: 10 });

    state = sessionsReducer(state, envelopeReceived({ id: 's1', envelope: req }));
    expect(state.entities.s1?.requests.approvals).toEqual([req.msg]);

    state = sessionsReducer(state, approvalDismissed({ id: 's1', requestId: 'a1' }));
    expect(state.entities.s1?.requests.approvals).toEqual([]);
  });

  it('merges two cards that report the same durable sessionId', () => {
    const oldSession = makeSession('old', {
      channelId: 'old-channel',
      sessionId: 'sess-shared',
      title: 'Old title',
      addedAt: 10,
      scannedAt: 10,
    });
    oldSession.transcript.items.push({ kind: 'assistant', id: 'a1', text: 'kept transcript', ts: 11 });
    oldSession.unread = true;

    const newSession = makeSession('new', {
      channelId: 'new-channel',
      title: 'New title',
      addedAt: 20,
      scannedAt: 20,
    });

    let state = sessionsReducer(undefined, sessionAdded(oldSession));
    state = sessionsReducer(state, sessionAdded(newSession));
    state = sessionsReducer(state, sessionActivated('new'));
    state = sessionsReducer(state, sessionReconciled({ id: 'new', sessionId: 'sess-shared' }));

    expect(state.ids).toEqual(['new']);
    expect(state.activeId).toBe('new');
    expect(state.entities.new?.meta).toMatchObject({ channelId: 'new-channel', sessionId: 'sess-shared', addedAt: 10, scannedAt: 20 });
    expect(state.entities.new?.unread).toBe(true);
    expect(state.entities.new?.transcript.items).toMatchObject([{ id: 'a1', text: 'kept transcript' }]);
  });

  it('does not inherit a stale error onto a live keeper when merging same-sessionId cards (#185)', () => {
    const oldSession = makeSession('old', { channelId: 'old-channel', sessionId: 'sess-shared', addedAt: 10, scannedAt: 10 });
    oldSession.connection.status = 'error';
    oldSession.connection.error = 'Couldn’t reach your session — the terminal may be closed. Reconnect to try again.';

    const newSession = makeSession('new', { channelId: 'new-channel', addedAt: 20, scannedAt: 20 });
    newSession.connection.status = 'live';

    let state = sessionsReducer(undefined, sessionAdded(oldSession));
    state = sessionsReducer(state, sessionAdded(newSession));
    state = sessionsReducer(state, sessionActivated('new'));
    state = sessionsReducer(state, sessionReconciled({ id: 'new', sessionId: 'sess-shared' }));

    expect(state.ids).toEqual(['new']);
    expect(state.entities.new?.connection.status).toBe('live');
    expect(state.entities.new?.connection.error).toBeUndefined();
  });

  it('marks a session renamed via titleSet and preserves the user name across a same-sessionId merge (#37)', () => {
    // Rename the OLD card, then reconcile a freshly-scanned channel onto it: the user's chosen name
    // must survive the merge instead of reverting to the CLI title.
    const oldSession = makeSession('old', {
      channelId: 'old-channel',
      sessionId: 'sess-shared',
      title: 'Old title',
      addedAt: 10,
      scannedAt: 10,
    });
    const newSession = makeSession('new', {
      channelId: 'new-channel',
      title: 'New title',
      addedAt: 20,
      scannedAt: 20,
    });

    let state = sessionsReducer(undefined, sessionAdded(oldSession));
    state = sessionsReducer(state, titleSet({ id: 'old', title: 'My Deploy Box', renamed: true }));
    expect(state.entities.old?.meta.title).toBe('My Deploy Box');
    expect(state.entities.old?.meta.renamed).toBe(true);

    state = sessionsReducer(state, sessionAdded(newSession));
    state = sessionsReducer(state, sessionActivated('new'));
    state = sessionsReducer(state, sessionReconciled({ id: 'new', sessionId: 'sess-shared' }));

    expect(state.ids).toEqual(['new']);
    expect(state.entities.new?.meta.title).toBe('My Deploy Box');
    expect(state.entities.new?.meta.renamed).toBe(true);
  });

  it('clears the renamed flag when titleSet passes renamed:false', () => {
    let state = sessionsReducer(undefined, sessionAdded(makeSession('s1')));
    state = sessionsReducer(state, titleSet({ id: 's1', title: 'Custom', renamed: true }));
    expect(state.entities.s1?.meta.renamed).toBe(true);
    state = sessionsReducer(state, titleSet({ id: 's1', title: 'Session s1', renamed: false }));
    expect(state.entities.s1?.meta.renamed).toBe(false);
  });

  it('archives the superseded channelId into channelHistory instead of discarding it (#154)', () => {
    const oldSession = makeSession('old', {
      channelId: 'old-channel',
      sessionId: 'sess-shared',
      title: 'Old title',
      addedAt: 10,
      scannedAt: 10,
    });
    const newSession = makeSession('new', {
      channelId: 'new-channel',
      title: 'New title',
      addedAt: 20,
      scannedAt: 20,
    });

    let state = sessionsReducer(undefined, sessionAdded(oldSession));
    state = sessionsReducer(state, sessionAdded(newSession));
    state = sessionsReducer(state, sessionActivated('new'));
    state = sessionsReducer(state, sessionReconciled({ id: 'new', sessionId: 'sess-shared' }));

    const meta = state.entities.new?.meta;
    expect(meta?.channelId).toBe('new-channel');
    expect(meta?.channelHistory?.map((c) => c.channelId)).toContain('old-channel');
    // The current channel must never appear in its own history.
    expect(meta?.channelHistory?.map((c) => c.channelId)).not.toContain('new-channel');
  });

  it('projects the current ManagerSnapshot shape using channel ids at the facade boundary', () => {
    let state = sessionsReducer(undefined, readySet(true));
    state = sessionsReducer(state, sessionAdded(makeSession('one', { channelId: 'ch-one', title: 'One', cwd: 'C:\\one', addedAt: 1, scannedAt: 1 })));
    state = sessionsReducer(state, sessionAdded(makeSession('two', { channelId: 'ch-two', title: 'Two', cwd: 'C:\\two', addedAt: 2, scannedAt: 3 })));
    state = sessionsReducer(state, sessionActivated('one'));
    state = sessionsReducer(state, routeEnvelope('one', B.stamp(B.assistantDelta('hi', 'm1'), { ts: 50 })));

    const snap = selectManagerSnapshot(state);

    expect(snap.ready).toBe(true);
    expect(snap.activeId).toBe('ch-one');
    expect(snap.sessions.map((s) => s.meta.channelId)).toEqual(['ch-one', 'ch-two']);
    const active = snap.sessions.find((s) => s.meta.channelId === snap.activeId);
    expect(active).toMatchObject({
      meta: { channelId: 'ch-one', title: 'One', cwd: 'C:\\one', kind: 'live' },
      status: 'live',
      timeline: { busy: false, items: [{ kind: 'assistant', id: 'm1', text: 'hi', ts: 50 }], approvals: [], history: [] },
      events: [],
    });
  });

  it('tracks an unread count that increments off-active, resets on select, and sums on merge', () => {
    let state = sessionsReducer(undefined, sessionAdded(makeSession('one', { channelId: 'ch-one' })));
    state = sessionsReducer(state, sessionAdded(makeSession('two', { channelId: 'ch-two', sessionId: 'sess-x' })));
    state = sessionsReducer(state, sessionActivated('one'));

    // Activity on the non-active session bumps its unread count; the active one stays at 0.
    state = sessionsReducer(state, envelopeReceived({ id: 'two', envelope: B.stamp(B.assistantDelta('a', 'm1'), { ts: 10 }) }));
    state = sessionsReducer(state, envelopeReceived({ id: 'two', envelope: B.stamp(B.assistantDelta('b', 'm2'), { ts: 11 }) }));
    expect(state.entities.two?.unreadCount).toBe(2);
    expect(state.entities.two?.unread).toBe(true);

    // Activity on the active session never accrues unread.
    state = sessionsReducer(state, envelopeReceived({ id: 'one', envelope: B.stamp(B.assistantDelta('c', 'm3'), { ts: 12 }) }));
    expect(state.entities.one?.unreadCount).toBe(0);
    expect(state.entities.one?.unread).toBe(false);

    // Selecting a session clears its unread count.
    state = sessionsReducer(state, sessionActivated('two'));
    expect(state.entities.two?.unreadCount).toBe(0);
    expect(state.entities.two?.unread).toBe(false);

    // A merge sums the two counts rather than OR-ing booleans.
    state = sessionsReducer(state, sessionActivated('one'));
    state = sessionsReducer(state, envelopeReceived({ id: 'two', envelope: B.stamp(B.assistantDelta('d', 'm4'), { ts: 13 }) }));
    const dup = makeSession('dup', { channelId: 'ch-dup', sessionId: 'sess-x' });
    dup.unread = true;
    dup.unreadCount = 3;
    state = sessionsReducer(state, sessionAdded(dup));
    state = sessionsReducer(state, sessionReconciled({ id: 'dup', sessionId: 'sess-x' }));
    expect(state.entities.dup?.unreadCount).toBe(4);
  });

  it('clears the cold flag when a session goes connecting/live and sets it via coldSet', () => {
    let state = sessionsReducer(undefined, sessionAdded(makeSession('s1')));
    state = sessionsReducer(state, coldSet({ id: 's1', on: true }));
    expect(state.entities.s1?.connection.cold).toBe(true);

    // Reconnecting a cold session clears the cold flag.
    state = sessionsReducer(state, statusSet({ id: 's1', status: 'connecting' }));
    expect(state.entities.s1?.connection.cold).toBe(false);

    // Going cold again, then live, also clears it.
    state = sessionsReducer(state, coldSet({ id: 's1', on: true }));
    state = sessionsReducer(state, statusSet({ id: 's1', status: 'live' }));
    expect(state.entities.s1?.connection.cold).toBe(false);

    // But a plain idle transition leaves an existing cold flag untouched.
    state = sessionsReducer(state, coldSet({ id: 's1', on: true }));
    state = sessionsReducer(state, statusSet({ id: 's1', status: 'idle' }));
    expect(state.entities.s1?.connection.cold).toBe(true);
  });

  it('clears historyLoading when seeding a keeper timeline from a stale duplicate on merge (#132)', () => {
    const keeper = makeSession('keeper', { channelId: 'keeper-ch', sessionId: 'sess-shared' });
    keeper.history.loading = true; // left over from its own attach-time syncHistory

    const stale = makeSession('stale', { channelId: 'stale-ch', sessionId: 'sess-shared' });
    stale.transcript.items.push({ kind: 'assistant', id: 'a1', text: 'seeded', ts: 5 });
    stale.history.items.push({ role: 'assistant', text: 'seeded', ts: 5, turnIndex: 1 } as never);
    stale.history.loading = true;

    let state = sessionsReducer(undefined, sessionAdded(keeper));
    state = sessionsReducer(state, sessionAdded(stale));
    state = sessionsReducer(state, sessionReconciled({ id: 'keeper', sessionId: 'sess-shared' }));

    expect(state.ids).toEqual(['keeper']);
    expect(state.entities.keeper?.transcript.items).toMatchObject([{ id: 'a1', text: 'seeded' }]);
    expect(state.entities.keeper?.history.loading).toBe(false);
  });
});


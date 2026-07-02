import { describe, expect, it } from 'vitest';
import * as B from '@/test/helpers/builders';
import { emptySession, type Session, type SessionMeta } from '../model';
import sessionsReducer, {
  approvalDismissed,
  envelopeReceived,
  readySet,
  sessionActivated,
  sessionAdded,
  sessionReconciled,
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
});


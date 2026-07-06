import { describe, expect, it } from 'vitest';
import type { EnvelopeBase, EventEnvelope } from '@aasis21/weft-shared';
import * as B from '@/test/helpers/builders';
import { emptySession, type Session, type SessionMeta } from '../model';
import { applyEnvelope, markHistoryLoading } from '../reducers/applyEnvelope';

const at = <T extends EnvelopeBase>(msg: T, ts: number): T => B.stamp(msg, { ts });

function makeSession(id = 'id-1', meta: Partial<SessionMeta> = {}): Session {
  return emptySession(id, {
    channelId: 'ch-1',
    title: 'Session ch-1',
    cwd: null,
    kind: 'live',
    addedAt: 1,
    ...meta,
  });
}

function reduceAll(session: Session, messages: EventEnvelope[]): Session {
  for (const message of messages) applyEnvelope(session, message);
  return session;
}

describe('session applyEnvelope', () => {
  it('folds stream deltas, inline tool status, and busy activity into session aspects', () => {
    const session = makeSession();

    reduceAll(session, [
      at(B.activity(true), 10),
      at(B.assistantDelta('Hel', 'm1'), 11),
      at(B.assistantDelta('lo', 'm1'), 12),
      at(B.toolStart('t1', 'read_file', { path: 'x' }), 13),
      at(B.toolComplete('t1', 'read_file', true, 'ok'), 14),
      at(B.activity(false), 15),
    ]);

    expect(session.connection.busy).toBe(false);
    expect(session.connection.status).toBe('live');
    expect(session.transcript.items).toMatchObject([
      { kind: 'assistant', id: 'm1', text: 'Hello', ts: 12 },
      { kind: 'tool', id: 't1', name: 'read_file', status: 'success', resultPreview: 'ok', startedAt: 13, finishedAt: 14 },
    ]);
  });

  it('clears a stuck busy flag after consecutive unknown heartbeats with no stream activity', () => {
    const session = makeSession();

    reduceAll(session, [
      at(B.activity(true), 10),
      at(B.heartbeat(1, null), 20),
      at(B.heartbeat(1, null), 30),
      at(B.heartbeat(1, null), 40),
    ]);

    expect(session.connection.busy).toBe(false);
    expect(session.connection.busyFrom).toBe(40);
  });

  it('keeps busy during unknown heartbeats when stream activity is still arriving', () => {
    const session = makeSession();

    reduceAll(session, [
      at(B.activity(true), 10),
      at(B.assistantDelta('Hel', 'm1'), 15),
      at(B.heartbeat(1, null), 20),
      at(B.assistantDelta('lo', 'm1'), 25),
      at(B.heartbeat(1, null), 30),
      at(B.assistantDelta('!', 'm1'), 35),
      at(B.heartbeat(1, null), 40),
    ]);

    expect(session.connection.busy).toBe(true);
  });

  it('tracks approval requests and dismisses them via the pure helper', () => {
    const session = makeSession();
    const req = at(B.approvalRequest('a1', 'shell', { cmd: 'pwd' }, [{ id: 'allow', label: 'Allow' }]), 20);

    applyEnvelope(session, req);
    expect(session.requests.approvals).toEqual([req.msg]);

    session.requests.approvalErrors.a1 = 'old';
    applyEnvelope(session, req);
    expect(session.requests.approvals).toEqual([req.msg]);
    expect(session.requests.approvalErrors).toEqual({});
  });

  it('merges history pages ascending and updates cursor, hasMore, loading, and latestTurnIndex', () => {
    const session = makeSession();
    markHistoryLoading(session, true);

    applyEnvelope(session, at(B.historyPage([
      B.historyItem(2, 'assistant', 'two-a', 2),
      B.historyItem(1, 'user', 'one-u', 1),
    ], { nextCursor: 1, hasMore: true }), 30));

    expect(session.history.items).toEqual([
      B.historyItem(1, 'user', 'one-u', 1),
      B.historyItem(2, 'assistant', 'two-a', 2),
    ]);
    expect(session.history).toMatchObject({ cursor: 1, hasMore: true, loading: false, latestTurnIndex: 2 });
  });
});

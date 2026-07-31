import { describe, expect, it, vi } from 'vitest';
import type { EnvelopeBase, EventEnvelope } from '@aasis21/weft-shared';
import * as B from '@/test/helpers/builders';
import { emptySession, type Session, type SessionMeta } from '../model';
import { applyEnvelope, appendUser, makeUserItem, markHistoryLoading } from '../reducers/applyEnvelope';

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
  it('does not show a phone prompt twice when the laptop echoes it back (#193)', () => {
    const session = makeSession();
    appendUser(session, makeUserItem('p1', 'restart the build', 40));

    // The laptop failed to recognise its own relay and echoed it as terminal-typed.
    reduceAll(session, [at(B.userMessage('restart the build\n', 'terminal', 'u9'), 41)]);
    expect(session.transcript.items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(session.transcript.items[0]).toMatchObject({ origin: 'phone', text: 'restart the build' });

    // Voice mode prepends a directive on the way in — still the same prompt.
    appendUser(session, makeUserItem('p2', 'and deploy it', 42));
    reduceAll(session, [at(B.userMessage('[directive]\n\nand deploy it', 'terminal', 'u10'), 43)]);
    expect(session.transcript.items.filter((i) => i.kind === 'user')).toHaveLength(2);

    // Saying the same thing again is a real second message.
    reduceAll(session, [at(B.userMessage('and deploy it', 'terminal', 'u11'), 44)]);
    expect(session.transcript.items.filter((i) => i.kind === 'user')).toHaveLength(3);

    // And a laptop message that merely ENDS with an earlier prompt is its own message.
    appendUser(session, makeUserItem('p3', 'yes', 45));
    reduceAll(session, [at(B.userMessage('actually yes', 'terminal', 'u12'), 46)]);
    expect(session.transcript.items.filter((i) => i.kind === 'user')).toHaveLength(5);
    expect(session.transcript.items.at(-1)).toMatchObject({ origin: 'terminal', text: 'actually yes' });
  });

  it('does not backfill a phone prompt the laptop prefixed before sending (#193)', () => {
    const session = makeSession();
    appendUser(session, makeUserItem('p1', 'what is up', 10));

    reduceAll(session, [
      at(
        B.recentTurnsSnapshot([
          B.recentTurnItem('user', '[Voice Mode is on]\n\nwhat is up', 20, 'u1'),
          B.recentTurnItem('assistant', 'not much', 30, 'a1'),
        ]),
        40,
      ),
    ]);

    expect(session.transcript.items.filter((i) => i.kind === 'user')).toHaveLength(1);
    expect(session.transcript.items.filter((i) => i.kind === 'user' || i.kind === 'assistant').map((i) => ('text' in i ? i.text : i.kind))).toEqual([
      'what is up',
      'not much',
    ]);
  });

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

  it('stamps heartbeat liveness from the phone-domain receivedAt, not the laptop ts (cross-clock)', () => {
    const session = makeSession();
    const phoneNow = 1_000_000;
    const laptopSkew = phoneNow + 120_000; // laptop clock runs 2 min ahead

    // Heartbeat carries the laptop's ts but is stamped with the phone's receipt time at the edge.
    const beat = { ...at(B.heartbeat(1, null), laptopSkew), receivedAt: phoneNow };
    applyEnvelope(session, beat);
    expect(session.connection.lastHeartbeat).toBe(phoneNow);

    // CHANNEL_UP and STATE_SNAPSHOT liveness are likewise phone-domain.
    const up = { ...at(B.channelUp('ch-1', 'id-1', undefined, 't'), laptopSkew), receivedAt: phoneNow };
    applyEnvelope(session, up);
    expect(session.connection.lastHeartbeat).toBe(phoneNow);
  });

  it('falls back to ts for heartbeat liveness when receivedAt is absent (older/test paths)', () => {
    const session = makeSession();
    applyEnvelope(session, at(B.heartbeat(1, null), 42));
    expect(session.connection.lastHeartbeat).toBe(42);
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

describe('the agent saying what it is doing (#204)', () => {
  it('holds the latest intent and drops it the moment the turn ends', () => {
    const session = makeSession();

    reduceAll(session, [at(B.activity(true), 10), at(B.intent('reading the relay config'), 11)]);
    expect(session.connection.intent).toBe('reading the relay config');

    // A newer note simply replaces the old one -- this is a status line, not a log.
    reduceAll(session, [at(B.intent('running the mobile tests'), 12)]);
    expect(session.connection.intent).toBe('running the mobile tests');

    // The turn ends. A leftover intent under a finished answer would be a lie.
    reduceAll(session, [at(B.activity(false), 13)]);
    expect(session.connection.intent).toBeNull();
  });

  it('times thinking on the local clock and only from the leading edge', () => {
    const session = makeSession();
    const now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(now);

    // The envelope timestamp is deliberately absurd -- it stands in for a laptop whose clock is
    // hours out. It must have no influence at all on when we think thinking started.
    reduceAll(session, [at(B.activity(true), 10), at(B.intent(null, true), 999)]);
    expect(session.connection.thinkingSince).toBe(now);

    // A repeat of the same "still thinking" must not restart the counter, or the seconds would
    // reset every time any other status update happened to be re-sent.
    (Date.now as unknown as ReturnType<typeof vi.fn>).mockReturnValue(now + 5_000);
    reduceAll(session, [at(B.intent('running the mobile tests', true), 11)]);
    expect(session.connection.thinkingSince).toBe(now);
    expect(session.connection.intent).toBe('running the mobile tests');

    // Thinking stops but the turn continues: the marker clears, the note stays.
    reduceAll(session, [at(B.intent('running the mobile tests', false), 12)]);
    expect(session.connection.thinkingSince).toBeNull();
    expect(session.connection.intent).toBe('running the mobile tests');

    // And the end of the turn clears both.
    reduceAll(session, [at(B.intent(null, true), 13), at(B.activity(false), 14)]);
    expect(session.connection.thinkingSince).toBeNull();
    expect(session.connection.intent).toBeNull();

    vi.restoreAllMocks();
  });
});

import type { EnvelopeBase, EventEnvelope, PromptAttachment } from '@aasis21/helm-shared';
import {
  appendNotice,
  appendUser,
  dismissApproval,
  dismissElicitation,
  emptyTimeline,
  markHistoryLoading,
  reduceTimeline,
  restoreApproval,
  restoreElicitation,
  restoreTimeline,
  setUserFailed,
  toPersisted,
  type TimelineState,
} from '@/lib/timeline';
import * as B from '@/test/helpers/builders';

const at = <T extends EnvelopeBase>(msg: T, ts: number): T => B.stamp(msg, { ts });

function reduceAll(state: TimelineState, messages: EventEnvelope[]): TimelineState {
  return messages.reduce((next, msg) => reduceTimeline(next, msg), state);
}

describe('timeline reducer', () => {
  it('upserts assistant messages and coalesces deltas by message id', () => {
    let state = emptyTimeline();

    state = reduceTimeline(state, at(B.assistantMessage('Hello', 'm1'), 10));
    expect(state.items).toMatchObject([{ kind: 'assistant', id: 'm1', text: 'Hello', ts: 10 }]);

    state = reduceTimeline(state, at(B.assistantMessage('Replaced', 'm1'), 11));
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ kind: 'assistant', id: 'm1', text: 'Replaced', ts: 11 });

    state = reduceTimeline(state, at(B.assistantDelta(' plus', 'm1'), 12));
    state = reduceTimeline(state, at(B.assistantDelta(' tail', 'm1'), 13));
    expect(state.items[0]).toMatchObject({ kind: 'assistant', id: 'm1', text: 'Replaced plus tail', ts: 13 });

    state = reduceTimeline(state, at(B.assistantDelta('new', 'm2'), 14));
    expect(state.items[1]).toMatchObject({ kind: 'assistant', id: 'm2', text: 'new', ts: 14 });
  });

  it('tracks tool start and complete, including orphan completes', () => {
    let state = reduceTimeline(emptyTimeline(), at(B.toolStart('tc1', 'read_file', { path: 'a' }), 20));
    expect(state.items[0]).toMatchObject({
      kind: 'tool',
      id: 'tc1',
      name: 'read_file',
      args: { path: 'a' },
      status: 'running',
      startedAt: 20,
      ts: 20,
    });

    state = reduceTimeline(state, at(B.toolComplete('tc1', 'read_file', true, 'ok'), 21));
    expect(state.items[0]).toMatchObject({ status: 'success', resultPreview: 'ok', finishedAt: 21 });

    state = reduceTimeline(state, at(B.toolComplete('missing', 'write_file', false, 'nope'), 22));
    expect(state.items[1]).toMatchObject({
      kind: 'tool',
      id: 'missing',
      name: 'write_file',
      status: 'error',
      resultPreview: 'nope',
      startedAt: 22,
      finishedAt: 22,
      ts: 22,
    });
  });

  it('renders logs, activity, and user message echoes', () => {
    let state = emptyTimeline();
    state = reduceTimeline(state, at(B.logLine('warning', 'heads up'), 30));
    expect(state.items[0]).toMatchObject({ kind: 'notice', level: 'warning', text: 'heads up', ts: 30 });

    state = reduceTimeline(state, at(B.activity(true), 31));
    expect(state.busy).toBe(true);
    state = reduceTimeline(state, at(B.activity(false), 32));
    expect(state.busy).toBe(false);

    state = reduceTimeline(state, at(B.userMessage('from laptop', 'terminal', 'u1'), 33));
    state = reduceTimeline(state, at(B.userMessage('from phone', 'phone', 'u2'), 34));
    expect(state.items.slice(1)).toMatchObject([
      { kind: 'user', id: 'umsg-u1', text: 'from laptop', origin: 'terminal', ts: 33 },
      { kind: 'user', id: 'umsg-u2', text: 'from phone', origin: 'phone', ts: 34 },
    ]);
  });

  it('applies channel lifecycle, heartbeat, and mode messages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      let state: TimelineState = { ...emptyTimeline(), busy: true, title: 'old', cwd: 'C:\\old', sessionEnded: true, endedReason: 'gone' };

      state = reduceTimeline(state, at(B.channelUp('ch1', 's1', 'C:\\repo', ''), 40));
      expect(state).toMatchObject({ cwd: 'C:\\repo', title: 'old', busy: false, sessionEnded: false, endedReason: undefined, lastHeartbeat: 1_000 });

      state = reduceTimeline(state, at(B.channelUp('ch1', 's1', undefined, 'New title'), 41));
      expect(state).toMatchObject({ cwd: 'C:\\repo', title: 'New title' });

      state = reduceTimeline(state, at(B.sessionMeta('', 'D:\\work'), 42));
      expect(state).toMatchObject({ title: 'New title', cwd: 'D:\\work' });
      state = reduceTimeline(state, at(B.sessionMeta('Meta title', undefined), 43));
      expect(state).toMatchObject({ title: 'Meta title', cwd: 'D:\\work' });

      state = { ...state, busy: true };
      state = reduceTimeline(state, at(B.channelDown(undefined), 44));
      expect(state).toMatchObject({ sessionEnded: true, endedReason: 'Session ended.', busy: false });
      expect(state.items.at(-1)).toMatchObject({ kind: 'notice', id: 'end-44', level: 'warning', text: 'Session ended.', ts: 44 });

      vi.setSystemTime(2_000);
      state = { ...state, busy: true, latestTurnIndex: 5 };
      state = reduceTimeline(state, at(B.heartbeat(4, null), 45));
      expect(state).toMatchObject({ busy: true, latestTurnIndex: 5, lastHeartbeat: 2_000, sessionEnded: false });
      state = reduceTimeline(state, at(B.heartbeat(8, false), 46));
      expect(state).toMatchObject({ busy: false, latestTurnIndex: 8 });
      state = reduceTimeline(state, at(B.activity(false), 50));
      state = reduceTimeline(state, at(B.heartbeat(9, true), 49));
      expect(state.busy).toBe(false);

      state = reduceTimeline(state, at(B.modeChange('autopilot'), 47));
      expect(state.mode).toBe('autopilot');
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges backward history pages into the scrollback store above the transcript', () => {
    const older = [B.historyItem(2, 'assistant', 'two-a', 2), B.historyItem(1, 'user', 'one-u', 1)];
    let state = reduceTimeline(emptyTimeline(), at(B.historyPage(older, { nextCursor: 1, hasMore: true }), 50));
    expect(state.history).toEqual([B.historyItem(1, 'user', 'one-u', 1), B.historyItem(2, 'assistant', 'two-a', 2)]);
    expect(state).toMatchObject({ historyCursor: 1, historyHasMore: true, historyLoading: false, latestTurnIndex: 2 });

    state = reduceTimeline(state, at(B.historyPage([B.historyItem(2, 'assistant', 'two-a-updated', 20), B.historyItem(3, 'user', 'three-u', 3)], { hasMore: false }), 51));
    expect(state.history).toEqual([
      B.historyItem(1, 'user', 'one-u', 1),
      B.historyItem(2, 'assistant', 'two-a-updated', 20),
      B.historyItem(3, 'user', 'three-u', 3),
    ]);
    expect(state).toMatchObject({ historyCursor: null, historyHasMore: false, latestTurnIndex: 3 });
    // Backward pages never touch the live transcript.
    expect(state.items).toEqual([]);
  });

  it('backfills an empty transcript from a recent-turns snapshot and clears loading', () => {
    let state = markHistoryLoading(emptyTimeline(), true);
    state = reduceTimeline(
      state,
      at(
        B.recentTurnsSnapshot([
          B.recentTurnItem('user', 'hi there', 100, 'u1'),
          B.recentTurnItem('assistant', 'hello back', 200, 'a1'),
        ]),
        300,
      ),
    );
    expect(state.historyLoading).toBe(false);
    expect(state.items).toMatchObject([
      { kind: 'user', id: 'u1', text: 'hi there', ts: 100 },
      { kind: 'assistant', id: 'a1', text: 'hello back', ts: 200 },
    ]);
    // Empty transcript backfill carries no "N new while you were away" divider.
    expect(state.items.some((i) => i.kind === 'notice')).toBe(false);
  });

  it('reconnect recent-turns dedups seen turns, appends new ones, and prepends an away divider', () => {
    // Existing transcript from the live session (assistant id matches the buffer id → id-dedup).
    let state = reduceTimeline(emptyTimeline(), at(B.assistantMessage('live tail', 'a1'), 50));
    expect(state.items).toHaveLength(1);

    state = reduceTimeline(
      state,
      at(
        B.recentTurnsSnapshot([
          B.recentTurnItem('assistant', 'live tail', 40, 'a1'), // already shown (same id) → skip
          B.recentTurnItem('user', 'while away', 60, 'u2'),
          B.recentTurnItem('assistant', 'answer', 70, 'a2'),
        ]),
        80,
      ),
    );

    expect(state.items.map((i) => ('text' in i ? i.text : i.kind))).toEqual([
      'live tail',
      '1 new while you were away',
      'while away',
      'answer',
    ]);
    // The already-shown bubble keeps its original local ts (merge preserves local time).
    expect(state.items[0]).toMatchObject({ kind: 'assistant', id: 'a1', ts: 50 });
    expect(state.items[1]).toMatchObject({ kind: 'notice', level: 'info' });
  });

  it('dedups an unclipped live bubble against its clipped recent-turns copy by content prefix', () => {
    const long = 'x'.repeat(400);
    let state = reduceTimeline(emptyTimeline(), at(B.assistantMessage(long, 'live-id'), 50));
    // Buffer copy has a different id but the same 256-char content prefix → treated as a duplicate.
    state = reduceTimeline(
      state,
      at(B.recentTurnsSnapshot([B.recentTurnItem('assistant', long.slice(0, 300), 40, 'buf-id')]), 80),
    );
    expect(state.items).toHaveLength(1);
    expect(state.items[0]).toMatchObject({ id: 'live-id', ts: 50 });
  });

  it('drops DB-seeded user-only half turns and accumulates same-id assistant parts in recent turns', () => {
    let state = reduceTimeline(
      emptyTimeline(),
      at(
        B.recentTurnsSnapshot([
          B.recentTurnItem('user', 'orphan prompt', 10, 'seed-1-user'),
          B.recentTurnItem('user', 'complete prompt', 20, 'seed-2-user'),
          B.recentTurnItem('assistant', 'complete answer', 30, 'seed-2-assistant'),
          B.recentTurnItem('assistant', 'part one ', 40, 'm1'),
          B.recentTurnItem('assistant', 'part two', 50, 'm1'),
        ]),
        60,
      ),
    );

    expect(state.items.map((i) => ('text' in i ? i.text : ''))).toEqual([
      'complete prompt',
      'complete answer',
      'part one part two',
    ]);
  });

  it('applies state snapshots and pending approval/elicitation messages', () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    try {
      const approval = at(B.approvalRequest('a1', 'shell', { cmd: 'pwd' }, [{ id: 'allow', label: 'Allow' }]), 60);
      const elicitation = at(B.elicitationRequest('e1', 'Need input', 'form', { type: 'object', properties: {} }), 61);
      let state = reduceTimeline(emptyTimeline(), approval);
      state = { ...state, approvalErrors: { a1: 'old' } };
      state = reduceTimeline(state, approval);
      expect(state.approvals).toEqual([approval.msg]);
      expect(state.approvalErrors).toEqual({});

      state = reduceTimeline(state, elicitation);
      state = { ...state, elicitationErrors: { e1: 'old' } };
      state = reduceTimeline(state, elicitation);
      expect(state.elicitations).toEqual([elicitation.msg]);
      expect(state.elicitationErrors).toEqual({});

      state = reduceTimeline(state, at(B.elicitationComplete('e1'), 62));
      expect(state.elicitations).toEqual([]);

      const approval2 = at(B.approvalRequest('a2', 'edit', {}, []), 63);
      const elicitation2 = at(B.elicitationRequest('e2', 'More', 'form', { type: 'object', properties: {} }), 64);
      state = reduceTimeline(state, at(B.stateSnapshot({ busy: true, mode: 'plan', latestTurnIndex: 9, approvals: [approval.msg, approval2.msg], elicitations: [elicitation2.msg] }), 65));
      expect(state).toMatchObject({ busy: true, mode: 'plan', latestTurnIndex: 9, lastHeartbeat: 3_000, sessionEnded: false });
      expect(state.approvals.map((a) => a.requestId)).toEqual(['a1', 'a2']);
      expect(state.elicitations.map((e) => e.requestId)).toEqual(['e2']);

      state = { ...state, mode: 'autopilot', pendingMode: 'autopilot' };
      state = reduceTimeline(state, at(B.stateSnapshot({ busy: false, mode: 'plan' }), 66));
      expect(state.mode).toBe('autopilot');
      expect(state.pendingMode).toBe('autopilot');
      state = reduceTimeline(state, at(B.stateSnapshot({ busy: false, mode: 'autopilot' }), 67));
      expect(state.mode).toBe('autopilot');
      expect(state.pendingMode).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps live items at 240 and keeps the newest items', () => {
    let state = emptyTimeline();
    for (let i = 0; i < 245; i += 1) state = reduceTimeline(state, at(B.assistantMessage(`m${i}`, `m${i}`), i));

    expect(state.items).toHaveLength(240);
    expect(state.items[0]).toMatchObject({ id: 'm5', text: 'm5' });
    expect(state.items.at(-1)).toMatchObject({ id: 'm244', text: 'm244' });
  });

  it('exposes pure builders for optimistic users, notices, loading, and pending prompts', () => {
    const attachment: PromptAttachment = { data: 'abc', mimeType: 'image/png', name: 'pic.png' };
    const appended = appendUser(emptyTimeline(), 'hello', 70, [attachment]);
    expect(appended.id).toMatch(/^user-70-/);
    expect(appended.state.items[0]).toMatchObject({ kind: 'user', id: appended.id, text: 'hello', ts: 70, origin: 'phone', attachments: [attachment] });

    let state = setUserFailed(appended.state, appended.id, true);
    expect(state.items[0]).toMatchObject({ failed: true });
    state = setUserFailed(state, appended.id, false);
    expect('failed' in state.items[0]).toBe(false);

    state = appendNotice(state, 'error', 'bad', 71);
    expect(state.items.at(-1)).toMatchObject({ kind: 'notice', level: 'error', text: 'bad', ts: 71 });
    state = markHistoryLoading(state);
    expect(state.historyLoading).toBe(true);
    state = markHistoryLoading(state, false);
    expect(state.historyLoading).toBe(false);

    const approval = B.approvalRequest('a1', 'tool', {}, []).msg;
    state = restoreApproval(state, approval, 'send failed');
    state = restoreApproval(state, approval, 'still failed');
    expect(state.approvals).toEqual([approval]);
    expect(state.approvalErrors).toEqual({ a1: 'still failed' });
    state = dismissApproval(state, 'a1');
    expect(state.approvals).toEqual([]);
    expect(state.approvalErrors).toEqual({});

    const elicitation = B.elicitationRequest('e1', 'question', 'form', { type: 'object', properties: {} }).msg;
    state = restoreElicitation(state, elicitation, 'send failed');
    state = restoreElicitation(state, elicitation, 'still failed');
    expect(state.elicitations).toEqual([elicitation]);
    expect(state.elicitationErrors).toEqual({ e1: 'still failed' });
    state = dismissElicitation(state, 'e1');
    expect(state.elicitations).toEqual([]);
    expect(state.elicitationErrors).toEqual({});
  });

  it('round-trips persisted state and strips transient fields', () => {
    const attachment: PromptAttachment = { data: 'abc', mimeType: 'image/png', name: 'pic.png' };
    const approval = at(B.approvalRequest('a1', 'tool', {}, []), 80);
    const elicitation = at(B.elicitationRequest('e1', 'question', 'form', { type: 'object', properties: {} }), 81);
    let state = appendUser(emptyTimeline(), 'with image', 82, [attachment]).state;
    state = reduceAll(state, [at(B.assistantMessage('answer', 'm1'), 83), at(B.historyPage([B.historyItem(1, 'user', 'old', 1)], { nextCursor: 1, hasMore: true }), 84), approval, elicitation]);
    state = { ...state, busy: true, approvalErrors: { a1: 'err' }, elicitationErrors: { e1: 'err' }, title: 'Title', cwd: 'C:\\repo', latestTurnIndex: 3 };

    const persisted = toPersisted(state);
    expect(persisted).toEqual({
      items: [
        { ...(state.items[0] as object), attachments: undefined },
        state.items[1],
      ],
      history: [B.historyItem(1, 'user', 'old', 1)],
      historyCursor: 1,
      historyHasMore: true,
      mode: 'interactive',
      title: 'Title',
      cwd: 'C:\\repo',
      latestTurnIndex: 3,
    });
    expect('approvals' in persisted).toBe(false);
    expect('busy' in persisted).toBe(false);

    const restored = restoreTimeline(persisted);
    expect(restored).toMatchObject({
      items: persisted.items,
      history: persisted.history,
      historyCursor: 1,
      historyHasMore: true,
      mode: 'interactive',
      title: 'Title',
      cwd: 'C:\\repo',
      latestTurnIndex: 3,
      approvals: [],
      elicitations: [],
      approvalErrors: {},
      elicitationErrors: {},
      busy: false,
      sessionEnded: false,
    });
  });

  it('is pure for handled messages and ignores outbound-only kinds', () => {
    const input = reduceTimeline(emptyTimeline(), at(B.assistantMessage('first', 'm1'), 90));
    const snapshot = structuredClone(input);
    const output = reduceTimeline(input, at(B.assistantDelta(' second', 'm1'), 91));

    expect(input).toEqual(snapshot);
    expect(output).not.toBe(input);
    expect(output.items[0]).toMatchObject({ text: 'first second' });

    const ignoredKinds = [
      B.prompt('hi'),
      B.approvalDecision('a1', 'allow'),
      B.elicitationResponse('e1', 'accept', { value: 'x' }),
      B.interrupt(),
      B.stateRequest(),
    ];
    for (const msg of ignoredKinds) expect(reduceTimeline(input, at(msg, 92) as EventEnvelope)).toBe(input);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  terminalState, terminalOutput, terminalSnapshot, terminalRequest,
  type TerminalStateMsg, type TerminalRequestMsg,
} from '@aasis21/weft-shared';
import { makeManager } from '@/test/helpers/makeManager';
import { registry } from '@/test/helpers/fakeWeftClient';
import { projectList } from '@/test/helpers/builders';
import { saveEventLog, toDebugEvent } from '@/lib/eventLog';
import { MAX_TERMINAL_SNAPSHOT_BYTES, terminalDimensions } from '@/session/runtime/terminalController';
import { App } from '@capacitor/app';

const qr = JSON.stringify({
  v: 1, channelId: 'terminal-device', pub: 'listener-public', kind: 'listener',
  transport: { kind: 'devtunnel', url: 'wss://relay.example.ms' },
});
const live: TerminalStateMsg = {
  requestId: null, terminalId: 'shell-1', status: 'open', shell: 'powershell',
  cwd: 'C:\\work', cols: 80, rows: 24, owner: 'phone', nextInputSeq: 1, error: null,
};

describe('device terminal runtime', () => {
  let h: ReturnType<typeof makeManager>;
  beforeEach(async () => {
    vi.mocked(App.addListener).mockResolvedValue({ remove: vi.fn() });
    vi.useFakeTimers();
    h = makeManager();
    await h.init();
    await h.manager.addByQr(qr);
    await h.flush();
  });
  afterEach(() => { h.dispose(); vi.useRealTimers(); });
  const client = () => registry.get('terminal-device')!;
  const terminal = () => h.manager.terminal('terminal-device');
  const requests = () => client().sent.filter((m) => m.eventSubtype === 'terminal_request')
    .map((m) => m.msg as TerminalRequestMsg);
  const ack = (state: Partial<TerminalStateMsg> = {}) => client().emit(terminalState({
    ...live, requestId: requests().at(-1)!.requestId, ...state,
  }));
  const snapshot = (seq = 0, data = 'screen') => client().emit(terminalSnapshot({
    terminalId: 'shell-1', seq, data, cols: 80, rows: 24, truncated: false,
  }));
  const open = () => {
    client().emit(projectList([], 'Laptop', null, ['device-terminal-v1']));
    terminal().enter();
    terminal().open();
    ack();
    snapshot();
  };

  it('gates authorization, dedupes open, and detaches without ending the shell', () => {
    terminal().enter();
    terminal().open();
    expect(requests()).toHaveLength(0);
    expect(terminal().getSnapshot().error).toContain('terminal.enabled');
    client().emit(projectList([], 'Laptop', null, ['device-terminal-v1']));
    terminal().open();
    terminal().open();
    expect(requests().map((r) => r.action)).toEqual(['open']);
    ack();
    snapshot();
    terminal().leave();
    expect(requests().at(-1)?.action).toBe('detach');
    terminal().enter();
    expect(requests().at(-1)).toMatchObject({ action: 'attach', terminalId: 'shell-1' });
    expect(requests().filter((r) => r.action === 'close')).toHaveLength(0);
  });

  it('orders snapshots and chunks, ignores duplicates and stale generations, and repairs gaps', () => {
    open();
    client().emit(terminalOutput({ terminalId: 'shell-1', seq: 1, data: 'one' }));
    client().emit(terminalOutput({ terminalId: 'shell-1', seq: 1, data: 'duplicate' }));
    client().emit(terminalOutput({ terminalId: 'old-shell', seq: 2, data: 'old' }));
    client().emit(terminalOutput({ terminalId: 'shell-1', seq: 3, data: 'three' }));
    expect(requests().at(-1)?.action).toBe('attach');
    ack();
    snapshot(2, 'replacement');
    expect(terminal().getSnapshot().output.map((o) => o.data)).toEqual(['three']);
    snapshot(1, 'older');
    expect(terminal().getSnapshot().snapshot?.data).toBe('replacement');
    expect(requests().filter((r) => r.action === 'input')).toHaveLength(0);
  });

  it('does not infer current directory or command readiness from output resembling a shell prompt', () => {
    open();
    client().emit(terminalOutput({ terminalId: 'shell-1', seq: 1, data: 'PS C:\\somewhere-else> ' }));
    expect(terminal().getSnapshot().state?.cwd).toBe('C:\\work');
    client().emit(terminalOutput({ terminalId: 'shell-1', seq: 2, data: 'Program still running...\r\n' }));
    expect(terminal().input('another command\r')).toBe(true);
  });

  it('bounds live buffers and dimensions and indicates truncated snapshots', () => {
    open();
    for (let seq = 1; seq < 10; seq++) {
      client().emit(terminalOutput({ terminalId: 'shell-1', seq, data: 'a'.repeat(64 * 1024) }));
    }
    expect(requests().at(-1)?.action).toBe('attach');
    expect(terminal().getSnapshot().output.reduce((size, o) => size + o.data.length, 0)).toBeLessThanOrEqual(512 * 1024);
    client().emit(terminalSnapshot({ terminalId: 'shell-1', seq: 9, data: 'bounded', cols: 80, rows: 24, truncated: true }));
    expect(terminal().getSnapshot().snapshot?.truncated).toBe(true);
    expect(terminalDimensions(10000, -1)).toEqual({ cols: 240, rows: 5 });
  });

  it('handles an initial snapshot and output racing ahead of the correlated open state', () => {
    client().emit(projectList([], 'Laptop', null, ['device-terminal-v1']));
    terminal().enter();
    terminal().open();
    snapshot(4, 'early snapshot');
    client().emit(terminalOutput({ terminalId: 'shell-1', seq: 5, data: 'early output' }));
    expect(terminal().canInput()).toBe(false);
    ack();
    expect(terminal().getSnapshot().snapshot?.data).toBe('early snapshot');
    expect(terminal().getSnapshot().output.map((o) => o.data)).toEqual(['early output']);
    expect(terminal().canInput()).toBe(true);
  });

  it('serializes direct input with correlated acknowledgements and never replays on reconnect', () => {
    open();
    terminal().input('one\r');
    terminal().input('two\r');
    expect(requests().filter((r) => r.action === 'input')).toHaveLength(1);
    ack({ nextInputSeq: 2 });
    expect(requests().at(-1)).toMatchObject({ action: 'input', data: 'two\r', inputSeq: 2 });
    client().setStatus('disconnected');
    client().setStatus('connected');
    expect(requests().at(-1)?.action).toBe('attach');
    ack({ nextInputSeq: 3 });
    snapshot(2);
    expect(terminal().getSnapshot().uncertainInput).toBe(false);
    expect(requests().filter((r) => r.action === 'input')).toHaveLength(2);
    expect(terminal().input('three\r')).toBe(true);
    expect(requests().at(-1)?.inputSeq).toBe(3);
  });

  it('surfaces unacknowledged input without retrying and rejects non-owner input', async () => {
    open();
    terminal().input('possibly-ran\r');
    await vi.advanceTimersByTimeAsync(10_001);
    expect(terminal().getSnapshot().uncertainInput).toBe(true);
    expect(terminal().getSnapshot().error).toContain('may have run');
    expect(terminal().input('retry')).toBe(false);
    terminal().reattach();
    ack({ nextInputSeq: 2, owner: 'laptop' });
    snapshot(1);
    expect(terminal().input('typing')).toBe(false);
    terminal().claim();
    ack({ nextInputSeq: 2 });
    expect(terminal().canInput()).toBe(true);
    expect(requests().filter((r) => r.action === 'input')).toHaveLength(1);
  });

  it('waits for attach ownership acknowledgement even if its snapshot arrives first', () => {
    open();
    terminal().reattach();
    snapshot(1);
    expect(terminal().canInput()).toBe(false);
    ack({ owner: 'laptop' });
    expect(terminal().canInput()).toBe(false);
  });

  it('drops unsent typing on resync and ignores a late acknowledgement from the prior input', () => {
    open();
    terminal().input('old');
    const oldRequestId = requests().at(-1)!.requestId;
    terminal().input('unsent');
    terminal().reattach();
    ack({ nextInputSeq: 2 });
    snapshot(1);
    terminal().input('new');
    client().emit(terminalState({ ...live, requestId: oldRequestId, nextInputSeq: 2 }));
    expect(terminal().getSnapshot().pendingInput).toBe(true);
    expect(requests().filter((request) => request.action === 'input').map((request) => request.data))
      .toEqual(['old', 'new']);
  });

  it('natural exit is terminal and reconnect never creates or reexecutes a shell', () => {
    open();
    client().emit(terminalState({ ...live, status: 'closed', owner: null }));
    client().setStatus('disconnected');
    client().setStatus('connected');
    terminal().enter();
    expect(requests().map((r) => r.action)).toEqual(['open']);
    terminal().open();
    expect(requests().map((r) => r.action)).toEqual(['open', 'open']);
    ack({ terminalId: 'shell-2' });
    client().emit(terminalState({ ...live, status: 'closed' }));
    expect(terminal().getSnapshot().state?.terminalId).toBe('shell-2');
  });

  it('accepts a correlated no-terminal error after Station restarts, without opening automatically', () => {
    open();
    terminal().reattach();
    ack({ terminalId: null, status: 'error', error: 'The terminal has ended. Open a new terminal.' });
    expect(terminal().getSnapshot().state?.terminalId).toBeNull();
    expect(terminal().getSnapshot().error).toContain('ended');
    expect(requests().filter((r) => r.action === 'open')).toHaveLength(1);
    terminal().open();
    expect(requests().filter((r) => r.action === 'open')).toHaveLength(2);
  });

  it('bounds the escaped snapshot payload rather than just raw terminal text', () => {
    open();
    snapshot(1, '\\'.repeat(MAX_TERMINAL_SNAPSHOT_BYTES / 2));
    expect(terminal().getSnapshot().snapshot?.data).toBe('screen');
    expect(terminal().getSnapshot().error).toContain('128 KiB');
  });

  it.each(['correlated', 'unsolicited'])('preserves a %s screen-too-large error instead of later showing a reconnect timeout', async (kind) => {
    open();
    terminal().reattach();
    const error = 'The current terminal screen cannot fit in the relay-safe snapshot. Reduce the laptop terminal size.';
    if (kind === 'unsolicited') {
      ack();
      client().emit(terminalState({ ...live, requestId: null, status: 'error', error }));
    } else {
      ack({ status: 'error', error });
    }
    await vi.advanceTimersByTimeAsync(11_000);
    expect(terminal().getSnapshot().error).toContain('current terminal screen cannot fit');
    expect(terminal().getSnapshot().syncing).toBe(false);
    expect(terminal().input('must not retry\r')).toBe(false);
    expect(requests().filter((request) => request.action === 'input')).toHaveLength(0);
  });

  it('lets the controller shrink an oversized screen and reattach without reopening or repeating input', () => {
    open();
    client().emit(terminalState({ ...live, status: 'error', error: 'Current screen exceeds the snapshot limit.' }));
    expect(terminal().canInput()).toBe(false);
    expect(terminal().canResize()).toBe(true);
    terminal().resize(40, 15);
    expect(requests().at(-1)).toMatchObject({ action: 'resize', terminalId: 'shell-1', cols: 40, rows: 15 });
    ack({ cols: 40, rows: 15 });
    expect(requests().at(-1)).toMatchObject({ action: 'attach', terminalId: 'shell-1' });
    ack({ cols: 40, rows: 15 });
    client().emit(terminalSnapshot({ terminalId: 'shell-1', seq: 2, data: 'recovered', cols: 40, rows: 15, truncated: true }));
    expect(terminal().canInput()).toBe(true);
    expect(requests().filter((request) => request.action === 'open')).toHaveLength(1);
    expect(requests().filter((request) => request.action === 'input')).toHaveLength(0);
  });

  it('ignores unsolicited snapshot errors from a stale terminal generation', () => {
    open();
    terminal().reattach();
    client().emit(terminalState({ ...live, terminalId: 'old-generation', status: 'error', error: 'Old screen failure.' }));
    expect(terminal().getSnapshot().syncing).toBe(true);
    expect(terminal().getSnapshot().error).not.toBe('Old screen failure.');
    ack();
    snapshot(1);
    expect(terminal().canInput()).toBe(true);
  });

  it('requires a fresh snapshot after claiming a terminal whose last snapshot failed', () => {
    open();
    client().emit(terminalState({ ...live, owner: 'laptop', status: 'error', error: 'Snapshot failed.' }));
    expect(terminal().canResize()).toBe(false);
    terminal().claim();
    ack({ owner: 'phone' });
    expect(requests().at(-1)).toMatchObject({ action: 'attach', terminalId: 'shell-1' });
    expect(terminal().canInput()).toBe(false);
    ack();
    snapshot(1);
    expect(terminal().canInput()).toBe(true);
    expect(requests().filter((request) => request.action === 'input')).toHaveLength(0);
  });

  it.each([
    { error: { text: 'INVALID_PRIVATE_ERROR' } },
    { shell: 42 },
    { cwd: undefined },
    { requestId: '' },
    { terminalId: '' },
    { nextInputSeq: 1.5 },
    { cols: 241 },
    { rows: -1 },
    { owner: 'unknown' },
    { status: 'running' },
    { error: 'x'.repeat(8193) },
  ])('rejects malformed terminal state without admitting it to private state or diagnostics (case %#)', (patch) => {
    open();
    const malformed = { ...terminalState(live), msg: { ...live, ...patch } };
    // @ts-expect-error Deliberately malformed wire data must be rejected at runtime.
    client().emit(malformed);
    expect(terminal().getSnapshot().state).toEqual({ ...live, requestId: requests()[0]!.requestId });
    expect(terminal().getSnapshot().error).toContain('Invalid or oversized');
    expect(JSON.stringify(h.snapshot())).not.toContain('INVALID_PRIVATE_ERROR');
  });

  it('rejects oversized output and malformed snapshot fields, and discards unknown payload fields', () => {
    open();
    client().emit(terminalOutput({ terminalId: 'shell-1', seq: 1, data: 'x'.repeat(512 * 1024 + 1) }));
    expect(terminal().getSnapshot().output).toHaveLength(0);
    const malformedSnapshot = {
      ...terminalSnapshot({ terminalId: 'shell-1', seq: 2, data: 'wrong', cols: 80, rows: 24, truncated: false }),
      msg: { terminalId: 'shell-1', seq: 2, data: 'wrong', cols: 80, rows: 24, truncated: 'yes' },
    };
    // @ts-expect-error The runtime, not the factory, must reject a non-boolean flag.
    client().emit(malformedSnapshot);
    expect(terminal().getSnapshot().snapshot?.data).toBe('screen');
    const extended = { ...terminalState(live), msg: { ...live, extra: 'DO_NOT_RETAIN_EXTRA' } };
    client().emit(extended);
    expect(JSON.stringify(terminal().getSnapshot())).not.toContain('DO_NOT_RETAIN_EXTRA');
  });

  it('excludes private terminal input/output/snapshots from raw events and durable diagnostics', async () => {
    open();
    terminal().input('PRIVATE_INPUT_SENTINEL\r');
    client().emit(terminalOutput({ terminalId: 'shell-1', seq: 1, data: 'PRIVATE_OUTPUT_SENTINEL' }));
    snapshot(2, 'PRIVATE_SNAPSHOT_SENTINEL');
    client().emit(terminalRequest({ requestId: 'echo', action: 'input', data: 'PRIVATE_REQUEST_SENTINEL', inputSeq: 1 }));
    await vi.advanceTimersByTimeAsync(1000);
    expect(JSON.stringify(h.snapshot())).not.toContain('PRIVATE_');
    expect(JSON.stringify(h.snapshot().devices[0]!.events)).not.toContain('terminal_');
    const privateEvent = terminalOutput({ terminalId: 'shell-1', seq: 4, data: 'PRIVATE_DIAGNOSTIC_SENTINEL' });
    expect(JSON.stringify(toDebugEvent('in', privateEvent, 1, 'Laptop'))).not.toContain('PRIVATE_');
    await saveEventLog('terminal-device', [{
      id: '1', ts: Date.now(), dir: 'in', eventType: 'control', eventSubtype: 'terminal_output',
      senderName: 'Laptop', msg: privateEvent.msg,
    }]);
    expect(JSON.stringify(localStorage)).not.toContain('PRIVATE_');
  });
});

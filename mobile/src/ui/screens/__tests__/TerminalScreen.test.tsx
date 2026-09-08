import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { terminalState, terminalSnapshot, terminalOutput, type EventEnvelope, type TerminalRequestMsg } from '@aasis21/weft-shared';
import { TerminalController } from '@/session/runtime/terminalController';
import type { ListenerDeviceState } from '@/session/model';

const renderer = vi.hoisted(() => ({
  data: null as ((data: string) => void) | null,
  scroll: null as (() => void) | null,
  clipboard: vi.fn(),
  write: vi.fn(),
  reset: vi.fn(),
  resize: vi.fn(),
  focus: vi.fn(),
  open: vi.fn(),
  deferWrites: false,
  pendingWrites: [] as (() => void)[],
  text: '',
  modes: { applicationCursorKeysMode: false },
  scrollToLine: vi.fn(),
  beforeFlush: null as (() => void) | null,
  options: { disableStdin: true, theme: {} },
  active: { viewportY: 0, baseY: 0 },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    modes = renderer.modes;
    options = renderer.options;
    buffer = { active: renderer.active };
    parser = { registerOscHandler: renderer.clipboard.mockReturnValue({ dispose: vi.fn() }) };
    loadAddon = vi.fn();
    open = renderer.open;
    onData = (fn: (data: string) => void) => { renderer.data = fn; return { dispose: vi.fn() }; };
    onScroll = (fn: () => void) => { renderer.scroll = fn; return { dispose: vi.fn() }; };
    reset = () => { renderer.reset(); renderer.text = ''; };
    resize = (cols: number, rows: number) => {
      renderer.resize(cols, rows);
      this.cols = cols;
      this.rows = rows;
    };
    write = (data: string, callback?: () => void) => {
      renderer.write(data);
      const flush = () => {
        renderer.text += data;
        if (data.includes('QUERY')) renderer.data?.('\x1b[0n');
        if (data === 'live-scroll') renderer.beforeFlush?.();
        callback?.();
      };
      if (renderer.deferWrites) renderer.pendingWrites.push(flush);
      else flush();
    };
    scrollToBottom = vi.fn();
    scrollToLine = renderer.scrollToLine;
    focus = renderer.focus;
    dispose = vi.fn();
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { proposeDimensions = () => ({ cols: 42, rows: 18 }); } }));
import { TerminalScreen } from '../TerminalScreen';

const device: ListenerDeviceState = {
  channelId: 'device', pub: 'pub', publicKeyB64: 'phone', privateKeyJwk: {},
  transport: { kind: 'local' }, name: 'Laptop', savedAt: 0, isDefault: true,
  projects: [], projectsLoading: false, connected: true, events: [], capabilities: ['device-terminal-v1'],
};
let controller: TerminalController;
beforeEach(() => {
  renderer.active.viewportY = renderer.active.baseY = 0;
  renderer.beforeFlush = null;
  renderer.deferWrites = false;
  renderer.pendingWrites = [];
  renderer.text = '';
  renderer.modes.applicationCursorKeysMode = false;
  renderer.reset.mockClear();
  renderer.resize.mockClear();
  renderer.write.mockClear();
  renderer.focus.mockClear();
  renderer.open.mockReset();
  renderer.scrollToLine.mockClear();
});
afterEach(() => { controller?.dispose(); vi.useRealTimers(); vi.unstubAllGlobals(); });

function setup(owner: 'phone' | 'laptop' = 'phone', deviceOverrides: Partial<ListenerDeviceState> = {}) {
  const sent: EventEnvelope[] = [];
  const send = vi.fn(async (message: EventEnvelope) => { sent.push(message); });
  controller = new TerminalController({
    send,
    capabilities: () => ['device-terminal-v1'],
  });
  controller.setConnected(true);
  controller.enter();
  controller.open();
  const requests = () => sent.map((message) => message.msg as TerminalRequestMsg);
  const state = {
    terminalId: 'shell', status: 'open' as const, shell: 'powershell', cwd: 'C:\\project',
    cols: 80, rows: 24, owner, nextInputSeq: 1, error: null,
  };
  controller.receive(terminalState({ ...state, requestId: requests().at(-1)!.requestId }));
  controller.receive(terminalSnapshot({ terminalId: 'shell', seq: 0, data: 'QUERY', cols: 80, rows: 24, truncated: false }));
  const result = render(<TerminalScreen device={{ ...device, ...deviceOverrides }} controller={controller} onBack={vi.fn()} onReconnect={vi.fn()} />);
  const acknowledge = (nextInputSeq: number) => act(() => controller.receive(terminalState({
    ...state, requestId: requests().at(-1)!.requestId, nextInputSeq,
  })));
  return { ...result, requests, acknowledge, send };
}

describe('TerminalScreen', () => {
  it('serializes snapshot replacement, resizing and output while coalescing pending views', () => {
    renderer.deferWrites = true;
    const h = setup();
    const snapshot = (seq: number, data: string) => act(() => controller.receive(terminalSnapshot({
      terminalId: 'shell', seq, data, cols: 80, rows: 24, truncated: false,
    })));
    snapshot(1, 'FIRST SNAPSHOT QUERY');
    snapshot(2, 'SECOND SNAPSHOT QUERY');
    act(() => controller.receive(terminalOutput({ terminalId: 'shell', seq: 3, data: '-LIVE' })));
    act(() => controller.receive(terminalState({
      ...controller.getSnapshot().state!, requestId: null, cols: 100, rows: 30,
    })));
    expect(renderer.reset).toHaveBeenCalledTimes(1);
    expect(renderer.resize).not.toHaveBeenCalledWith(100, 30);
    act(() => renderer.pendingWrites.shift()!());
    expect(renderer.reset).toHaveBeenCalledTimes(2);
    expect(renderer.text).toBe('');
    expect(renderer.resize).not.toHaveBeenCalledWith(100, 30);
    act(() => renderer.pendingWrites.shift()!());
    expect(renderer.resize).toHaveBeenLastCalledWith(100, 30);
    expect(h.requests().filter((r) => r.action === 'input')).toHaveLength(0);
    act(() => renderer.pendingWrites.shift()!());
    expect(renderer.text).toBe('SECOND SNAPSHOT QUERY-LIVE');
    expect(renderer.write).not.toHaveBeenCalledWith('FIRST SNAPSHOT QUERY');
    expect(renderer.pendingWrites).toHaveLength(0);
  });

  it('retains a queued snapshot and output on error without restoring input readiness', () => {
    renderer.deferWrites = true;
    setup();
    act(() => controller.receive(terminalSnapshot({
      terminalId: 'shell', seq: 1, data: 'SECOND SNAPSHOT QUERY', cols: 80, rows: 24, truncated: false,
    })));
    act(() => controller.receive(terminalOutput({ terminalId: 'shell', seq: 2, data: '-LIVE' })));
    act(() => controller.receive(terminalState({
      ...controller.getSnapshot().state!, requestId: null, status: 'error', error: 'Snapshot unavailable.',
    })));
    expect(controller.getSnapshot().snapshot).toBeNull();
    act(() => renderer.pendingWrites.shift()!());
    act(() => renderer.pendingWrites.shift()!());
    act(() => renderer.pendingWrites.shift()!());
    expect(renderer.text).toBe('SECOND SNAPSHOT QUERY-LIVE');
    expect(controller.canInput()).toBe(false);
    expect(screen.getByRole('button', { name: 'Keyboard' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Snapshot unavailable.');
  });

  it('ignores pending renderer callbacks after unmount', () => {
    renderer.deferWrites = true;
    const h = setup();
    act(() => controller.receive(terminalSnapshot({
      terminalId: 'shell', seq: 1, data: 'LATER', cols: 100, rows: 30, truncated: false,
    })));
    h.unmount();
    act(() => renderer.pendingWrites.shift()!());
    expect(renderer.reset).toHaveBeenCalledTimes(1);
    expect(renderer.resize).not.toHaveBeenCalledWith(100, 30);
    expect(renderer.pendingWrites).toHaveLength(0);
  });

  it('sends toolbar arrows in the current terminal cursor mode', () => {
    const h = setup();
    const arrows = [['Up', 'A'], ['Down', 'B'], ['Left', 'D'], ['Right', 'C']] as const;
    let nextInputSeq = 1;
    for (const application of [false, true, false]) {
      renderer.modes.applicationCursorKeysMode = application;
      for (const [label, code] of arrows) {
        fireEvent.click(screen.getByRole('button', { name: label }));
        expect(h.requests().at(-1)).toMatchObject({
          action: 'input', data: `${application ? '\x1bO' : '\x1b['}${code}`,
        });
        h.acknowledge(++nextInputSeq);
      }
    }
  });

  it('reopens using Station default selection rather than the last Copilot project', () => {
    const h = setup('phone', { lastProjectName: 'nondefault-project' });
    act(() => controller.receive(terminalState({
      ...controller.getSnapshot().state!, requestId: null, status: 'closed', owner: null,
    })));
    fireEvent.click(screen.getByRole('button', { name: 'Open new terminal' }));
    expect(h.requests().at(-1)?.action).toBe('open');
    expect(h.requests().at(-1)?.projectName).toBeUndefined();
  });

  it('keeps optional details and editor collapsed, and submits multiline drafts only on Run', () => {
    const h = setup();
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
    expect(screen.queryByText('Started in: C:\\project')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Previous command' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Started in: C:\\project')).toHaveAttribute('title', 'Initial workspace: C:\\project');
    fireEvent.click(screen.getByRole('button', { name: 'Write / paste' }));
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'first\nsecond' } });
    expect(h.requests().filter((r) => r.action === 'input')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(h.requests().at(-1)).toMatchObject({ action: 'input', data: 'first\rsecond\r', inputSeq: 1 });
    expect(screen.getByLabelText('Command')).toHaveValue('');
    h.acknowledge(2);
    expect(JSON.stringify(localStorage)).not.toContain('first');
  });

  it('keeps a draft across editor toggles without submitting or focusing the terminal automatically', () => {
    const h = setup();
    expect(renderer.focus).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Write / paste' }));
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'unsent draft' } });
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard' }));
    expect(renderer.focus).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Write / paste' }));
    expect(screen.getByLabelText('Command')).toHaveValue('unsent draft');
    expect(h.requests().filter((r) => r.action === 'input')).toHaveLength(0);
  });

  it('routes terminal clipboard paste to the draft without executing any input', () => {
    const h = setup();
    fireEvent.paste(h.container.querySelector('.terminal-host')!, {
      clipboardData: { getData: () => 'first\nsecond\n' },
    });
    expect(screen.getByLabelText('Command')).toHaveValue('first\nsecond\n');
    expect(h.requests().filter((r) => r.action === 'input')).toHaveLength(0);
  });

  it('fits the shared grid only while the phone owns connected input', () => {
    vi.useFakeTimers();
    const h = setup();
    act(() => vi.advanceTimersByTime(20));
    expect(h.requests().at(-1)).toMatchObject({ action: 'resize', cols: 42, rows: 18 });
    act(() => controller.receive(terminalState({
      ...controller.getSnapshot().state!, requestId: h.requests().at(-1)!.requestId, cols: 42, rows: 18,
    })));
    act(() => vi.advanceTimersByTime(20));
    expect(h.requests().filter((r) => r.action === 'resize')).toHaveLength(1);
    act(() => controller.receive(terminalState({
      ...controller.getSnapshot().state!, requestId: null, owner: 'laptop', cols: 80, rows: 24,
    })));
    act(() => vi.advanceTimersByTime(20));
    expect(renderer.options.disableStdin).toBe(true);
    expect(h.requests().filter((r) => r.action === 'resize')).toHaveLength(1);
    h.unmount();
  });

  it('follows the visual viewport around the keyboard without interfering with pinch zoom', () => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    const remove = vi.spyOn(viewport, 'removeEventListener');
    vi.stubGlobal('visualViewport', viewport);
    const h = setup();
    const root = screen.getByRole('main', { name: 'Shared terminal' });
    expect(root.style.getPropertyValue('--terminal-height')).toBe('844px');
    viewport.height = 420;
    viewport.offsetTop = 12;
    act(() => viewport.dispatchEvent(new Event('resize')));
    expect(root.style.getPropertyValue('--terminal-height')).toBe('420px');
    expect(root.style.getPropertyValue('--terminal-top')).toBe('12px');
    viewport.scale = 2;
    viewport.height = 210;
    act(() => viewport.dispatchEvent(new Event('resize')));
    expect(root.style.getPropertyValue('--terminal-height')).toBe('420px');
    h.unmount();
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });

  it('does not start an automatic retry loop after a resize transport failure', async () => {
    vi.useFakeTimers();
    const h = setup();
    h.send.mockRejectedValueOnce(new Error('Connection failed'));
    await act(async () => { await vi.advanceTimersByTimeAsync(100); });
    expect(screen.getByRole('alert')).toBeVisible();
    expect(h.send.mock.calls.filter(([message]) => (message.msg as TerminalRequestMsg).action === 'resize'))
      .toHaveLength(1);
    h.unmount();
  });

  it('leaves the failure visible instead of trying to fit a renderer that could not open', () => {
    vi.useFakeTimers();
    renderer.open.mockImplementationOnce(() => { throw new Error('Renderer unavailable'); });
    const h = setup();
    act(() => vi.advanceTimersByTime(20));
    expect(screen.getByRole('alert')).toHaveTextContent('renderer could not start');
    expect(screen.getByRole('button', { name: 'Keyboard' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Fit to phone' })).toBeDisabled();
    expect(h.requests().filter((r) => r.action === 'resize')).toHaveLength(0);
    h.unmount();
  });

  it('blocks snapshot-generated responses and clipboard escapes, and supports explicit interactive input', () => {
    const h = setup();
    expect(h.requests().filter((r) => r.action === 'input')).toHaveLength(0);
    expect(renderer.clipboard).toHaveBeenCalledWith(52, expect.any(Function));
    const osc = renderer.clipboard.mock.calls.at(-1)![1] as () => boolean;
    expect(osc()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard' }));
    expect(renderer.options.disableStdin).toBe(false);
    act(() => renderer.data?.('q'));
    expect(h.requests().at(-1)).toMatchObject({ action: 'input', data: 'q' });
    h.acknowledge(2);
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }));
    expect(h.requests().at(-1)).toMatchObject({ action: 'input', data: '\x03' });
  });

  it('shows ownership and never emits terminal-generated responses as a spectator', () => {
    const h = setup('laptop');
    expect(screen.getByRole('button', { name: 'Keyboard' })).toBeDisabled();
    act(() => renderer.data?.('\x1b[0n'));
    expect(h.requests().filter((r) => r.action === 'input')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Take control' }));
    expect(h.requests().at(-1)?.action).toBe('claim');
  });

  it('requires close confirmation and detaches when leaving', () => {
    const h = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.getByRole('dialog', { name: 'Close terminal?' })).toBeVisible();
    expect(h.requests().filter((r) => r.action === 'close')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }));
    expect(h.requests().at(-1)?.action).toBe('close');
    h.unmount();
    expect(h.requests().at(-1)?.action).toBe('detach');
  });

  it('anchors a stationary reader without undoing a user scroll during an async write', () => {
    const h = setup();
    renderer.active.viewportY = 10;
    renderer.active.baseY = 20;
    act(() => controller.receive(terminalOutput({ terminalId: 'shell', seq: 1, data: 'live' })));
    expect(renderer.scrollToLine).toHaveBeenLastCalledWith(10);
    renderer.scrollToLine.mockClear();
    renderer.beforeFlush = () => {
      h.container.querySelector('.terminal-host')!.dispatchEvent(new WheelEvent('wheel'));
      renderer.active.viewportY = 5;
    };
    act(() => controller.receive(terminalOutput({ terminalId: 'shell', seq: 2, data: 'live-scroll' })));
    expect(renderer.scrollToLine).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Return to latest output' })).toBeVisible();
  });

  it('surfaces current-generation errors and leaves resize and close available to the controller', () => {
    const h = setup();
    act(() => controller.receive(terminalState({
      ...controller.getSnapshot().state!, requestId: null, status: 'error',
      error: 'Current screen exceeds the snapshot limit.',
    })));
    expect(screen.getByRole('alert')).toHaveTextContent('Current screen exceeds');
    expect(screen.getByRole('status')).toHaveTextContent('Terminal error');
    expect(screen.getByRole('button', { name: 'Close' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Fit to phone' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to phone' }));
    expect(h.requests().at(-1)).toMatchObject({ action: 'resize', cols: 42, rows: 18 });
  });
});

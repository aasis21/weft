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
  scrollToLine: vi.fn(),
  beforeFlush: null as (() => void) | null,
  options: { disableStdin: true, theme: {} },
  active: { viewportY: 0, baseY: 0 },
}));
vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options = renderer.options;
    buffer = { active: renderer.active };
    parser = { registerOscHandler: renderer.clipboard.mockReturnValue({ dispose: vi.fn() }) };
    loadAddon = vi.fn();
    open = vi.fn();
    onData = (fn: (data: string) => void) => { renderer.data = fn; return { dispose: vi.fn() }; };
    onScroll = (fn: () => void) => { renderer.scroll = fn; return { dispose: vi.fn() }; };
    reset = vi.fn();
    resize = vi.fn();
    write = (data: string, callback?: () => void) => {
      renderer.write(data);
      if (data.includes('QUERY')) renderer.data?.('\x1b[0n');
      if (data === 'live-scroll') renderer.beforeFlush?.();
      callback?.();
    };
    scrollToBottom = vi.fn();
    scrollToLine = renderer.scrollToLine;
    focus = vi.fn();
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
});
afterEach(() => controller?.dispose());

function setup(owner: 'phone' | 'laptop' = 'phone') {
  const sent: EventEnvelope[] = [];
  controller = new TerminalController({
    send: async (message) => { sent.push(message); },
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
  const result = render(<TerminalScreen device={device} controller={controller} onBack={vi.fn()} onReconnect={vi.fn()} />);
  const acknowledge = (nextInputSeq: number) => act(() => controller.receive(terminalState({
    ...state, requestId: requests().at(-1)!.requestId, nextInputSeq,
  })));
  return { ...result, requests, acknowledge };
}

describe('TerminalScreen', () => {
  it('edits multiline commands without sending until Run and recalls only in memory', () => {
    const h = setup();
    expect(screen.getByText('Started in: C:\\project')).toHaveAttribute('title', 'Initial workspace: C:\\project');
    fireEvent.change(screen.getByLabelText('Command'), { target: { value: 'first\nsecond' } });
    expect(h.requests().filter((r) => r.action === 'input')).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    expect(h.requests().at(-1)).toMatchObject({ action: 'input', data: 'first\rsecond\r', inputSeq: 1 });
    expect(screen.getByLabelText('Command')).toHaveValue('');
    h.acknowledge(2);
    fireEvent.click(screen.getByRole('button', { name: 'Previous command' }));
    expect(screen.getByLabelText('Command')).toHaveValue('first\nsecond');
    expect(JSON.stringify(localStorage)).not.toContain('first');
  });

  it('blocks snapshot-generated responses and clipboard escapes, and supports explicit interactive input', () => {
    const h = setup();
    expect(h.requests().filter((r) => r.action === 'input')).toHaveLength(0);
    expect(renderer.clipboard).toHaveBeenCalledWith(52, expect.any(Function));
    const osc = renderer.clipboard.mock.calls.at(-1)![1] as () => boolean;
    expect(osc()).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Direct typing' }));
    expect(renderer.options.disableStdin).toBe(false);
    act(() => renderer.data?.('q'));
    expect(h.requests().at(-1)).toMatchObject({ action: 'input', data: 'q' });
    h.acknowledge(2);
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl+C' }));
    expect(h.requests().at(-1)).toMatchObject({ action: 'input', data: '\x03' });
  });

  it('shows ownership and never emits terminal-generated responses as a spectator', () => {
    const h = setup('laptop');
    expect(screen.getByRole('button', { name: 'Run' })).toBeDisabled();
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

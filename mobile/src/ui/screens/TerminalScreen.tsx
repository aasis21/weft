import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { JSX } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import type { ListenerDeviceState } from '@/session/model';
import { TerminalController, TERMINAL_GUIDANCE, type TerminalView } from '@/session/runtime/terminalController';
import { deviceLabel } from './deviceDisplay';
import { BackGlyph, TerminalGlyph } from './deviceGlyphs';
import '@xterm/xterm/css/xterm.css';
import '@/ui/styles/terminal.css';

const KEYS = [
  ['Ctrl+C', '\x03'], ['Esc', '\x1b'], ['Tab', '\t'], ['Up', '\x1b[A'],
  ['Down', '\x1b[B'], ['Left', '\x1b[D'], ['Right', '\x1b[C'], ['Enter', '\r'],
] as const;

export function TerminalScreen({ device, controller, onBack, onReconnect }: {
  device: ListenerDeviceState;
  controller: TerminalController;
  onBack(): void;
  onReconnect(): void;
}): JSX.Element {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const fit = useRef<FitAddon>();
  const closeButton = useRef<HTMLButtonElement>(null);
  const renderView = useRef<(view: TerminalView) => void>();
  const replaying = useRef(false);
  const writing = useRef(false);
  const userScrollVersion = useRef(0);
  const [command, setCommand] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const draft = useRef('');
  const [latest, setLatest] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const [direct, setDirect] = useState(false);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const canInput = controller.canInput();
  const canResize = controller.canResize();
  const closed = view.state?.status === 'closed';

  useEffect(() => {
    controller.setConnected(device.connected);
  }, [controller, device.connected]);

  useEffect(() => {
    if (!controller.getSnapshot().attached) controller.enter();
    const terminalHost = host.current;
    if (!terminalHost) return;
    const term = new Terminal({
      cols: 80, rows: 24, cursorBlink: true, fontSize: 14,
      fontFamily: 'Cascadia Code, Consolas, Menlo, monospace',
      scrollback: 3000, scrollOnUserInput: false, convertEol: false,
      allowProposedApi: false, disableStdin: true, screenReaderMode: true,
      windowOptions: {},
    });
    const addon = new FitAddon();
    term.loadAddon(addon);
    terminal.current = term;
    fit.current = addon;
    // OSC 52 is remote clipboard control. Never load a clipboard addon or permit its fallback.
    const clipboard = term.parser.registerOscHandler(52, () => true);
    try {
      term.open(terminalHost);
    } catch {
      setRendererError('The terminal renderer could not start. Update your browser and reopen this screen.');
    }
    const theme = (): void => {
      const styles = getComputedStyle(terminalHost);
      term.options.theme = {
        background: styles.getPropertyValue('--terminal-bg').trim(),
        foreground: styles.getPropertyValue('--terminal-fg').trim(),
        cursor: styles.getPropertyValue('--terminal-fg').trim(),
        selectionBackground: '#6688aa66',
      };
    };
    theme();
    const observer = new MutationObserver(theme);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener('change', theme);
    const input = term.onData((data) => {
      if (!replaying.current && controller.canInput()) controller.input(data);
    });
    const scroll = term.onScroll(() => {
      if (!writing.current) setLatest(term.buffer.active.viewportY >= term.buffer.active.baseY);
    });
    const userScroll = (): void => { userScrollVersion.current++; };
    const pointerMove = (event: PointerEvent): void => { if (event.buttons) userScroll(); };
    terminalHost.addEventListener('wheel', userScroll, { passive: true });
    terminalHost.addEventListener('touchmove', userScroll, { passive: true });
    terminalHost.addEventListener('pointerdown', userScroll);
    terminalHost.addEventListener('pointermove', pointerMove);
    terminalHost.addEventListener('keydown', userScroll);
    let disposed = false;
    let busy = false;
    let pending: TerminalView | undefined;
    let renderedSnapshot: TerminalView['snapshot'] = null;
    let renderedSeq = -1;
    const drain = (): void => {
      if (disposed || busy || !pending) return;
      const next = pending;
      pending = undefined;
      const snapshot = next.snapshot;
      const isSnapshot = !!snapshot && snapshot !== renderedSnapshot;
      const output = next.output.filter((chunk) => chunk.seq > (isSnapshot ? snapshot.seq : renderedSeq));
      const state = next.state;
      const resize = (): void => {
        if (state && state.cols >= 20 && state.cols <= 240 && state.rows >= 5 && state.rows <= 100 &&
          (term.cols !== state.cols || term.rows !== state.rows)) term.resize(state.cols, state.rows);
      };
      const viewport = term.buffer.active.viewportY;
      const atBottom = viewport >= term.buffer.active.baseY;
      const scrollVersion = userScrollVersion.current;
      busy = true;
      writing.current = true;
      const finish = (): void => {
        if (disposed) return;
        if (scrollVersion === userScrollVersion.current) {
          if (isSnapshot && atBottom) term.scrollToBottom();
          else if (!atBottom) term.scrollToLine(Math.min(viewport, term.buffer.active.baseY));
        }
        writing.current = false;
        busy = false;
        setLatest(term.buffer.active.viewportY >= term.buffer.active.baseY);
        drain();
      };
      const writeOutput = (): void => {
        if (disposed) return;
        replaying.current = false;
        resize();
        for (const chunk of output) renderedSeq = chunk.seq;
        if (output.length) term.write(output.map((chunk) => chunk.data).join(''), finish);
        else finish();
      };
      if (isSnapshot) {
        replaying.current = true;
        term.reset();
        term.resize(snapshot.cols, snapshot.rows);
        renderedSnapshot = snapshot;
        renderedSeq = snapshot.seq;
        term.write(snapshot.data, writeOutput);
      } else writeOutput();
    };
    renderView.current = (next) => {
      // Output is cumulative until the next snapshot. Keep only the newest bounded view
      // while xterm parses; resets and resizes must wait for the previous write callback.
      // An error invalidates input readiness, not an accepted screen still awaiting rendering.
      const queuedSnapshot = pending?.snapshot;
      pending = !next.snapshot && queuedSnapshot && queuedSnapshot.terminalId === next.state?.terminalId
        ? { ...next, snapshot: queuedSnapshot }
        : next;
      drain();
    };
    return () => {
      disposed = true;
      pending = undefined;
      renderView.current = undefined;
      replaying.current = false;
      writing.current = false;
      controller.leave();
      observer.disconnect();
      media.removeEventListener('change', theme);
      clipboard.dispose();
      input.dispose();
      scroll.dispose();
      terminalHost.removeEventListener('wheel', userScroll);
      terminalHost.removeEventListener('touchmove', userScroll);
      terminalHost.removeEventListener('pointerdown', userScroll);
      terminalHost.removeEventListener('pointermove', pointerMove);
      terminalHost.removeEventListener('keydown', userScroll);
      term.dispose();
      terminal.current = undefined;
      fit.current = undefined;
    };
  }, [controller]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.disableStdin = !direct || !canInput;
  }, [direct, canInput]);

  useEffect(() => {
    renderView.current?.(view);
  }, [view, controller]);

  const run = (): void => {
    if (!command.trim() || !controller.input(`${command.replace(/\r?\n/g, '\r')}\r`)) return;
    setHistory((items) => [command, ...items.filter((item) => item !== command)].slice(0, 30));
    setHistoryIndex(-1);
    setCommand('');
    draft.current = '';
  };
  const recall = (direction: number): void => {
    if (historyIndex === -1) draft.current = command;
    const next = Math.min(history.length - 1, Math.max(-1, historyIndex + direction));
    setHistoryIndex(next);
    setCommand(next < 0 ? draft.current : history[next]!);
  };
  const fitPhone = (): void => {
    const dimensions = fit.current?.proposeDimensions();
    if (dimensions) controller.resize(dimensions.cols, dimensions.rows);
  };

  return (
    <main className="terminal-screen" aria-label="Shared terminal">
      <header className="terminal-header">
        <button type="button" className="icon-btn" aria-label="Back to device" onClick={onBack}><BackGlyph /></button>
        <span className="device-action-icon" aria-hidden="true"><TerminalGlyph /></span>
        <div><h1>Terminal</h1><p>{deviceLabel(device)} - one shared shell</p></div>
        <button type="button" ref={closeButton} disabled={!view.state?.terminalId || closed || !view.connected}
          onClick={() => setConfirmClose(true)}>Close</button>
      </header>
      <section className="terminal-status" aria-label="Terminal status">
        <span role="status">{!view.connected ? 'Disconnected' : closed ? 'Shell closed' :
          view.state?.status === 'error' ? 'Terminal error' :
          view.syncing ? 'Syncing terminal...' : view.state?.status === 'open' ? 'Connected' : 'No terminal attached'}</span>
        <span>{view.state?.owner === 'phone' ? 'You have control' :
          view.state?.owner === 'laptop' ? 'Laptop has control' : 'No input owner'}</span>
        {view.state?.shell ? <span>{view.state.shell}</span> : null}
        {view.state?.cwd ? (
          <span className="terminal-cwd" title={`Initial workspace: ${view.state.cwd}`}>
            Started in: {view.state.cwd}
          </span>
        ) : null}
        {view.state?.owner !== 'phone' && !closed && view.state?.terminalId ? (
          <button type="button" disabled={!view.connected || view.syncing} onClick={() => controller.claim()}>Take control</button>
        ) : null}
        <button type="button" onClick={() => { onReconnect(); controller.reattach(); }}>Reattach</button>
        <button type="button" disabled={!canResize} onClick={fitPhone}>Fit to phone</button>
      </section>
      {view.error || rendererError ? <p className="terminal-notice" role="alert">{rendererError ?? view.error}</p> : null}
      {view.snapshot?.truncated ? <p className="terminal-notice">Earlier scrollback was omitted from this bounded snapshot.</p> : null}
      {!view.state?.terminalId || closed ? (
        <div className="terminal-notice">
          <p>{closed ? 'This shell has ended. Opening a new shell will not repeat previous commands.' : TERMINAL_GUIDANCE}</p>
          <button type="button" disabled={!view.connected || view.syncing} onClick={() => controller.open()}>
            {closed ? 'Open new terminal' : 'Open terminal'}
          </button>
        </div>
      ) : null}
      <section className="terminal-display" aria-label="Terminal output">
        <div className="terminal-pan"><div className="terminal-host" ref={host} /></div>
        {!latest ? <button type="button" className="terminal-latest" aria-label="Return to latest output"
          onClick={() => { terminal.current?.scrollToBottom(); setLatest(true); }}>
          <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true">
            <path d="M10 3v13m-5-5 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg> Latest
        </button> : null}
      </section>
      <div className="terminal-keys" role="toolbar" aria-label="Terminal special keys">
        {KEYS.map(([label, data]) => <button type="button" key={label} disabled={!canInput}
          onClick={() => {
            const applicationArrow = data.startsWith('\x1b[') && terminal.current?.modes.applicationCursorKeysMode;
            controller.input(applicationArrow ? `\x1bO${data.slice(2)}` : data);
          }}>{label}</button>)}
      </div>
      <section className="terminal-editor" aria-label="Command editor">
        <div className="terminal-editor-heading">
          <label htmlFor="terminal-command">Command</label>
          <button type="button" disabled={!canInput} aria-pressed={direct}
            onClick={() => { setDirect(!direct); if (!direct) terminal.current?.focus(); }}>Direct typing</button>
          <button type="button" disabled={!history.length || historyIndex === history.length - 1}
            aria-label="Previous command" onClick={() => recall(1)}>Previous</button>
          <button type="button" disabled={historyIndex < 0} aria-label="Next command" onClick={() => recall(-1)}>Next</button>
        </div>
        <textarea id="terminal-command" rows={3} maxLength={16384} value={command} autoCapitalize="off" autoCorrect="off"
          spellCheck={false} placeholder="Write a command, then tap Run"
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault(); run();
          } }} />
        <div className="terminal-editor-footer">
          <small>Runs with laptop account permissions, not in a sandbox. Leaving only detaches output.</small>
          <button type="button" className="primary-action" disabled={!canInput || !command.trim() || view.pendingInput}
            onClick={run}>Run</button>
        </div>
      </section>
      {confirmClose ? (
        <div className="terminal-confirm-backdrop">
        <div className="terminal-confirm" role="dialog" aria-modal="true" aria-labelledby="terminal-close-title"
          onKeyDown={(event) => {
            if (event.key === 'Escape') { setConfirmClose(false); closeButton.current?.focus(); }
            if (event.key === 'Tab') {
              const buttons = event.currentTarget.querySelectorAll('button');
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
              if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
            }
          }}>
          <h2 id="terminal-close-title">Close terminal?</h2>
          <p>This ends the shell and its running processes on the laptop. To leave it running, go back instead.</p>
          <button type="button" autoFocus onClick={() => { setConfirmClose(false); closeButton.current?.focus(); }}>Cancel</button>
          <button type="button" onClick={() => { setConfirmClose(false); controller.close(); }}>Close terminal</button>
        </div>
        </div>
      ) : null}
    </main>
  );
}

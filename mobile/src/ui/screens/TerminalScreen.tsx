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
  ['Ctrl+C', '\x03'], ['Esc', '\x1b'], ['Tab', '\t'], ['Enter', '\r'],
  ['Up', '\x1b[A'], ['Down', '\x1b[B'], ['Left', '\x1b[D'], ['Right', '\x1b[C'],
] as const;

export function TerminalScreen({ device, controller, onBack, onReconnect }: {
  device: ListenerDeviceState;
  controller: TerminalController;
  onBack(): void;
  onReconnect(): void;
}): JSX.Element {
  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const screenRoot = useRef<HTMLElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const terminal = useRef<Terminal>();
  const fit = useRef<FitAddon>();
  const closeButton = useRef<HTMLButtonElement>(null);
  const renderView = useRef<(view: TerminalView) => void>();
  const replaying = useRef(false);
  const writing = useRef(false);
  const userScrollVersion = useRef(0);
  const [command, setCommand] = useState('');
  const [editorOpen, setEditorOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [latest, setLatest] = useState(true);
  const [confirmClose, setConfirmClose] = useState(false);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const canInput = controller.canInput();
  const canResize = controller.canResize();
  const closed = view.state?.status === 'closed';

  useEffect(() => {
    controller.setConnected(device.connected);
  }, [controller, device.connected]);

  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const update = (): void => {
      if (viewport.scale !== 1) return;
      screenRoot.current?.style.setProperty('--terminal-height', `${viewport.height}px`);
      screenRoot.current?.style.setProperty('--terminal-top', `${viewport.offsetTop}px`);
    };
    update();
    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, []);

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
    const paste = (event: ClipboardEvent): void => {
      if (!event.clipboardData) return;
      event.preventDefault();
      event.stopPropagation();
      const text = event.clipboardData.getData('text/plain');
      if (text) {
        setCommand(text);
        setEditorOpen(true);
      }
    };
    terminalHost.addEventListener('paste', paste, true);
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
      terminalHost.removeEventListener('paste', paste, true);
      term.dispose();
      terminal.current = undefined;
      fit.current = undefined;
    };
  }, [controller]);

  useEffect(() => {
    const term = terminal.current;
    if (!term) return;
    term.options.disableStdin = !canInput;
  }, [canInput, controller]);

  useEffect(() => {
    const element = host.current;
    if (!element || !canResize || !canInput || rendererError || view.error) return;
    let frame = 0;
    const resize = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!controller.canResize() || !controller.canInput() || controller.getSnapshot().error) return;
        const size = fit.current?.proposeDimensions();
        if (size) controller.resize(size.cols, size.rows);
      });
    };
    // Only the input owner adapts the shared grid, including when the phone keyboard opens.
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [controller, canResize, canInput, rendererError, view.error]);

  useEffect(() => {
    renderView.current?.(view);
  }, [view, controller]);

  const run = (): void => {
    if (!command.trim() || !controller.input(`${command.replace(/\r?\n/g, '\r')}\r`)) return;
    setCommand('');
  };
  const fitPhone = (): void => {
    const dimensions = fit.current?.proposeDimensions();
    if (dimensions) controller.resize(dimensions.cols, dimensions.rows);
  };
  const showKeyboard = (): void => {
    if (!controller.canInput() || !terminal.current) return;
    setEditorOpen(false);
    terminal.current.options.disableStdin = false;
    terminal.current.focus();
  };

  return (
    <main ref={screenRoot} className="terminal-screen" aria-label="Shared terminal">
      <header className="terminal-header">
        <button type="button" className="icon-btn" aria-label="Back to device" onClick={onBack}><BackGlyph /></button>
        <span className="device-action-icon" aria-hidden="true"><TerminalGlyph /></span>
        <div><h1>Terminal</h1><p>{deviceLabel(device)}</p></div>
        <button type="button" ref={closeButton} disabled={!view.state?.terminalId || closed || !view.connected}
          onClick={() => setConfirmClose(true)}>Close</button>
      </header>
      <section className="terminal-status" aria-label="Terminal status">
        <span className="terminal-connection" data-connected={view.connected && !closed && !view.error} role="status">{!view.connected ? 'Disconnected' : closed ? 'Shell closed' :
          view.state?.status === 'error' ? 'Terminal error' :
          view.syncing ? 'Syncing terminal...' : view.state?.status === 'open' ? 'Connected' : 'No terminal attached'}</span>
        <span className="terminal-owner">{view.state?.owner === 'phone' ? 'You have control' :
          view.state?.owner === 'laptop' ? 'Laptop has control' : 'No input owner'}</span>
        {view.state?.owner !== 'phone' && !closed && view.state?.terminalId ? (
          <button type="button" disabled={!view.connected || view.syncing} onClick={() => controller.claim()}>Take control</button>
        ) : null}
        <button type="button" className="terminal-details-toggle" aria-expanded={detailsOpen}
          aria-controls="terminal-details" onClick={() => setDetailsOpen(!detailsOpen)}>Details</button>
      </section>
      {detailsOpen ? (
        <section id="terminal-details" className="terminal-details" aria-label="Terminal details">
          {view.state?.shell ? <strong>{view.state.shell}</strong> : null}
          {view.state?.cwd ? (
            <span className="terminal-cwd" title={`Initial workspace: ${view.state.cwd}`}>
              Started in: {view.state.cwd}
            </span>
          ) : null}
          <p>One shell shared with your laptop. Commands run with your account permissions, not in a sandbox.
            Leaving this page keeps the shell running.</p>
          <button type="button" onClick={() => { onReconnect(); controller.reattach(); }}>Reattach</button>
        </section>
      ) : null}
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
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => {
            const applicationArrow = data.startsWith('\x1b[') && terminal.current?.modes.applicationCursorKeysMode;
            controller.input(applicationArrow ? `\x1bO${data.slice(2)}` : data);
          }}>{label}</button>)}
      </div>
      <div className="terminal-actions" aria-label="Terminal controls">
        <button type="button" disabled={!canInput || !!rendererError} onClick={showKeyboard}>Keyboard</button>
        <button type="button" aria-expanded={editorOpen} aria-controls="terminal-editor"
          onClick={() => setEditorOpen(!editorOpen)}>Write / paste</button>
        <button type="button" disabled={!canResize || !!rendererError} onClick={fitPhone}>Fit to phone</button>
      </div>
      {editorOpen ? <section id="terminal-editor" className="terminal-editor" aria-label="Command editor">
        <div className="terminal-editor-heading">
          <label htmlFor="terminal-command">Command</label>
          <span>Draft first. Run when ready.</span>
        </div>
        <textarea id="terminal-command" rows={2} maxLength={16384} value={command} autoCapitalize="off" autoCorrect="off"
          autoFocus spellCheck={false} placeholder="Write or paste a command"
          onChange={(event) => setCommand(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault(); run();
          } }} />
        <div className="terminal-editor-footer">
          <small>Pasting here never runs a command automatically.</small>
          <button type="button" className="primary-action" disabled={!canInput || !command.trim() || view.pendingInput}
            onClick={run}>Run</button>
        </div>
      </section> : null}
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

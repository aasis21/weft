import {
  DEVICE_CAPABILITY, EVENT_TYPE, SUBTYPE, terminalRequest,
  type EventEnvelope, type TerminalRequestMsg, type TerminalStateMsg,
  type TerminalSnapshotMsg, type TerminalOutputMsg,
} from '@aasis21/weft-shared';

export const TERMINAL_GUIDANCE =
  'Update Weft on the laptop and start Device Station with weft start --allow-terminal. The shell runs with your laptop account permissions; the workspace is not a sandbox.';
const MAX_BUFFER = 512 * 1024;
const MAX_INPUT = 16 * 1024;
export const MAX_TERMINAL_SNAPSHOT_BYTES = 128 * 1024;
const TIMEOUT = 10_000;
const bytes = (value: string): number => new TextEncoder().encode(value).length;
export const terminalSnapshotPayloadBytes = (snapshot: object): number => bytes(JSON.stringify(snapshot));
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length <= limit && bytes(value) <= limit;
const identifier = (value: unknown): value is string => text(value, 128) && value.length > 0;
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const dimensions = (value: Record<string, unknown>): boolean =>
  integer(value.cols, 20, 240) && integer(value.rows, 5, 100);

function validState(value: unknown): value is TerminalStateMsg {
  return record(value) &&
    (value.requestId === null || identifier(value.requestId)) &&
    (value.terminalId === null || identifier(value.terminalId)) &&
    typeof value.status === 'string' && ['opening', 'open', 'closed', 'error'].includes(value.status) &&
    (value.status !== 'open' || identifier(value.terminalId)) &&
    (value.shell === null || text(value.shell, 4096)) &&
    (value.cwd === null || text(value.cwd, 32 * 1024)) &&
    (value.error === null || text(value.error, 8192)) &&
    (value.owner === null || value.owner === 'phone' || value.owner === 'laptop') &&
    integer(value.nextInputSeq, 1) && dimensions(value);
}

function validSnapshot(value: unknown): value is TerminalSnapshotMsg {
  return record(value) && identifier(value.terminalId) && integer(value.seq, 0) &&
    text(value.data, MAX_TERMINAL_SNAPSHOT_BYTES) && dimensions(value) &&
    typeof value.truncated === 'boolean' && terminalSnapshotPayloadBytes(value) <= MAX_TERMINAL_SNAPSHOT_BYTES;
}

function validOutput(value: unknown): value is TerminalOutputMsg {
  return record(value) && identifier(value.terminalId) && integer(value.seq, 0) && text(value.data, MAX_BUFFER);
}
export const terminalDimensions = (cols: number, rows: number): { cols: number; rows: number } => ({
  cols: Math.max(20, Math.min(240, Math.floor(Number.isFinite(cols) ? cols : 80))),
  rows: Math.max(5, Math.min(100, Math.floor(Number.isFinite(rows) ? rows : 24))),
});

export function isTerminalEnvelope(message: { eventType: string; eventSubtype: string }): boolean {
  return message.eventType === EVENT_TYPE.CONTROL &&
    [SUBTYPE.CONTROL.TERMINAL_REQUEST, SUBTYPE.CONTROL.TERMINAL_STATE,
      SUBTYPE.CONTROL.TERMINAL_OUTPUT, SUBTYPE.CONTROL.TERMINAL_SNAPSHOT].some((s) => s === message.eventSubtype);
}

export interface TerminalView {
  state: TerminalStateMsg | null;
  snapshot: TerminalSnapshotMsg | null;
  output: TerminalOutputMsg[];
  connected: boolean;
  attached: boolean;
  syncing: boolean;
  pendingInput: boolean;
  uncertainInput: boolean;
  error: string | null;
}

interface Pending {
  action: TerminalRequestMsg['action'];
  timer: ReturnType<typeof setTimeout>;
  recoverSnapshot?: boolean;
}

/** Volatile private session data. Deliberately outside Redux and all diagnostic/persistence paths. */
export class TerminalController {
  private view: TerminalView = {
    state: null, snapshot: null, output: [], connected: false, attached: false,
    syncing: false, pendingInput: false, uncertainInput: false, error: null,
  };
  private listeners = new Set<() => void>();
  private pending = new Map<string, Pending>();
  private queuedInput: string[] = [];
  private queuedBytes = 0;
  private buffered = new Map<number, TerminalOutputMsg>();
  private bufferedBytes = 0;
  private outputBytes = 0;
  private sequence = -1;
  private attachRequested = false;
  private disposed = false;
  private snapshotTimer?: ReturnType<typeof setTimeout>;
  private earlySnapshot: TerminalSnapshotMsg | null = null;
  private earlyOutput: TerminalOutputMsg[] = [];
  private earlyBytes = 0;

  constructor(private readonly transport: {
    send(message: EventEnvelope): Promise<void>;
    capabilities(): string[];
  }) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  getSnapshot = (): TerminalView => this.view;
  private update(patch: Partial<TerminalView>): void {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  private clearPending(): void {
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    for (const request of this.pending.values()) clearTimeout(request.timer);
    this.pending.clear();
    this.queuedInput = [];
    this.queuedBytes = 0;
    this.attachRequested = false;
    this.earlySnapshot = null;
    this.earlyOutput = [];
    this.earlyBytes = 0;
  }
  private resetOutput(): void {
    this.buffered.clear();
    this.bufferedBytes = this.outputBytes = 0;
    this.sequence = -1;
    this.update({ snapshot: null, output: [] });
  }
  setConnected(connected: boolean): void {
    if (connected === this.view.connected) return;
    const uncertainInput = this.view.uncertainInput || this.view.pendingInput;
    this.clearPending();
    this.update({ connected, pendingInput: false, uncertainInput,
      syncing: this.view.attached && !!this.view.state?.terminalId && this.view.state.status !== 'closed',
      error: connected ? this.view.error : 'Disconnected. Input will not be retried.' });
    if (connected && this.view.attached && this.view.state?.terminalId && this.view.state.status !== 'closed') {
      this.reattach();
    }
  }
  /** Navigation never creates a shell. Only an explicit Open action does. */
  enter(): void {
    this.update({ attached: true });
    if (this.view.state?.terminalId && this.view.state.status !== 'closed') this.reattach();
  }
  leave(): void {
    const terminalId = this.view.state?.terminalId;
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.attachRequested = false;
    this.update({ attached: false, syncing: false });
    this.queuedInput = [];
    this.queuedBytes = 0;
    this.resetOutput();
    if (terminalId && this.view.connected && this.view.state?.status !== 'closed') {
      this.request('detach', { terminalId });
    }
  }
  open(projectName?: string): void {
    if ([...this.pending.values()].some((p) => p.action === 'open')) return;
    if (!this.transport.capabilities().includes(DEVICE_CAPABILITY.TERMINAL_V1)) {
      this.update({ error: TERMINAL_GUIDANCE });
      return;
    }
    if (this.view.state?.terminalId && this.view.state.status !== 'closed') {
      this.reattach();
      return;
    }
    this.resetOutput();
    this.update({ syncing: true, error: null });
    this.request('open', { ...(projectName ? { projectName } : {}), cols: 80, rows: 24 });
  }
  reattach(): void {
    const terminalId = this.view.state?.terminalId;
    if (!terminalId || this.view.state?.status === 'closed' || this.attachRequested || !this.view.attached) return;
    const uncertainInput = this.view.uncertainInput || this.view.pendingInput;
    for (const [id, request] of this.pending) {
      if (request.action !== 'input') continue;
      clearTimeout(request.timer);
      this.pending.delete(id);
    }
    const discardedTyping = this.queuedInput.length > 0;
    this.queuedInput = [];
    this.queuedBytes = 0;
    this.attachRequested = true;
    this.update({
      syncing: true, pendingInput: false, uncertainInput,
      ...(discardedTyping ? { error: 'Unsent typing was discarded while resynchronizing. No input will be retried.' } : {}),
    });
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => {
      this.attachRequested = false;
      this.update({ error: 'Snapshot not received. Reattach to recover output without repeating input.' });
    }, TIMEOUT);
    this.request('attach', { terminalId });
  }
  claim(): void { this.request('claim'); }
  close(): void {
    this.request('close');
    this.update({});
  }
  resize(cols: number, rows: number): void {
    if (!this.canResize()) {
      this.update({ error: 'Take control of the connected terminal before resizing.' });
      return;
    }
    const dimensions = terminalDimensions(cols, rows);
    if (dimensions.cols !== this.view.state?.cols || dimensions.rows !== this.view.state.rows) {
      this.request('resize', dimensions);
      this.update({});
    }
  }
  canResize(): boolean {
    return this.view.connected && this.view.attached && !!this.view.state?.terminalId &&
      this.view.state.owner === 'phone' &&
      (this.view.state.status === 'open' || this.view.state.status === 'error') &&
      ![...this.pending.values()].some((request) => request.action === 'close' || request.action === 'resize');
  }
  canInput(): boolean {
    return this.view.connected && this.view.attached && !!this.view.snapshot && !this.view.syncing && !this.view.uncertainInput &&
      ![...this.pending.values()].some((request) => ['open', 'attach', 'close'].includes(request.action)) &&
      this.view.state?.status === 'open' && this.view.state.owner === 'phone';
  }
  input(data: string): boolean {
    if (!this.canInput()) {
      this.update({ error: 'Input not sent. Reconnect and take control before typing.' });
      return false;
    }
    const length = bytes(data);
    if (!length) return false;
    if (length > MAX_INPUT || this.queuedBytes + length > MAX_INPUT) {
      this.update({ error: 'Input not sent: the command or queued typing exceeds 16 KB.' });
      return false;
    }
    if (this.view.pendingInput) {
      this.queuedInput.push(data);
      this.queuedBytes += length;
    } else {
      this.update({ pendingInput: true });
      this.request('input', { data, inputSeq: this.view.state!.nextInputSeq });
    }
    return true;
  }
  private request(action: TerminalRequestMsg['action'], fields: Partial<TerminalRequestMsg> = {}): void {
    if (!this.view.connected) {
      this.attachRequested = false;
      this.update({ error: 'Laptop disconnected. Reconnect to attach; no command will be retried.', syncing: false });
      return;
    }
    const terminalId = this.view.state?.terminalId;
    if (action !== 'open' && !terminalId) {
      this.update({ error: 'No live terminal. Choose Open terminal to start a shell.' });
      return;
    }
    if (this.pending.size >= 32) {
      this.update({
        error: 'Too many pending terminal requests. Wait for the laptop or reattach.',
        ...(action === 'input' ? { pendingInput: false } : {}),
      });
      return;
    }
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => this.failed(requestId), TIMEOUT);
    this.pending.set(requestId, {
      action, timer,
      recoverSnapshot: (action === 'resize' || action === 'claim') &&
        (this.view.state?.status === 'error' || this.view.syncing || !this.view.snapshot),
    });
    const message = terminalRequest({ requestId, action, ...(terminalId && action !== 'open' ? { terminalId } : {}), ...fields });
    // Neither the envelope nor the transport exception (which may quote it) goes into diagnostics.
    void this.transport.send(message).catch(() => this.failed(requestId));
  }
  private failed(requestId: string): void {
    const pending = this.pending.get(requestId);
    if (!pending || this.disposed) return;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    if (pending.action === 'attach' || pending.action === 'open') {
      this.attachRequested = false;
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = undefined;
    }
    this.queuedInput = [];
    this.queuedBytes = 0;
    this.update({
      pendingInput: pending.action === 'input' ? false : this.view.pendingInput,
      uncertainInput: pending.action === 'input' || this.view.uncertainInput,
      syncing: ['open', 'attach', 'close'].includes(pending.action)
        ? !!this.view.state?.terminalId && this.view.state.status !== 'closed'
        : this.view.syncing,
      error: pending.action === 'input'
        ? 'Input acknowledgement lost. It may have run. Reattach to reconcile; it will never be retried automatically.'
        : 'Terminal request was not acknowledged. Reattach to recover an existing shell; Open is always explicit.',
    });
  }
  receive(message: EventEnvelope): void {
    if (message.eventType !== EVENT_TYPE.CONTROL) return;
    const invalid = (): void => {
      this.update({ error: 'Invalid or oversized terminal message ignored. Reattach to recover the screen.' });
    };
    if (message.eventSubtype === SUBTYPE.CONTROL.TERMINAL_STATE) {
      if (!validState(message.msg)) { invalid(); return; }
      const { requestId, terminalId, status, shell, cwd, cols, rows, owner, nextInputSeq, error } = message.msg;
      this.receiveState({ requestId, terminalId, status, shell, cwd, cols, rows, owner, nextInputSeq, error });
    } else if (message.eventSubtype === SUBTYPE.CONTROL.TERMINAL_SNAPSHOT) {
      if (!validSnapshot(message.msg)) {
        clearTimeout(this.snapshotTimer);
        this.snapshotTimer = undefined;
        this.attachRequested = false;
        this.update({ error: 'Invalid or oversized terminal snapshot: the complete JSON payload must fit within 128 KiB. Reattach after reducing the laptop terminal size.' });
        return;
      }
      const { terminalId, seq, data, cols, rows, truncated } = message.msg;
      this.receiveSnapshot({ terminalId, seq, data, cols, rows, truncated });
    } else if (message.eventSubtype === SUBTYPE.CONTROL.TERMINAL_OUTPUT) {
      if (!validOutput(message.msg)) { invalid(); this.reattach(); return; }
      const { terminalId, seq, data } = message.msg;
      this.receiveOutput({ terminalId, seq, data });
    }
  }
  private receiveState(state: TerminalStateMsg): void {
    const pending = state.requestId ? this.pending.get(state.requestId) : undefined;
    if (state.requestId && !pending) return;
    if (this.view.state?.terminalId && state.terminalId !== this.view.state.terminalId &&
      pending?.action !== 'open' &&
      !(pending && state.terminalId === null && (state.status === 'error' || state.status === 'closed'))) return;
    if (!this.view.state && !pending) return;
    if (pending && state.status !== 'opening') {
      clearTimeout(pending.timer);
      this.pending.delete(state.requestId!);
    }
    if (state.status === 'closed') {
      this.clearPending();
      this.update({ state, syncing: false, pendingInput: false, uncertainInput: false, error: state.error });
      return;
    }
    if (state.status === 'error') {
      clearTimeout(this.snapshotTimer);
      this.snapshotTimer = undefined;
      this.attachRequested = false;
      for (const [id, request] of this.pending) {
        if (request.action !== 'open' && request.action !== 'attach') continue;
        clearTimeout(request.timer);
        this.pending.delete(id);
      }
      this.update({ syncing: false, snapshot: null });
    }
    // Opening a replacement generation must not retain the previous shell's screen boundary.
    if (state.terminalId && state.terminalId !== this.view.state?.terminalId) this.resetOutput();
    const acknowledged = pending?.action === 'input' ||
      ((pending?.action === 'attach' || pending?.action === 'open') && state.status === 'open');
    if (state.terminalId === this.view.state?.terminalId) {
      state = { ...state, nextInputSeq: Math.max(state.nextInputSeq, this.view.state.nextInputSeq) };
    }
    this.update({ state, error: state.error,
      ...(acknowledged ? { pendingInput: false, uncertainInput: false } : {}),
    });
    if (pending?.action === 'open' && state.status === 'open') {
      const earlySnapshot = this.earlySnapshot;
      const earlyOutput = this.earlyOutput;
      this.earlySnapshot = null;
      this.earlyOutput = [];
      this.earlyBytes = 0;
      if (earlySnapshot) this.receiveSnapshot(earlySnapshot);
      for (const output of earlyOutput) this.receiveOutput(output);
    }
    if (!this.view.attached && state.status === 'open' && pending?.action === 'open') {
      this.request('detach');
    }
    if (pending?.action === 'attach' || pending?.action === 'open') {
      if (state.status === 'open' && this.view.syncing && !this.snapshotTimer) {
        this.snapshotTimer = setTimeout(() => {
          this.attachRequested = false;
          this.update({ error: 'Snapshot not received. Reattach to recover output without repeating input.' });
        }, TIMEOUT);
      }
    }
    if (state.owner !== 'phone' || state.status === 'error') {
      this.queuedInput = [];
      this.queuedBytes = 0;
    } else if (pending?.action === 'input' && this.queuedInput.length && this.canInput()) {
      const data = this.queuedInput.shift()!;
      this.queuedBytes -= bytes(data);
      this.input(data);
    }
    if (pending?.recoverSnapshot && state.status === 'open') this.reattach();
  }
  private receiveSnapshot(snapshot: TerminalSnapshotMsg): void {
    if (!this.view.attached) return;
    if (snapshot.terminalId !== this.view.state?.terminalId) {
      if ([...this.pending.values()].some((request) => request.action === 'open')) this.earlySnapshot = snapshot;
      return;
    }
    if (snapshot.seq < this.sequence || (snapshot.seq === this.sequence && !this.view.syncing)) return;
    clearTimeout(this.snapshotTimer);
    this.snapshotTimer = undefined;
    this.attachRequested = false;
    this.sequence = snapshot.seq;
    this.outputBytes = 0;
    this.update({ snapshot, output: [], syncing: false });
    const buffered = [...this.buffered.values()].sort((a, b) => a.seq - b.seq);
    this.buffered.clear();
    this.bufferedBytes = 0;
    for (const output of buffered) this.receiveOutput(output);
  }
  private receiveOutput(output: TerminalOutputMsg): void {
    if (!this.view.attached) return;
    const length = bytes(output.data);
    if (output.terminalId !== this.view.state?.terminalId) {
      if ([...this.pending.values()].some((request) => request.action === 'open') &&
        this.earlyOutput.length < 256 && this.earlyBytes + length <= MAX_BUFFER) {
        this.earlyOutput.push(output);
        this.earlyBytes += length;
      }
      return;
    }
    if (output.seq <= this.sequence) return;
    if (this.view.syncing || this.sequence < 0 || output.seq !== this.sequence + 1) {
      if (!this.buffered.has(output.seq) && this.buffered.size < 256 && this.bufferedBytes + length <= MAX_BUFFER) {
        this.buffered.set(output.seq, output);
        this.bufferedBytes += length;
      }
      this.reattach();
      return;
    }
    if (this.outputBytes + length > MAX_BUFFER || this.view.output.length >= 1024) {
      this.reattach();
      return;
    }
    this.sequence = output.seq;
    this.outputBytes += length;
    this.update({ output: [...this.view.output, output] });
  }
  dispose(): void {
    this.disposed = true;
    this.clearPending();
    this.listeners.clear();
    this.buffered.clear();
    this.view = { ...this.view, state: null, snapshot: null, output: [] };
  }
}

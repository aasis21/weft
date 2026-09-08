import {
  SecureChannel, EVENT_TYPE, SUBTYPE, DEVICE_CAPABILITY, PAIR_KIND,
  buildPairingPayload, createPairingGate, createLocalTransport, generateKeyPair,
  randomChannelId, waitForPeer, projectList, terminalState, terminalSnapshot, terminalOutput,
  type TerminalRequestMsg, type TerminalStateMsg, type TerminalSnapshotMsg,
} from '@aasis21/weft-shared';
import { pairSession } from './weftClient';
import { MAX_TERMINAL_SNAPSHOT_BYTES, terminalSnapshotPayloadBytes } from '@/session/runtime/terminalController';

type DemoSnapshotResult = { ok: true; snapshot: TerminalSnapshotMsg } | { ok: false; error: string };

/** The demo emits complete CRLF-delimited lines, not an arbitrary application VT stream. */
export function boundDemoSnapshot(snapshot: TerminalSnapshotMsg): DemoSnapshotResult {
  if (terminalSnapshotPayloadBytes(snapshot) <= MAX_TERMINAL_SNAPSHOT_BYTES) return { ok: true, snapshot };
  const lines = snapshot.data.split('\r\n');
  const trim = (first: number): TerminalSnapshotMsg => ({
    ...snapshot, data: lines.slice(first).join('\r\n'), truncated: true,
  });
  let low = 1;
  let high = Math.max(0, lines.length - snapshot.rows);
  if (high === 0 || terminalSnapshotPayloadBytes(trim(high)) > MAX_TERMINAL_SNAPSHOT_BYTES) {
    return { ok: false, error: 'The demo terminal screen exceeds the relay-safe 128 KiB snapshot limit. Close it and open a new demo terminal.' };
  }
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (terminalSnapshotPayloadBytes(trim(middle)) <= MAX_TERMINAL_SNAPSHOT_BYTES) high = middle;
    else low = middle + 1;
  }
  return { ok: true, snapshot: trim(low) };
}

/** An encrypted, in-process Station simulator, like the existing Copilot demo. No OS shell runs. */
export async function startDemoStation() {
  const channelId = randomChannelId();
  const keys = await generateKeyPair();
  const transport = createLocalTransport({ channelId });
  const payload = buildPairingPayload({
    channelId, publicKeyB64: keys.publicKeyB64, transport: { kind: 'local' }, kind: PAIR_KIND.LISTENER,
  });
  const peer = waitForPeer({
    transport, keyPair: keys, timeoutMs: 10_000, connect: false, channelId,
    pairingGate: createPairingGate({ pairingToken: payload.token, expiresAt: payload.expiresAt }),
  });
  await transport.connect();
  const { client, pairing } = await pairSession(payload, { transport: createLocalTransport({ channelId }) });
  const { key } = await peer;
  const station = new SecureChannel({
    transport, key, identity: { channelId, sessionId: 'demo-station', senderId: 'demo', senderName: 'Demo laptop' },
  });
  await station.connect();
  let state: TerminalStateMsg = {
    requestId: null, terminalId: null, status: 'closed', shell: 'Demo shell (simulated)',
    cwd: 'C:\\Demo', cols: 80, rows: 24, owner: 'phone', nextInputSeq: 1, error: null,
  };
  let seq = 0;
  let screen = '';
  let input = '';
  let attached = false;
  let truncated = false;
  let snapshotError: string | null = null;
  const prepareSnapshot = (): DemoSnapshotResult => {
    if (snapshotError) return { ok: false, error: snapshotError };
    return boundDemoSnapshot({
      terminalId: state.terminalId ?? '', seq, data: screen, cols: state.cols, rows: state.rows, truncated,
    });
  };
  const output = async (data: string): Promise<void> => {
    if (!snapshotError) {
      screen += data;
      if (screen.length > MAX_TERMINAL_SNAPSHOT_BYTES) {
        const result = prepareSnapshot();
        if (result.ok) {
          screen = result.snapshot.data;
          truncated = result.snapshot.truncated;
        } else {
          snapshotError = result.error;
          screen = '';
        }
      }
    }
    seq++;
    if (attached && state.terminalId) await station.send(terminalOutput({ terminalId: state.terminalId, seq, data }));
  };
  const handle = async (request: TerminalRequestMsg): Promise<void> => {
    state = { ...state, requestId: request.requestId, error: null };
    if (request.action === 'open' && state.status === 'closed') {
      state = { ...state, terminalId: crypto.randomUUID(), status: 'open', nextInputSeq: 1, owner: 'phone' };
      screen = '\x1b[36mWeft terminal demo\x1b[0m\r\nSimulated shell - no laptop commands execute.\r\nTry echo hello, pwd, history, stream, laptop, or exit.\r\nPS C:\\Demo> ';
      seq = 0;
      input = '';
      truncated = false;
      snapshotError = null;
    }
    if (request.action === 'open' || request.action === 'attach') attached = true;
    if (request.action === 'detach') attached = false;
    if (request.action === 'claim') state.owner = 'phone';
    if (request.action === 'resize') {
      state.cols = request.cols ?? state.cols;
      state.rows = request.rows ?? state.rows;
    }
    if (request.action === 'close') state.status = 'closed';
    if (request.action === 'input' && state.owner === 'phone' && request.inputSeq === state.nextInputSeq) {
      state.nextInputSeq++;
      for (const character of request.data ?? '') {
        if (character === '\x03') {
          input = '';
          await output('^C\r\nPS C:\\Demo> ');
        } else if (character === '\r') {
          const command = input;
          input = '';
          await output('\r\n');
          if (command === 'exit') state.status = 'closed';
          else if (command === 'laptop') state.owner = 'laptop';
          else if (command === 'pwd') await output('C:\\Demo\r\n');
          else if (command === 'history') await output('Command recall stays in phone memory only.\r\n');
          else if (command === 'stream') {
            for (let i = 1; i <= 80; i++) await output(`Output line ${i}\r\n`);
          } else if (command.startsWith('echo ')) await output(`${command.slice(5)}\r\n`);
          else if (command) await output(`Demo received: ${command}\r\n`);
          if (state.status === 'open') await output('PS C:\\Demo> ');
        } else if (character >= ' ') {
          input += character;
          await output(character);
        }
      }
    }
    if (request.action === 'open' || request.action === 'attach') {
      const result = prepareSnapshot();
      if (!result.ok) {
        await station.send(terminalState({ ...state, status: 'error', error: result.error }));
        return;
      }
      screen = result.snapshot.data;
      truncated = result.snapshot.truncated;
      await station.send(terminalState({ ...state }));
      await station.send(terminalSnapshot(result.snapshot));
    } else {
      await station.send(terminalState({ ...state }));
    }
  };
  let requests = Promise.resolve();
  const unsubscribe = station.onEvent(EVENT_TYPE.CONTROL, (message) => {
    if (message.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST_REQUEST) {
      void station.send(projectList([], 'Demo laptop', undefined, [DEVICE_CAPABILITY.TERMINAL_V1]));
    } else if (message.eventSubtype === SUBTYPE.CONTROL.TERMINAL_REQUEST) {
      requests = requests.then(() => handle(message.msg as TerminalRequestMsg));
    }
  });
  return {
    client, pairing,
    async stop(): Promise<void> {
      unsubscribe();
      await requests;
      await station.close();
      await client.close();
    },
  };
}

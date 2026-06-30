import {
  EVENTS,
  SecureChannel,
  _resetLocalBus,
  approvalRequest,
  assistantDelta,
  assistantMessage,
  buildPairingPayload,
  createLocalTransport,
  generateKeyPair,
  heartbeat,
  logLine,
  modeChange,
  randomChannelId,
  sessionEnd,
  sessionStart,
  toolComplete,
  toolStart,
  waitForPeer,
} from '@aasis21/helm-shared';
import type { ApprovalDecision, ModeChange, PromptMessage } from '@aasis21/helm-shared';
import { pairFromQr } from './helmClient';
import type { HelmClient } from './helmClient';

export interface DemoSession {
  client: HelmClient;
  pairingJson: string;
  stop(): Promise<void>;
}

export async function startDemoSession(): Promise<DemoSession> {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptopKeys = await generateKeyPair();
  const laptopTransport = createLocalTransport({ channelId });
  const laptopPeer = waitForPeer({
    transport: laptopTransport,
    keyPair: laptopKeys,
    timeoutMs: 10_000,
  });
  const pairingPayload = buildPairingPayload({ channelId, publicKeyB64: laptopKeys.publicKeyB64 });
  const client = await pairFromQr(JSON.stringify(pairingPayload));
  const { key: laptopKey } = await laptopPeer;
  const extension = new SecureChannel({
    transport: laptopTransport,
    key: laptopKey,
    identity: { deviceId: 'demo-laptop', sessionId: 'demo-session' },
  });
  await extension.connect();

  const timers: number[] = [];
  const push = (delay: number, action: () => void | Promise<void>): void => {
    timers.push(window.setTimeout(() => void action(), delay));
  };

  const unsubs = [
    extension.onEvent(EVENTS.PROMPT, (message) => {
      const prompt = message as PromptMessage;
      void extension.send(logLine('info', `Prompt injected from phone: "${prompt.text}"`));
      void extension.send(assistantMessage(`Queued your instruction: ${prompt.text}`, 'demo-ack'));
    }),
    extension.onEvent(EVENTS.DECISION, (message) => {
      const decision = message as ApprovalDecision;
      void extension.send(logLine('info', `Permission ${decision.requestId}: ${decision.optionId}`));
      void extension.send(toolComplete('tool-1', 'powershell', decision.optionId !== 'deny', 'native decision relayed'));
    }),
    extension.onEvent(EVENTS.CONTROL, (message) => {
      const control = message as ModeChange;
      if (control.kind === 'control.mode') {
        void extension.send(modeChange(control.mode));
        void extension.send(logLine('info', `Session mode changed to ${control.mode}`));
      }
    }),
  ];

  const heartbeatTimer = window.setInterval(() => void extension.send(heartbeat()), 2_500);
  push(100, () => extension.send(sessionStart(channelId, 'demo-session', 'C:\\Users\\akash\\helm')));
  push(450, () => extension.send(logLine('info', 'Encrypted LocalTransport linked; relay sees envelopes only.')));
  push(900, () => extension.send(assistantMessage('I am watching the live gh copilot session.', 'demo-1')));
  push(1_500, () => extension.send(assistantDelta(' Tool calls and token deltas now appear on your phone.', 'demo-1')));
  push(2_200, () => extension.send(toolStart('tool-1', 'powershell', { command: 'npm run build -w @aasis21/helm-mobile' })));
  push(3_200, () =>
    extension.send(
      approvalRequest('approval-1', 'powershell', { command: 'gh copilot suggest "fix failing test"' }, [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'allow-always', label: 'Always allow this session' },
        { id: 'deny', label: 'Deny' },
      ]),
    ),
  );
  push(60_000, () => extension.send(sessionEnd('Demo script finished.')));

  return {
    client,
    pairingJson: JSON.stringify(pairingPayload),
    async stop() {
      window.clearInterval(heartbeatTimer);
      for (const timer of timers) window.clearTimeout(timer);
      for (const unsub of unsubs) unsub();
      await extension.close();
      await client.close();
    },
  };
}

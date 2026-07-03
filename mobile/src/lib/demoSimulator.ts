import {
  EVENT_TYPE,
  SUBTYPE,
  SecureChannel,
  _resetLocalBus,
  activity,
  approvalRequest,
  assistantMessage,
  buildPairingPayload,
  createLocalTransport,
  elicitationComplete,
  elicitationRequest,
  generateKeyPair,
  heartbeat,
  history,
  logLine,
  modeChange,
  randomChannelId,
  channelDown,
  channelUp,
  toolComplete,
  toolStart,
  userMessage,
  waitForPeer,
} from '@aasis21/helm-shared';
import type { ApprovalDecision, ElicitationResponse, ModeChange, PromptMessage } from '@aasis21/helm-shared';
import { pairSession } from './helmClient';
import type { HelmClient } from './helmClient';

export interface DemoSession {
  client: HelmClient;
  channelId: string;
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
  // The Demo/Simulator runs entirely in-process: force the phone side onto the same
  // in-memory LocalTransport bus as the simulated laptop, regardless of the build's
  // VITE_HELM_TRANSPORT (which may be `supabase` for real pairing).
  const phoneTransport = createLocalTransport({ channelId });
  const { client } = await pairSession(JSON.stringify(pairingPayload), { transport: phoneTransport });
  const { key: laptopKey } = await laptopPeer;
  const extension = new SecureChannel({
    transport: laptopTransport,
    key: laptopKey,
    identity: { channelId, sessionId: 'demo-session', senderId: 'copilot', senderName: 'Copilot' },
  });
  await extension.connect();

  const timers: number[] = [];
  // Tracks which scripted tool is mid-run so a phone "interrupt" can end the right card.
  let runningToolId: string | null = null;
  const push = (delay: number, action: () => void | Promise<void>): void => {
    timers.push(window.setTimeout(() => void action(), delay));
  };

  const unsubs = [
    extension.onEvent(EVENT_TYPE.PROMPT, (message) => {
      const prompt = message as PromptMessage;
      void extension.send(logLine('info', `Prompt injected from phone: "${prompt.msg.text}"`));
      void extension.send(assistantMessage(`Queued your instruction: ${prompt.msg.text}`, 'demo-ack'));
    }),
    extension.onEvent(EVENT_TYPE.DECISION, (message) => {
      const decision = message as ApprovalDecision;
      void extension.send(logLine('info', `Permission ${decision.msg.requestId}: ${decision.msg.optionId}`));
      void extension.send(toolComplete('tool-1', 'powershell', decision.msg.optionId !== 'deny', 'native decision relayed'));
    }),
    extension.onEvent(EVENT_TYPE.ELICITATION_RESPONSE, (message) => {
      // The phone answered the ask_user form: dismiss it everywhere, then have the "agent"
      // react so the demo shows the round-trip (this is what respondToElicitation does live).
      const reply = message as ElicitationResponse;
      void extension.send(elicitationComplete(reply.msg.requestId, reply.msg.action));
      if (reply.msg.action === 'accept') {
        const target = String(reply.msg.content?.environment ?? 'staging');
        void extension.send(logLine('info', `ask_user answered: deploy → ${target}`));
        void extension.send(activity(true));
        void extension.send(
          assistantMessage(`Got it — deploying to **${target}**. Kicking off the pipeline now.`, 'demo-elicit-ack'),
        );
        window.setTimeout(() => void extension.send(activity(false)), 900);
      } else {
        void extension.send(logLine('warning', `ask_user ${reply.msg.action}ed — holding off on the deploy.`));
      }
    }),
    extension.onEvent(EVENT_TYPE.CONTROL, (message) => {
      if (message.eventSubtype === SUBTYPE.CONTROL.MODE) {
        const control = message as ModeChange;
        void extension.send(modeChange(control.msg.mode));
        void extension.send(logLine('info', `Session mode changed to ${control.msg.mode}`));
        return;
      }
      if (message.eventSubtype === SUBTYPE.CONTROL.INTERRUPT) {
        // Make the phone's Stop button visibly take effect: end the turn (busy=false)
        // and any running tool, then ack. busy=false hides Stop even mid text-stream.
        void extension.send(activity(false));
        if (runningToolId) {
          const name = runningToolId === 'tool-1' ? 'powershell' : 'view';
          void extension.send(toolComplete(runningToolId, name, false, '■ interrupted by user'));
          runningToolId = null;
        }
        void extension.send(logLine('warning', '■ Generation stopped by user (interrupt relayed).'));
      }
    }),
  ];

  const heartbeatTimer = window.setInterval(() => void extension.send(heartbeat()), 2_500);
  push(100, () => extension.send(channelUp('/home/user/my-project', 'Demo session')));
  // Backfilled pre-join history (what happened before this phone "joined") — rendered
  // above the live stream under an "Earlier in this session" divider.
  push(250, () =>
    extension.send(
      history(
        [
          { turnIndex: 0, role: 'user', text: 'Earlier: what is Helm again?', ts: Date.now() - 600_000 },
          {
            turnIndex: 0,
            role: 'assistant',
            text: 'Helm mirrors your live `copilot` terminal session to your phone over an E2E-encrypted relay.',
            ts: Date.now() - 599_000,
          },
        ],
        null,
        false,
      ),
    ),
  );
  push(450, () => extension.send(logLine('info', 'Encrypted LocalTransport linked; relay sees envelopes only.')));
  // The turn begins: the agent starts generating text (no tool yet). This is exactly the
  // window the old Stop button missed — busy=true makes Stop appear during text streaming.
  push(600, () => extension.send(activity(true)));
  push(900, () =>
    extension.send(
      assistantMessage(
        "Hi — I'm your live `copilot` session, mirrored to your phone. Let me check the mobile build.",
        'demo-1',
      ),
    ),
  );
  push(1_700, () => {
    runningToolId = 'tool-1';
    void extension.send(toolStart('tool-1', 'powershell', { command: 'npm run build -w @aasis21/helm-mobile' }));
  });
  // A prompt typed at the LAPTOP terminal (origin 'terminal'), relayed so the phone's
  // transcript isn't missing the user side of terminal-driven turns. Shows a "Laptop" chip.
  push(2_400, () =>
    extension.send(userMessage('Did that build pass on the laptop?', 'terminal', 'demo-terminal-1')),
  );
  push(3_400, () => {
    if (runningToolId !== 'tool-1') return; // user already interrupted it
    runningToolId = null;
    void extension.send(toolComplete('tool-1', 'powershell', true, 'vite build ✓  104 modules transformed · dist/ ready in 1.21s'));
  });
  push(3_900, () =>
    extension.send(
      assistantMessage(
        "Build is green. Here's the gist of what changed:\n\n- Ported the **Anya** chat skin into Helm\n- Tool calls now render **inline**, collapsed by default\n- User prompts sit on the right, like a real chat\n\n```ts\nexport const shipped = true;\n```",
        'demo-2',
      ),
    ),
  );
  push(5_400, () => {
    runningToolId = 'tool-2';
    void extension.send(toolStart('tool-2', 'view', { path: 'mobile/src/App.tsx' }));
  });
  push(6_600, () => {
    if (runningToolId !== 'tool-2') return; // user already interrupted it
    runningToolId = null;
    void extension.send(toolComplete('tool-2', 'view', true, 'read 204 lines'));
    // The agent's loop goes idle here (next it just waits for the approval decision).
    void extension.send(activity(false));
  });
  push(7_200, () =>
    extension.send(
      approvalRequest('approval-1', 'powershell', { command: 'npm test' }, [
        { id: 'allow-once', label: 'Allow once' },
        { id: 'allow-always', label: 'Always allow this session' },
        { id: 'deny', label: 'Deny' },
      ]),
    ),
  );
  // The agent then asks a structured question (ask_user / elicitation) — answerable right on
  // the phone thanks to #64. Showcases select + toggle + free-text fields.
  push(8_600, () =>
    extension.send(
      elicitationRequest(
        'elicit-1',
        'Tests pass. Where should I deploy this build?',
        'form',
        {
          type: 'object',
          properties: {
            environment: {
              type: 'string',
              title: 'Deploy target',
              enum: ['staging', 'production'],
              enumNames: ['Staging', 'Production'],
              default: 'staging',
            },
            runMigrations: { type: 'boolean', title: 'Run DB migrations first?', default: true },
            note: { type: 'string', title: 'Release note', description: 'Shown in the deploy log (optional).' },
          },
          required: ['environment'],
        },
        'tool-elicit-1',
      ),
    ),
  );
  push(120_000, () => extension.send(channelDown('Demo script finished.')));

  return {
    client,
    channelId,
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

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import {
  KIND,
  MODES,
  approvalDecision,
  modeChange,
  prompt,
} from '@aasis21/helm-shared';
import type {
  ApprovalRequest,
  AssistantDelta,
  AssistantMessage,
  InnerMessage,
  LogLine,
  ModeChange,
  SessionMode,
  ToolComplete,
  ToolStart,
} from '@aasis21/helm-shared';
import { PairingScreen } from './components/PairingScreen';
import { LiveStreamView } from './components/LiveStreamView';
import { startDemoSession } from './lib/demoSimulator';
import { clearStoredPairing } from './lib/storage';
import { pairFromQr, restorePairing } from './lib/helmClient';
import type { HelmClient } from './lib/helmClient';

const DEFAULT_MODE = MODES[0] as SessionMode;

export interface TranscriptItem {
  id: string;
  role: 'assistant' | 'log';
  content: string;
  level?: LogLine['level'];
  ts: number;
}

export interface ToolItem {
  id: string;
  name: string;
  args?: unknown;
  status: 'running' | 'complete';
  success?: boolean;
  resultPreview?: string;
  startedAt: number;
  completedAt?: number;
}

export interface AppState {
  transcript: TranscriptItem[];
  tools: ToolItem[];
  approvals: ApprovalRequest[];
  mode: SessionMode;
  connected: boolean;
  sessionEnded: boolean;
  lastHeartbeat: number | null;
  cwd: string | null;
}

type Action =
  | { type: 'reset' }
  | { type: 'connected' }
  | { type: 'ended' }
  | { type: 'dismiss-approval'; requestId: string }
  | { type: 'mode'; mode: SessionMode }
  | { type: 'message'; message: InnerMessage };

const initialState: AppState = {
  transcript: [],
  tools: [],
  approvals: [],
  mode: DEFAULT_MODE,
  connected: false,
  sessionEnded: false,
  lastHeartbeat: null,
  cwd: null,
};

export default function App(): JSX.Element {
  const [client, setClient] = useState<HelmClient | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [demoQr, setDemoQr] = useState<string | null>(null);
  const demoStopRef = useRef<(() => Promise<void>) | null>(null);
  const [state, dispatch] = useReducer(reducer, initialState);

  const connectClient = useCallback((nextClient: HelmClient): void => {
    setError(null);
    setClient(nextClient);
  }, []);

  useEffect(() => {
    void restorePairing()
      .then((restored) => {
        if (restored) connectClient(restored);
      })
      .catch(() => undefined);
  }, [connectClient]);

  useEffect(() => {
    if (!client) return undefined;
    const unsubscribe = client.subscribe((message) => dispatch({ type: 'message', message }));
    dispatch({ type: 'connected' });
    return unsubscribe;
  }, [client]);

  useEffect(() => {
    if (!client || state.sessionEnded) return undefined;
    const id = window.setInterval(() => {
      if (state.lastHeartbeat && Date.now() - state.lastHeartbeat > 8_000) {
        dispatch({ type: 'ended' });
      }
    }, 1_000);
    return () => window.clearInterval(id);
  }, [client, state.lastHeartbeat, state.sessionEnded]);

  const handlePair = useCallback(
    async (raw: string): Promise<void> => {
      const paired = await pairFromQr(raw);
      dispatch({ type: 'reset' });
      connectClient(paired);
    },
    [connectClient],
  );

  const handleDemo = useCallback(async (): Promise<void> => {
    await demoStopRef.current?.();
    const demo = await startDemoSession();
    demoStopRef.current = demo.stop;
    setDemoQr(demo.pairingJson);
    dispatch({ type: 'reset' });
    connectClient(demo.client);
  }, [connectClient]);

  const handleRePair = useCallback(async (): Promise<void> => {
    await demoStopRef.current?.();
    demoStopRef.current = null;
    await client?.close();
    await clearStoredPairing();
    setClient(null);
    setDemoQr(null);
    dispatch({ type: 'reset' });
  }, [client]);

  const handlePrompt = useCallback(
    async (text: string): Promise<void> => {
      await client?.send(prompt(text));
      dispatch({
        type: 'message',
        message: { kind: KIND.LOG, level: 'info', message: `You sent: ${text}`, ts: Date.now() },
      });
    },
    [client],
  );

  const handleApproval = useCallback(
    async (requestId: string, optionId: string): Promise<void> => {
      dispatch({ type: 'dismiss-approval', requestId });
      await client?.send(approvalDecision(requestId, optionId));
    },
    [client],
  );

  const handleMode = useCallback(
    async (mode: SessionMode): Promise<void> => {
      await client?.send(modeChange(mode));
    },
    [client],
  );

  if (!client) {
    return (
      <PairingScreen
        demoQr={demoQr}
        error={error}
        onError={setError}
        onPair={handlePair}
        onStartDemo={handleDemo}
      />
    );
  }

  return (
    <LiveStreamView
      channelId={client.channelId}
      state={state}
      onApprove={handleApproval}
      onModeChange={handleMode}
      onPrompt={handlePrompt}
      onRePair={handleRePair}
    />
  );
}

function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'connected':
      return { ...state, connected: true, sessionEnded: false, lastHeartbeat: Date.now() };
    case 'ended':
      return { ...state, connected: false, sessionEnded: true };
    case 'dismiss-approval':
      return { ...state, approvals: state.approvals.filter((item) => item.requestId !== action.requestId) };
    case 'mode':
      return { ...state, mode: action.mode };
    case 'message':
      return reduceMessage(state, action.message);
    default:
      return state;
  }
}

function reduceMessage(state: AppState, message: InnerMessage): AppState {
  switch (message.kind) {
    case KIND.ASSISTANT_MESSAGE:
      return upsertAssistant(state, message);
    case KIND.ASSISTANT_DELTA:
      return appendAssistantDelta(state, message);
    case KIND.TOOL_START:
      return startTool(state, message);
    case KIND.TOOL_COMPLETE:
      return completeTool(state, message);
    case KIND.LOG:
      return { ...state, transcript: [...state.transcript, logToTranscript(message)].slice(-80) };
    case KIND.APPROVAL_REQUEST:
      return {
        ...state,
        approvals: [...state.approvals.filter((item) => item.requestId !== message.requestId), message],
      };
    case KIND.SESSION_START:
      return {
        ...state,
        connected: true,
        sessionEnded: false,
        cwd: message.cwd ?? null,
        lastHeartbeat: Date.now(),
      };
    case KIND.SESSION_END:
      return {
        ...state,
        connected: false,
        sessionEnded: true,
        transcript: [...state.transcript, { id: `end-${message.ts}`, role: 'log', level: 'warning', content: message.reason ?? 'Session ended.', ts: message.ts }],
      };
    case KIND.HEARTBEAT:
      return { ...state, connected: true, sessionEnded: false, lastHeartbeat: Date.now() };
    case KIND.MODE:
      return { ...state, mode: (message as ModeChange).mode };
    case KIND.PROMPT:
    case KIND.APPROVAL_DECISION:
      return state;
    default:
      return state;
  }
}

function upsertAssistant(state: AppState, message: AssistantMessage): AppState {
  const id = message.messageId ?? `assistant-${message.ts}`;
  const next: TranscriptItem = { id, role: 'assistant', content: message.content, ts: message.ts };
  const existingIndex = state.transcript.findIndex((item) => item.id === id);
  if (existingIndex === -1) return { ...state, transcript: [...state.transcript, next].slice(-80) };
  return {
    ...state,
    transcript: state.transcript.map((item, index) => (index === existingIndex ? next : item)),
  };
}

function appendAssistantDelta(state: AppState, message: AssistantDelta): AppState {
  const id = message.messageId ?? `assistant-${message.ts}`;
  const existing = state.transcript.find((item) => item.id === id);
  if (!existing) {
    return {
      ...state,
      transcript: [...state.transcript, { id, role: 'assistant', content: message.content, ts: message.ts }].slice(-80),
    };
  }
  return {
    ...state,
    transcript: state.transcript.map((item) =>
      item.id === id ? { ...item, content: `${item.content}${message.content}`, ts: message.ts } : item,
    ),
  };
}

function startTool(state: AppState, message: ToolStart): AppState {
  const tool: ToolItem = {
    id: message.toolCallId,
    name: message.toolName,
    args: message.args,
    status: 'running',
    startedAt: message.ts,
  };
  return { ...state, tools: [...state.tools.filter((item) => item.id !== tool.id), tool].slice(-30) };
}

function completeTool(state: AppState, message: ToolComplete): AppState {
  return {
    ...state,
    tools: state.tools.map((item) =>
      item.id === message.toolCallId
        ? {
            ...item,
            status: 'complete',
            success: message.success,
            resultPreview: message.resultPreview,
            completedAt: message.ts,
          }
        : item,
    ),
  };
}

function logToTranscript(message: LogLine): TranscriptItem {
  return {
    id: `log-${message.ts}-${message.message}`,
    role: 'log',
    level: message.level,
    content: message.message,
    ts: message.ts,
  };
}

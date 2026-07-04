import { MODES } from '@aasis21/helm-shared';
import type {
  ApprovalRequestMsg,
  ElicitationRequestMsg,
  HistoryItem,
  ListenerProject,
  LogLineMsg,
  PromptAttachment,
  SessionMode,
} from '@aasis21/helm-shared';
import type { RegisteredDevice } from '@/lib/devices';

export type SessionStatus = 'initializing' | 'connecting' | 'live' | 'idle' | 'ended' | 'error';

export type ToolStatus = 'running' | 'success' | 'error';

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  ts: number;
  failed?: boolean;
  origin?: 'phone' | 'terminal';
  attachments?: PromptAttachment[];
}

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
  ts: number;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  name: string;
  args?: unknown;
  status: ToolStatus;
  resultPreview?: string;
  startedAt: number;
  finishedAt?: number;
  ts: number;
}

export interface NoticeItem {
  kind: 'notice';
  id: string;
  level: LogLineMsg['level'];
  text: string;
  ts: number;
}

export type TimelineItem = UserItem | AssistantItem | ToolItem | NoticeItem;

export type { ApprovalRequestMsg, ElicitationRequestMsg, HistoryItem, PromptAttachment, SessionMode };

export interface DebugEvent {
  id: string;
  dir: 'in' | 'out';
  eventType: string;
  eventSubtype: string;
  senderName: string;
  ts: number;
  msg: unknown;
}

export interface ChannelHistoryEntry {
  channelId: string;
  startedAt: number;
  endedAt?: number;
}

export interface SessionMeta {
  channelId: string;
  sessionId?: string;
  title: string;
  /** True once the user has renamed this session on the phone. When set, the CLI-reported title no
   *  longer overrides the user's chosen name (persisted, so it survives reload + resume). */
  renamed?: boolean;
  /** Transport channels this durable session has rotated through (a `copilot --resume` mints a new
   *  channelId). The current transport is `channelId`; superseded ones are archived here so the debug
   *  Dev-detail tab can show "this session reconnected N times" (#154). */
  channelHistory?: ChannelHistoryEntry[];
  cwd: string | null;
  kind: 'live' | 'demo' | 'spawning';
  addedAt: number;
  scannedAt?: number;
  /** Stable, non-secret `deviceId` (see extension/src/deviceIdentity.mjs) of the listener that
   *  spawned this session via "Start session", if any — lets the Device details screen list every
   *  session launched from a given laptop even across `helm-cli start` restarts. Undefined for
   *  sessions joined by scanning a session QR directly. */
  spawnedFromDeviceId?: string;
  /** Display name of the spawning device at spawn time (falls back label if it's since renamed). */
  spawnedFromDeviceName?: string;
}

export interface ListenerDeviceState extends RegisteredDevice {
  projects: ListenerProject[];
  projectsLoading: boolean;
  connected: boolean;
  error?: string;
  /** Raw wire events exchanged over the DEVICE (listener) channel — project list request/reply,
   *  spawn request/pairing/result, forget — oldest-first (DebugPanel renders them newest-first).
   *  Excludes DEVICE_HEARTBEAT (liveness is already surfaced via `connected`/`lastSeenAt`). Not
   *  persisted across app restarts; the channel itself is re-established on reconnect. */
  events: DebugEvent[];
}

export interface SessionConnection {
  status: SessionStatus;
  busy: boolean;
  busyFrom: number | null;
  mode: SessionMode;
  pendingMode?: SessionMode;
  reconnecting: boolean;
  settling: boolean;
  /** True once the session was evicted from the warm pool (subscription/socket dropped) and has no
   *  live client. Distinguishes cold-idle ("Offline — tap to connect") from warm-idle ("Quiet",
   *  socket still open) so the header and reconnect affordance stop contradicting each other. */
  cold: boolean;
  lastHeartbeat: number | null;
  ended: boolean;
  endedReason?: string;
  error?: string;
  spawning?: {
    requestId: string;
    deviceId: string;
    deviceName?: string;
    projectName: string;
  };
}

export interface SessionHistory {
  items: HistoryItem[];
  cursor: number | null;
  hasMore: boolean;
  loading: boolean;
  latestTurnIndex: number | null;
}

export interface SessionRequests {
  approvals: ApprovalRequestMsg[];
  approvalErrors: Record<string, string>;
  elicitations: ElicitationRequestMsg[];
  elicitationErrors: Record<string, string>;
}

export interface Session {
  id: string;
  meta: SessionMeta;
  unread: boolean;
  /** Number of unread host turns/events accrued while this session was NOT active. Reset to 0 on
   *  select; summed on merge. `unread` stays as the coarse boolean mirror (`unreadCount > 0`). */
  unreadCount: number;
  lastEventAt: number | null;
  /** User-pinned (#163): exempt from warm-pool eviction preference AND the 2-day auto-delete sweep.
   *  Hydrated from the persisted `StoredSession.pinned`; never auto-cleared. */
  pinned: boolean;
  transcript: { items: TimelineItem[] };
  history: SessionHistory;
  connection: SessionConnection;
  requests: SessionRequests;
  debug: DebugEvent[];
}

const DEFAULT_MODE = MODES[0] as SessionMode;

export function emptySession(id: string, meta: SessionMeta): Session {
  return {
    id,
    meta: { ...meta },
    unread: false,
    unreadCount: 0,
    lastEventAt: null,
    pinned: false,
    transcript: { items: [] },
    history: { items: [], cursor: null, hasMore: false, loading: false, latestTurnIndex: null },
    connection: {
      status: 'idle',
      busy: false,
      busyFrom: null,
      mode: DEFAULT_MODE,
      reconnecting: false,
      settling: false,
      cold: false,
      lastHeartbeat: null,
      ended: false,
    },
    requests: { approvals: [], approvalErrors: {}, elicitations: [], elicitationErrors: {} },
    debug: [],
  };
}

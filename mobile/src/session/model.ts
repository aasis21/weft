import { MODES } from '@aasis21/helm-shared';
import type {
  ApprovalRequestMsg,
  ElicitationRequestMsg,
  HistoryItem,
  LogLineMsg,
  PromptAttachment,
  SessionMode,
} from '@aasis21/helm-shared';

export type SessionStatus = 'connecting' | 'live' | 'idle' | 'ended' | 'error';

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

export interface SessionMeta {
  channelId: string;
  sessionId?: string;
  title: string;
  cwd: string | null;
  kind: 'live' | 'demo';
  addedAt: number;
  scannedAt?: number;
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

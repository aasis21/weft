// Type definitions for the Weft standardized event-envelope protocol.

import type { HistoryItem } from "./history";
import type { PairingPayload } from "./pairing";

/** Top-level event type — also the transport topic the message travels on. */
export type EventType =
  | "stream"
  | "prompt"
  | "approval"
  | "decision"
  | "elicitation"
  | "elicitation_response"
  | "control"
  | "pair";

export type SessionMode = "interactive" | "plan" | "autopilot";
export type PromptDelivery = "immediate" | "enqueue";

export type ElicitationMode = "form" | "url";
export type ElicitationAction = "accept" | "decline" | "cancel";
/** A submitted form value; matches a single JSON-Schema field's accepted types. */
export type ElicitationValue = string | number | boolean | string[];

export const EVENT_TYPE: {
  readonly STREAM: "stream";
  readonly PROMPT: "prompt";
  readonly APPROVAL: "approval";
  readonly DECISION: "decision";
  readonly ELICITATION: "elicitation";
  readonly ELICITATION_RESPONSE: "elicitation_response";
  readonly CONTROL: "control";
  readonly PAIR: "pair";
};

export const DEVICE_CAPABILITY: {
  readonly MONITOR_V1: "device-monitor-v1";
  readonly CLIPBOARD_V1: "device-clipboard-v1";
  readonly KEEP_AWAKE_V1: "device-keep-awake-v1";
};

export type DeviceUtilityCode = "ok" | "invalid-request" | "too-large" | "unsupported" | "unavailable" | "timeout" | "lease-mismatch";
export const DEVICE_UTILITY_CODES: readonly DeviceUtilityCode[];
export const CLIPBOARD_MAX_BYTES: number;
export const KEEP_AWAKE_MIN_MS: number;
export const KEEP_AWAKE_MAX_MS: number;
export function clipboardTextError(text: unknown): "invalid-request" | "too-large" | null;
export function normalizeKeepAwakeDuration(durationMs: number): number | null;

export const SUBTYPE: {
  readonly STREAM: {
    readonly ASSISTANT_MESSAGE: "assistant_message";
    readonly ASSISTANT_DELTA: "assistant_delta";
    readonly INTENT: "intent";
    readonly TOOL_START: "tool_start";
    readonly TOOL_COMPLETE: "tool_complete";
    readonly LOG: "log";
    readonly ACTIVITY: "activity";
    readonly USER_MESSAGE: "user_message";
  };
  readonly PROMPT: { readonly PROMPT: "prompt" };
  readonly APPROVAL: { readonly REQUEST: "request"; readonly COMPLETE: "complete" };
  readonly DECISION: { readonly APPROVAL_DECISION: "approval_decision" };
  readonly ELICITATION: { readonly REQUEST: "request"; readonly COMPLETE: "complete" };
  readonly ELICITATION_RESPONSE: { readonly RESPONSE: "response" };
  readonly CONTROL: {
    readonly CHANNEL_UP: "channel_up";
    readonly SESSION_META: "session_meta";
    readonly CHANNEL_DOWN: "channel_down";
    readonly HEARTBEAT: "heartbeat";
    readonly MODE: "mode";
    readonly INTERRUPT: "interrupt";
    readonly HISTORY_REQUEST: "history_request";
    readonly HISTORY: "history";
    readonly RECENT_TURNS_REQUEST: "recent_turns_request";
    readonly RECENT_TURNS: "recent_turns";
    readonly STATE_REQUEST: "state_request";
    readonly STATE_SNAPSHOT: "state_snapshot";
    readonly PROJECT_LIST_REQUEST: "project_list_request";
    readonly PROJECT_LIST: "project_list";
    readonly SPAWN_SESSION: "spawn_session";
    readonly SESSION_LIST_REQUEST: "session_list_request";
    readonly SESSION_LIST: "session_list";
    readonly RESUME_SESSION: "resume_session";
    readonly SPAWN_PAIRING: "spawn_pairing";
    readonly SPAWN_RESULT: "spawn_result";
    readonly LAUNCH_STATUS: "launch_status";
    readonly FORGET_DEVICE: "forget_device";
    readonly DEVICE_HEARTBEAT: "device_heartbeat";
    readonly DEVICE_MONITOR_START: "device_monitor_start";
    readonly DEVICE_MONITOR_STOP: "device_monitor_stop";
    readonly DEVICE_SNAPSHOT: "device_snapshot";
    readonly CLIPBOARD_READ: "clipboard_read";
    readonly CLIPBOARD_WRITE: "clipboard_write";
    readonly CLIPBOARD_RESULT: "clipboard_result";
    readonly KEEP_AWAKE_START: "keep_awake_start";
    readonly KEEP_AWAKE_STOP: "keep_awake_stop";
    readonly KEEP_AWAKE_STATUS_REQUEST: "keep_awake_status_request";
    readonly KEEP_AWAKE_STATUS: "keep_awake_status";
    readonly VOICE_MODE: "voice_mode";
    readonly INVOKE_COMMAND: "invoke_command";
    readonly SESSION_OFFERS: "session_offers";
    readonly SESSION_CLAIMED: "session_claimed";
  };
  readonly PAIR: {
    readonly HELLO: "hello";
    readonly CHALLENGE: "challenge";
    readonly PROOF: "proof";
    readonly ACK: "ack";
  };
};

export const MODES: readonly SessionMode[];

/** A native permission option, mirroring what the terminal would show. */
export interface ApprovalOption {
  id: string;
  label: string;
}

/** Identity + classification fields common to every envelope. */
export interface EnvelopeBase {
  eventType: EventType;
  eventSubtype: string;
  ts: number;
  /** Client-side receipt time (phone `Date.now()`), stamped by the mobile runtime the instant an
   *  envelope is received. NOT a wire field — never set by a sender, never transmitted. Used for
   *  phone-domain elapsed-time math (heartbeat liveness, witnessed-silence) so a skewed laptop clock
   *  in `ts` can't be compared against the phone's clock. Falls back to `ts` when absent. */
  receivedAt?: number;
  /** Stamped by SecureChannel on publish. */
  channelId?: string;
  sessionId?: string;
  senderId?: string;
  senderName?: string;
}

/** The standardized wire envelope: classification + identity + a nested type-specific `msg`. */
export interface Envelope<T extends EventType, S extends string, M> extends EnvelopeBase {
  eventType: T;
  eventSubtype: S;
  msg: M;
}

// ---- payload (`msg`) shapes ------------------------------------------------
export interface AssistantMessageMsg {
  content: string;
  messageId?: string;
}
export interface AssistantDeltaMsg {
  content: string;
  messageId?: string;
}
export interface IntentMsg {
  /** The agent's own one-line note, or null when it hasn't offered one. */
  text: string | null;
  /** True while a reasoning block is streaming. Carries no timing: the phone stamps its own
   *  clock on arrival, so a laptop/phone clock skew can never produce a nonsense duration. */
  thinking: boolean;
}
export interface ToolStartMsg {
  toolCallId: string;
  toolName: string;
  args?: unknown;
}
export interface ToolCompleteMsg {
  toolCallId: string;
  toolName: string;
  success: boolean;
  resultPreview?: string;
}
export interface LogLineMsg {
  level: "info" | "warning" | "error";
  message: string;
}
export interface ActivityMsg {
  busy: boolean;
}
export interface UserMessageMsg {
  text: string;
  origin: "phone" | "terminal";
  id?: string;
}
/** An inline image the phone user attached to a prompt (relayed as base64). */
export interface PromptAttachment {
  /** Base64-encoded image bytes (no `data:` URL prefix). */
  data: string;
  /** MIME type, e.g. "image/jpeg" or "image/png". */
  mimeType: string;
  /** Original file name, shown in the timeline and passed to the SDK as displayName. */
  name: string;
}
export interface PromptMsg {
  text: string;
  attachments?: PromptAttachment[];
  delivery?: PromptDelivery;
}
export interface ApprovalRequestMsg {
  requestId: string;
  toolName: string;
  toolArgs?: unknown;
  options: ApprovalOption[];
}
export interface ApprovalDecisionMsg {
  requestId: string;
  optionId: string;
  raw?: unknown;
}
export interface ApprovalCompleteMsg {
  requestId: string;
  /** How it resolved elsewhere: the chosen optionId or "stopped". Informational only. */
  decision?: string;
}
/** JSON Schema for a form-mode elicitation: an object whose properties are the fields. */
export interface ElicitationSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}
export interface ElicitationRequestMsg {
  requestId: string;
  message: string;
  mode: ElicitationMode;
  requestedSchema?: ElicitationSchema;
  toolCallId?: string;
  /** Present only for url-mode elicitations: a link to open on the computer. */
  url?: string;
}
export interface ElicitationResponseMsg {
  requestId: string;
  action: ElicitationAction;
  content?: Record<string, ElicitationValue>;
}
export interface ElicitationCompleteMsg {
  requestId: string;
  action?: ElicitationAction;
}
export interface ChannelUpMsg {
  cwd?: string;
  /** CLI chat summary ("title"); may be empty until the CLI derives one. */
  title?: string;
}
export interface SessionMetaMsg {
  title?: string;
  cwd?: string;
}
export interface ChannelDownMsg {
  reason?: string;
}
export interface HeartbeatMsg {
  /** Highest committed turn_index in the CLI store at beat time (forward cursor); null if unknown. */
  latestTurnIndex?: number | null;
  /** Authoritative turn-in-flight flag re-asserted each beat; null when unknown. */
  busy?: boolean | null;
}
export interface ModeChangeMsg {
  mode: SessionMode;
}
export type InterruptMsg = Record<string, never>;
export interface HistoryRequestMsg {
  /** Backward cursor: return turns OLDER than this ("load earlier"). */
  before?: number | null;
  /** Forward cursor: return turns NEWER than this, ascending (post-away catch-up). */
  since?: number | null;
  limit?: number;
}
export interface HistoryMsg {
  items: HistoryItem[];
  nextCursor: number | null;
  hasMore: boolean;
  /** Echo of the request's forward cursor: non-null => FORWARD catch-up page; null => latest/backward. */
  since?: number | null;
}
export interface RecentTurnsRequestMsg {
  /** How many trailing turns the phone wants (clamped by the extension). */
  limit?: number;
}
/** One flat message entry in a recent-turns snapshot. Like HistoryItem but carries a stable per-
 *  message `id` (assistant messageId / user event id / `seed-<turn>-<role>`) and no turnIndex. */
export interface RecentTurnItem {
  role: "user" | "assistant";
  text: string;
  ts: number;
  id: string;
}
export interface RecentTurnsMsg {
  /** Ascending (chronological) message entries for the last N turns the extension knows. */
  items: RecentTurnItem[];
}
export type StateRequestMsg = Record<string, never>;
export interface StateSnapshotMsg {
  /** A turn is in flight (agent working). */
  busy: boolean;
  /** The in-flight work can be stopped (drives the Stop control at connect time). */
  abortable: boolean;
  /** Current session mode, or null when unknown. */
  mode: SessionMode | null;
  /** Highest committed turn_index in the store (the phone's forward cursor); null if none. */
  latestTurnIndex: number | null;
  /** Pending approval prompt payloads to (re)render. */
  approvals: ApprovalRequestMsg[];
  /** Pending ask_user / elicitation prompt payloads to (re)render. */
  elicitations: ElicitationRequestMsg[];
}
/** The pre-key pairing hello carries public metadata plus an ECDH-sealed bearer proof. */
export interface PairHelloMsg {
  v: number;
  pub: string;
  nonce?: string;
  auth?: {
    iv: string;
    ciphertext: string;
  };
}
export interface PairAckMsg {
  v: number;
  ok: boolean;
  nonce?: string;
}

// ---- payload shapes: phone-launched sessions (#156) ------------------------
export type SpawnMode = "default" | "allow-all";
/** One registered project a `weft` listener can spawn a session in. */
export interface ListenerProject {
  name: string;
  /** Absolute path (informational for the phone; selection is by `name`). */
  path: string;
  isDefault?: boolean;
}
export type ProjectListRequestMsg = Record<string, never>;
export interface ProjectListMsg {
  projects: ListenerProject[];
  /** The listener machine's display name, or null. */
  deviceName: string | null;
  /** Stable, non-secret device id persisted across `weft start` restarts, or null. */
  deviceId?: string | null;
  /** Optional additive protocol features supported by this listener. */
  capabilities?: string[];
}
export interface SpawnSessionMsg {
  requestId: string;
  projectName: string;
  mode: SpawnMode;
  name: string | null;
}
/** One recent resumable CLI session the phone can offer in its "Resume a session" list. */
export interface StoredSession {
  /** CLI session UUID — passed back to resumeSession() and used to dedupe already-live cards. */
  sessionId: string;
  /** CLI-derived chat summary, or null (the phone falls back to the cwd basename). */
  title: string | null;
  /** Absolute working directory the resumed session is spawned in (guaranteed to exist at list time). */
  cwd: string;
  /** Repository this session's cwd belongs to, or null when unknown. */
  repository: string | null;
  /** Branch checked out at the session's cwd, or null when unknown. */
  branch: string | null;
  /** Epoch ms of the session's last activity (store `updated_at`), or null when unparseable. */
  updatedAt: number | null;
}
export interface SessionListRequestMsg {
  /** Optional page size; clamped by the listener to SESSION_LIST_MAX. */
  limit?: number;
  /** Optional folder to restrict the query to, applied before the page size so a busy folder's
   *  history isn't hidden behind newer sessions from elsewhere on the machine. */
  cwd?: string;
}
/** Whole-store session count for one working directory. */
export interface SessionFolder {
  cwd: string;
  count: number;
  updatedAt: number | null;
}
export interface SessionListMsg {
  sessions: StoredSession[];
  /** Per-folder totals across the entire store, independent of the capped `sessions` page. Absent
   *  from listeners that predate it. */
  folders?: SessionFolder[];
}
export interface ResumeSessionMsg {
  requestId: string;
  /** CLI session UUID from StoredSession.sessionId. */
  sessionId: string;
  mode: SpawnMode;
  /** Close an already-attached session and resume anyway — the user's explicit second tap, used
   *  when weft on the laptop has wedged and resuming is the only way back. */
  force?: boolean;
}
export interface SpawnPairingMsg {
  requestId: string;
  payload: PairingPayload;
  name: string | null;
  projectName: string | null;
}
export interface SpawnResultMsg {
  requestId: string;
  ok: boolean;
  error: string | null;
}
export type LaunchState =
  | "accepted"
  | "launched"
  | "ready"
  | "failed"
  | "claimed"
  | "abandoned"
  | "superseded";
export const LAUNCH_STATES: readonly LaunchState[];
export interface LaunchStatusMsg {
  requestId: string;
  state: LaunchState;
  payload?: PairingPayload;
  operation?: "new" | "resume";
  projectName?: string;
  sessionId?: string;
  name?: string;
  error?: string;
  createdAt?: number;
  launchedAt?: number;
  readyAt?: number;
  pid?: number;
}
export type ForgetDeviceMsg = Record<string, never>;
/** Liveness beat for the DEVICE channel; deviceId mirrors ProjectListMsg.deviceId. */
export interface DeviceHeartbeatMsg {
  deviceId: string | null;
}
export interface DeviceMonitorStartMsg {
  monitorId: string;
  intervalMs?: number;
  leaseMs?: number;
}
export interface DeviceMonitorStopMsg {
  monitorId: string;
}
export interface ClipboardReadMsg { requestId: string; }
export interface ClipboardWriteMsg { requestId: string; text: string; }
export interface ClipboardResultMsg {
  requestId: string;
  operation: "read" | "write";
  code: DeviceUtilityCode;
  /** Present only for a successful explicit read. Never log or persist. */
  text?: string;
}
export interface KeepAwakeStartMsg { requestId: string; leaseId: string; durationMs: number; }
export interface KeepAwakeStopMsg { requestId: string; leaseId: string; }
export interface KeepAwakeStatusRequestMsg { requestId: string; }
export interface KeepAwakeStatusMsg {
  /** Null for unsolicited expiry/failure status. */
  requestId: string | null;
  leaseId: string | null;
  active: boolean;
  expiresAt: number | null;
  /** Station-local monotonic state revision, reset on reconnect. */
  revision: number;
  code: DeviceUtilityCode;
}
export interface DeviceSystemSnapshot {
  cpuPercent: number | null;
  memoryUsedBytes: number | null;
  memoryTotalBytes: number | null;
  uptimeSeconds: number | null;
  diskUsedBytes: number | null;
  diskTotalBytes: number | null;
  batteryPercent: number | null;
  batteryCharging: boolean | null;
  /** Omitted by older stations and caches. */
  onAcPower?: boolean | null;
}
export interface RunningApplication {
  id: string;
  name: string;
  processCount: number;
  windowCount: number;
  memoryBytes: number | null;
}
export interface DeviceSnapshotIssue {
  component: "system" | "disk" | "battery" | "apps";
  code: "unavailable" | "timeout";
}
export interface DeviceSnapshotObservedAt {
  system: number | null;
  disk: number | null;
  battery: number | null;
  apps: number | null;
}
export interface DeviceSnapshotMsg {
  schemaVersion: 1;
  monitorId: string;
  sequence: number;
  capturedAt: number;
  effectiveIntervalMs: number | null;
  leaseExpiresAt: number | null;
  system: DeviceSystemSnapshot;
  apps: RunningApplication[];
  observedAt: DeviceSnapshotObservedAt;
  issues: DeviceSnapshotIssue[];
}
export interface VoiceModeMsg {
  active: boolean;
}
/** Phone -> ext: invoke a whitelisted CLI slash command on the laptop session. */
export interface InvokeCommandMsg {
  /** Command name, no leading slash (e.g. "rename"); re-validated against the whitelist. */
  name: string;
  /** Optional free-text argument after the command name. */
  input?: string;
}
/** A single in-session `/weft` session advertised to the paired phone for digital adoption. */
export interface SessionOffer {
  /** The offered session's own SESSION channel id (also inside `payload`); the phone's dedupe key. */
  channelId: string;
  /** Friendly session label (CLI title / cwd basename), or null. */
  name: string | null;
  /** Working directory of the offered session, or null. */
  cwd: string | null;
  /** buildPairingPayload() result for the offered session, consumed like SpawnPairingMsg.payload. */
  payload: PairingPayload;
}
/** Listener -> phone: the set of `/weft` sessions currently waiting to be adopted by this phone. */
export interface SessionOffersMsg {
  offers: SessionOffer[];
}
/** Phone -> listener: the phone adopted an offered session; the station drops it from pending. */
export interface SessionClaimedMsg {
  channelId: string;
  /** Present when claiming a phone-launched New/Resume operation. */
  requestId?: string;
}

// ---- concrete envelope types (eventType + eventSubtype + typed msg) --------
export type AssistantMessage = Envelope<"stream", "assistant_message", AssistantMessageMsg>;
export type AssistantDelta = Envelope<"stream", "assistant_delta", AssistantDeltaMsg>;
export type Intent = Envelope<"stream", "intent", IntentMsg>;
export type ToolStart = Envelope<"stream", "tool_start", ToolStartMsg>;
export type ToolComplete = Envelope<"stream", "tool_complete", ToolCompleteMsg>;
export type LogLine = Envelope<"stream", "log", LogLineMsg>;
export type ActivityMessage = Envelope<"stream", "activity", ActivityMsg>;
export type UserMessageEcho = Envelope<"stream", "user_message", UserMessageMsg>;
export type PromptMessage = Envelope<"prompt", "prompt", PromptMsg>;
export type ApprovalRequest = Envelope<"approval", "request", ApprovalRequestMsg>;
export type ApprovalDecision = Envelope<"decision", "approval_decision", ApprovalDecisionMsg>;
export type ApprovalComplete = Envelope<"approval", "complete", ApprovalCompleteMsg>;
export type ElicitationRequest = Envelope<"elicitation", "request", ElicitationRequestMsg>;
export type ElicitationComplete = Envelope<"elicitation", "complete", ElicitationCompleteMsg>;
export type ElicitationResponse = Envelope<"elicitation_response", "response", ElicitationResponseMsg>;
export type ChannelUp = Envelope<"control", "channel_up", ChannelUpMsg>;
export type SessionMeta = Envelope<"control", "session_meta", SessionMetaMsg>;
export type ChannelDown = Envelope<"control", "channel_down", ChannelDownMsg>;
export type Heartbeat = Envelope<"control", "heartbeat", HeartbeatMsg>;
export type ModeChange = Envelope<"control", "mode", ModeChangeMsg>;
export type InterruptMessage = Envelope<"control", "interrupt", InterruptMsg>;
export type HistoryRequest = Envelope<"control", "history_request", HistoryRequestMsg>;
export type History = Envelope<"control", "history", HistoryMsg>;
export type RecentTurnsRequest = Envelope<"control", "recent_turns_request", RecentTurnsRequestMsg>;
export type RecentTurns = Envelope<"control", "recent_turns", RecentTurnsMsg>;
export type StateRequest = Envelope<"control", "state_request", StateRequestMsg>;
export type StateSnapshot = Envelope<"control", "state_snapshot", StateSnapshotMsg>;
export type ProjectListRequest = Envelope<"control", "project_list_request", ProjectListRequestMsg>;
export type ProjectListMessage = Envelope<"control", "project_list", ProjectListMsg>;
export type SpawnSessionMessage = Envelope<"control", "spawn_session", SpawnSessionMsg>;
export type SessionListRequest = Envelope<"control", "session_list_request", SessionListRequestMsg>;
export type SessionListMessage = Envelope<"control", "session_list", SessionListMsg>;
export type ResumeSessionMessage = Envelope<"control", "resume_session", ResumeSessionMsg>;
export type SpawnPairing = Envelope<"control", "spawn_pairing", SpawnPairingMsg>;
export type SpawnResult = Envelope<"control", "spawn_result", SpawnResultMsg>;
export type LaunchStatusMessage = Envelope<"control", "launch_status", LaunchStatusMsg>;
export type ForgetDevice = Envelope<"control", "forget_device", ForgetDeviceMsg>;
export type DeviceHeartbeat = Envelope<"control", "device_heartbeat", DeviceHeartbeatMsg>;
export type DeviceMonitorStart = Envelope<"control", "device_monitor_start", DeviceMonitorStartMsg>;
export type DeviceMonitorStop = Envelope<"control", "device_monitor_stop", DeviceMonitorStopMsg>;
export type DeviceSnapshot = Envelope<"control", "device_snapshot", DeviceSnapshotMsg>;
export type ClipboardRead = Envelope<"control", "clipboard_read", ClipboardReadMsg>;
export type ClipboardWrite = Envelope<"control", "clipboard_write", ClipboardWriteMsg>;
export type ClipboardResult = Envelope<"control", "clipboard_result", ClipboardResultMsg>;
export type KeepAwakeStart = Envelope<"control", "keep_awake_start", KeepAwakeStartMsg>;
export type KeepAwakeStop = Envelope<"control", "keep_awake_stop", KeepAwakeStopMsg>;
export type KeepAwakeStatusRequest = Envelope<"control", "keep_awake_status_request", KeepAwakeStatusRequestMsg>;
export type KeepAwakeStatus = Envelope<"control", "keep_awake_status", KeepAwakeStatusMsg>;
export type VoiceModeMessage = Envelope<"control", "voice_mode", VoiceModeMsg>;
export type InvokeCommandMessage = Envelope<"control", "invoke_command", InvokeCommandMsg>;
export type SessionOffersMessage = Envelope<"control", "session_offers", SessionOffersMsg>;
export type SessionClaimedMessage = Envelope<"control", "session_claimed", SessionClaimedMsg>;
export type PairHello = Envelope<"pair", "hello", PairHelloMsg>;
export type PairAck = Envelope<"pair", "ack", PairAckMsg>;

/** The discriminated union of every encrypted (post-pairing) envelope. */
export type EventEnvelope =
  | AssistantMessage
  | AssistantDelta
  | Intent
  | ToolStart
  | ToolComplete
  | LogLine
  | ActivityMessage
  | UserMessageEcho
  | PromptMessage
  | ApprovalRequest
  | ApprovalComplete
  | ApprovalDecision
  | ElicitationRequest
  | ElicitationResponse
  | ElicitationComplete
  | ChannelUp
  | SessionMeta
  | ChannelDown
  | Heartbeat
  | ModeChange
  | InterruptMessage
  | HistoryRequest
  | History
  | RecentTurnsRequest
  | RecentTurns
  | StateRequest
  | StateSnapshot
  | ProjectListRequest
  | ProjectListMessage
  | SpawnSessionMessage
  | SessionListRequest
  | SessionListMessage
  | ResumeSessionMessage
  | SpawnPairing
  | SpawnResult
  | LaunchStatusMessage
  | ForgetDevice
  | DeviceHeartbeat
  | DeviceMonitorStart
  | DeviceMonitorStop
  | DeviceSnapshot
  | ClipboardRead
  | ClipboardWrite
  | ClipboardResult
  | KeepAwakeStart
  | KeepAwakeStop
  | KeepAwakeStatusRequest
  | KeepAwakeStatus
  | VoiceModeMessage
  | InvokeCommandMessage
  | SessionOffersMessage
  | SessionClaimedMessage;

export function assistantMessage(content: string, messageId?: string): AssistantMessage;
export function assistantDelta(content: string, messageId?: string): AssistantDelta;
export function intent(text: string | null, thinking?: boolean): Intent;
export function toolStart(toolCallId: string, toolName: string, args?: unknown): ToolStart;
export function toolComplete(
  toolCallId: string,
  toolName: string,
  success: boolean,
  resultPreview?: string
): ToolComplete;
export function logLine(level: "info" | "warning" | "error", message: string): LogLine;
export function activity(busy: boolean): ActivityMessage;
export function userMessage(
  text: string,
  origin?: "phone" | "terminal",
  id?: string
): UserMessageEcho;
export function prompt(
  text: string,
  attachments?: PromptAttachment[] | null,
  delivery?: PromptDelivery
): PromptMessage;
export function approvalRequest(
  requestId: string,
  toolName: string,
  toolArgs: unknown,
  options: ApprovalOption[]
): ApprovalRequest;
export function approvalDecision(
  requestId: string,
  optionId: string,
  raw?: unknown
): ApprovalDecision;
export function approvalComplete(
  requestId: string,
  decision?: string
): ApprovalComplete;
export function elicitationRequest(
  requestId: string,
  message: string,
  mode: ElicitationMode | undefined,
  requestedSchema: ElicitationSchema | undefined,
  toolCallId?: string,
  url?: string
): ElicitationRequest;
export function elicitationResponse(
  requestId: string,
  action: ElicitationAction,
  content?: Record<string, ElicitationValue>
): ElicitationResponse;
export function elicitationComplete(
  requestId: string,
  action?: ElicitationAction
): ElicitationComplete;
export function channelUp(cwd?: string, title?: string): ChannelUp;
export function sessionMeta(title?: string, cwd?: string): SessionMeta;
export function channelDown(reason?: string): ChannelDown;
export function heartbeat(latestTurnIndex?: number | null, busy?: boolean | null): Heartbeat;
export function modeChange(mode: SessionMode): ModeChange;
export function interrupt(): InterruptMessage;
export function historyRequest(
  before?: number | null,
  limit?: number,
  since?: number | null
): HistoryRequest;
export function history(
  items: HistoryItem[],
  nextCursor?: number | null,
  hasMore?: boolean,
  since?: number | null
): History;
export function recentTurnsRequest(limit?: number): RecentTurnsRequest;
export function recentTurns(items: RecentTurnItem[]): RecentTurns;
export function stateRequest(): StateRequest;
export function stateSnapshot(snapshot?: {
  busy?: boolean;
  abortable?: boolean;
  mode?: SessionMode | null;
  latestTurnIndex?: number | null;
  approvals?: ApprovalRequestMsg[];
  elicitations?: ElicitationRequestMsg[];
}): StateSnapshot;
export function isValidEnvelope(env: unknown): env is EventEnvelope;

export function projectListRequest(): ProjectListRequest;
export function projectList(
  projects: ListenerProject[],
  deviceName?: string | null,
  deviceId?: string | null,
  capabilities?: string[] | null
): ProjectListMessage;
export function spawnSession(
  requestId: string,
  projectName: string,
  mode?: SpawnMode,
  name?: string | null
): SpawnSessionMessage;
export function sessionListRequest(limit?: number | null, cwd?: string | null): SessionListRequest;
export function sessionList(sessions: StoredSession[], folders?: SessionFolder[] | null): SessionListMessage;
export function resumeSession(
  requestId: string,
  sessionId: string,
  mode?: SpawnMode,
  force?: boolean
): ResumeSessionMessage;
export function spawnPairing(
  requestId: string,
  payload: PairingPayload,
  name?: string | null,
  projectName?: string | null
): SpawnPairing;
export function spawnResult(
  requestId: string,
  ok: boolean,
  error?: string | null
): SpawnResult;
export function launchStatus(
  requestId: string,
  state: LaunchState,
  details?: Omit<LaunchStatusMsg, "requestId" | "state">
): LaunchStatusMessage;
export function forgetDevice(): ForgetDevice;
export function deviceHeartbeat(deviceId?: string | null): DeviceHeartbeat;
export function deviceMonitorStart(
  monitorId: string,
  intervalMs?: number | null,
  leaseMs?: number | null
): DeviceMonitorStart;
export function deviceMonitorStop(monitorId: string): DeviceMonitorStop;
export function deviceSnapshot(snapshot: Omit<DeviceSnapshotMsg, "schemaVersion">): DeviceSnapshot;
export function clipboardRead(requestId: string): ClipboardRead;
export function clipboardWrite(requestId: string, text: string): ClipboardWrite;
export function clipboardResult(requestId: string, operation: "read" | "write", code: DeviceUtilityCode, text?: string): ClipboardResult;
export function keepAwakeStart(requestId: string, leaseId: string, durationMs: number): KeepAwakeStart;
export function keepAwakeStop(requestId: string, leaseId: string): KeepAwakeStop;
export function keepAwakeStatusRequest(requestId: string): KeepAwakeStatusRequest;
export function keepAwakeStatus(requestId: string | null, status?: Partial<Omit<KeepAwakeStatusMsg, "requestId">>): KeepAwakeStatus;
export function voiceMode(active: boolean): VoiceModeMessage;
export function invokeCommand(name: string, input?: string): InvokeCommandMessage;
export function sessionOffers(offers: SessionOffer[]): SessionOffersMessage;
export function sessionClaimed(channelId: string, requestId?: string | null): SessionClaimedMessage;

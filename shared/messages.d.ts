// Type definitions for the Weft standardized event-envelope protocol.

import type { HistoryItem } from "./history";
import type { PairingPayload } from "./pairing";
import type { SessionHealthLabel, SessionHealthObserver, SessionHealthReason } from "./sessionHealth";
import type { TransportDescriptor } from "./transport";

/**
 * Application protocol version (v3). Carried by `channel_up` and `update_required`; distinct from
 * the pairing handshake's PAIR_VERSION (still 2). No adapters: any other version gets
 * `update_required`.
 */
export const PROTOCOL_VERSION: 3;

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
  readonly TERMINAL_V1: "device-terminal-v1";
  readonly CLIPBOARD_V1: "device-clipboard-v1";
  readonly KEEP_AWAKE_V1: "device-keep-awake-v1";
  readonly SESSION_ACTIVATION_V1: "session-activation-v1";
};

export const SESSION_ACTIVATION_CAPABILITY: "session-activation-v1";
export const LIFECYCLE_RETENTION_MS: number;
export const LIFECYCLE_MESSAGE_MAX_BYTES: number;
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
    readonly WATCH_REQUEST: "watch_request";
    readonly WATCH_STATE: "watch_state";
    readonly SESSION_STATUS: "session_status";
    readonly CATCH_UP_REQUEST: "catch_up_request";
    readonly CATCH_UP_PAGE: "catch_up_page";
    readonly CHANNEL_UP: "channel_up";
    /** v3, both directions on the session link: end-to-end ready after handlers attach. */
    readonly LINK_READY: "link_ready";
    readonly WORKSPACE_REQUEST: "workspace_request";
    readonly WORKSPACE_RESULT: "workspace_result";
    readonly SESSION_META: "session_meta";
    readonly CHANNEL_DOWN: "channel_down";
    readonly HEARTBEAT: "heartbeat";
    readonly MODE: "mode";
    readonly MODEL_STATE: "model_state";
    readonly MODEL_SET: "model_set";
    readonly INTERRUPT: "interrupt";
    readonly HISTORY_REQUEST: "history_request";
    readonly HISTORY: "history";
    readonly RECENT_TURNS_REQUEST: "recent_turns_request";
    readonly RECENT_TURNS: "recent_turns";
    readonly STATE_REQUEST: "state_request";
    readonly STATE_SNAPSHOT: "state_snapshot";
    readonly PROJECT_LIST_REQUEST: "project_list_request";
    readonly PROJECT_LIST: "project_list";
    /** @deprecated pre-v3; replaced by OPEN_SESSION. Remove once extension/phone stop using it. */
    readonly SPAWN_SESSION: "spawn_session";
    readonly SESSION_LIST_REQUEST: "session_list_request";
    readonly SESSION_LIST: "session_list";
    /** @deprecated pre-v3; replaced by OPEN_SESSION. Remove once extension/phone stop using it. */
    readonly RESUME_SESSION: "resume_session";
    /** v3: target-only open request (phone -> Station). */
    readonly OPEN_SESSION: "open_session";
    readonly LIFECYCLE_STATUS_REQUEST: "lifecycle_status_request";
    /** v3: `{ requestId, revision, stage, outcome, reason, result }` (Station -> phone). */
    readonly LIFECYCLE_STATUS: "lifecycle_status";
    readonly TAKEOVER_CONFIRM: "takeover_confirm";
    readonly LIFECYCLE_CANCEL: "lifecycle_cancel";
    /** v3, phone -> Station. */
    readonly SESSION_HEALTH_REQUEST: "session_health_request";
    /** v3, Station -> phone: one sessionHealth() verdict. */
    readonly SESSION_HEALTH: "session_health";
    /** v3, Station -> phone: Dev Tunnel endpoint changed. */
    readonly ENDPOINT_UPDATE: "endpoint_update";
    /** v3, either direction: explicit protocol-version mismatch notice. */
    readonly UPDATE_REQUIRED: "update_required";
    /** @deprecated pre-v3; replaced by LIFECYCLE_STATUS. */
    readonly SPAWN_PAIRING: "spawn_pairing";
    /** @deprecated pre-v3; replaced by LIFECYCLE_STATUS. */
    readonly SPAWN_RESULT: "spawn_result";
    /** @deprecated pre-v3; replaced by LIFECYCLE_STATUS. */
    readonly LAUNCH_STATUS: "launch_status";
    readonly FORGET_DEVICE: "forget_device";
    readonly DEVICE_HEARTBEAT: "device_heartbeat";
    readonly DEVICE_MONITOR_START: "device_monitor_start";
    readonly DEVICE_MONITOR_STOP: "device_monitor_stop";
    readonly DEVICE_SNAPSHOT: "device_snapshot";
    readonly TERMINAL_REQUEST: "terminal_request";
    readonly TERMINAL_STATE: "terminal_state";
    readonly TERMINAL_OUTPUT: "terminal_output";
    readonly TERMINAL_SNAPSHOT: "terminal_snapshot";
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
  /** Durable application-journal position, independent of SecureChannel sequencing. */
  streamEpoch?: string;
  streamSequence?: number;
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
  capabilities?: string[];
  cwd?: string;
  /** CLI chat summary ("title"); may be empty until the CLI derives one. */
  title?: string;
  /** Sender's PROTOCOL_VERSION; a phone on another version replies `update_required`. */
  protocolVersion?: number;
  /** v3: the session link generation (≥ 1); the phone ignores messages from older generations. */
  linkGeneration?: number;
}
/** v3 session-link readiness, sent by the extension after handlers attach and echoed by the phone. */
export interface LinkReadyMsg {
  /** ≥ 1 for a real link; malformed input is coerced to 0, which never matches. */
  linkGeneration: number;
  controllerRevision: number;
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
  capabilities?: string[];
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
export type LifecycleState =
  | "accepted"
  | "locating"
  | "reserved"
  | "activating"
  | "launching"
  | "pairing-ready"
  | "pairing"
  | "open"
  | "failed"
  | "cancelled";
export type LifecycleAction =
  | "retry"
  | "confirm-takeover"
  | "cancel"
  | "choose-session"
  | "choose-directory"
  | "update-peer";
export type LifecycleFailureCode =
  | "invalid-request"
  | "unsupported"
  | "operation-conflict"
  | "operation-stale"
  | "target-reserved"
  | "writer-conflict"
  | "controller-conflict"
  | "capability-rejected"
  | "project-not-found"
  | "session-not-found"
  | "directory-not-found"
  | "ownership-unknown"
  | "runtime-unavailable"
  | "activation-failed"
  | "identity-failed"
  | "launch-failed"
  | "launch-outcome-unknown"
  | "launch-not-recoverable"
  | "pairing-failed"
  | "takeover-stale"
  | "takeover-failed"
  | "cancelled"
  | "timeout"
  | "internal-error";
export type LifecycleOperationAction =
  | "undecided"
  | "reconnect"
  | "activate"
  | "resume"
  | "start"
  | "takeover";
/** @deprecated pre-v3 (v2 lifecycle state). Use {@link OPEN_STAGES} / {@link OPEN_OUTCOMES}. */
export const LIFECYCLE_STATES: readonly LifecycleState[];
/** @deprecated pre-v3. */
export const LIFECYCLE_ACTIONS: readonly LifecycleAction[];
/** @deprecated pre-v3. Use {@link OPEN_REASONS}. */
export const LIFECYCLE_FAILURE_CODES: readonly LifecycleFailureCode[];
/** @deprecated pre-v3 target. v3 uses {@link OpenRequestTarget}. */
export interface NewSessionTarget {
  kind: "new";
  projectName: string;
}
/** @deprecated pre-v3 target. v3 uses {@link OpenRequestTarget}. */
export interface ExistingSessionTarget {
  kind: "existing";
  storeAuthority: string | null;
  sessionId: string;
}
/** @deprecated pre-v3 target. v3 uses {@link OpenRequestTarget}. */
export type OpenTarget = NewSessionTarget | ExistingSessionTarget;
/** @deprecated pre-v3 open payload (caller could request a takeover). v3 uses {@link OpenSessionMsg}. */
export interface OpenIntentMsg {
  operationId: string;
  target: OpenTarget;
  mode: SpawnMode;
  name: string | null;
  takeoverRequested: boolean;
}
/** @deprecated pre-v3. */
export interface StructuredFailure {
  code: LifecycleFailureCode;
  actions: LifecycleAction[];
  message?: string;
  retryable?: boolean;
}
/** @deprecated pre-v3 challenge. v3 uses {@link OpenChallenge}. */
export interface TakeoverChallenge {
  challengeId: string;
  operationId: string;
  revision: number;
  storeAuthority: string | null;
  sessionId: string;
  runtimeInstanceId: string;
  generation: number;
  pid: number | null;
  processStartedAt: number | null;
  responsive: boolean;
  controllerName?: string;
}
/** @deprecated pre-v3 lifecycle snapshot (was `LifecycleStatusMsg`). Only the legacy converters use it. */
export interface LegacyLifecycleStatusMsg {
  operationId: string;
  fingerprint: string | null;
  state: LifecycleState;
  revision: number;
  target?: OpenTarget;
  action?: LifecycleOperationAction;
  payload?: PairingPayload;
  name?: string;
  failure?: StructuredFailure;
  challenge?: TakeoverChallenge;
  createdAt?: number;
  updatedAt?: number;
}

// ---- protocol v3: open requests (LLD §3.2, §4.2, §6.2) -----------------------
export type OpenStage =
  | "accepted"
  | "resolving"
  | "awaiting-confirmation"
  | "dispatching"
  | "awaiting-runtime"
  | "preparing-link";
export type OpenOutcome = "done" | "failed" | "cancelled" | "outcome-unknown";
export type OpenReason =
  | "invalid-request"
  | "not-found"
  | "owner-unknown"
  | "controller-conflict"
  | "takeover-stale"
  | "update-required"
  | "config-error"
  | "launch-failed"
  | "runtime-unavailable"
  | "link-failed"
  | "timeout"
  | "internal-error";
/** What Station chose to do. Reported in `result.action`; the phone never requests it. */
export type OpenAction = "activate" | "repair" | "resume" | "start" | "takeover";
export const OPEN_STAGES: readonly OpenStage[];
export const OPEN_OUTCOMES: readonly OpenOutcome[];
export const OPEN_REASONS: readonly OpenReason[];
export const OPEN_ACTIONS: readonly OpenAction[];
/** A new session in a registered project, or an existing saved session. */
export type OpenRequestTarget =
  | { project: string }
  | { sessionId: string; storeAuthority?: string };
export interface OpenRequestOptions {
  permissionMode: SpawnMode;
  /** Display label for the session; null when not supplied. */
  title: string | null;
}
/** v3 `open_session` payload. No `action` and no takeover flag: Station decides. */
export interface OpenSessionMsg {
  requestId: string;
  target: OpenRequestTarget;
  options: OpenRequestOptions;
}
/** Shown at `awaiting-confirmation`; confirming is bound to this runtime + controller revision. */
export interface OpenChallenge {
  challengeId: string;
  runtimeId: string;
  controllerRevision: number;
  controllerName?: string;
}
/** Whitelisted request result; unknown keys are dropped so private handoff material never leaks. */
export interface OpenResult {
  action?: OpenAction;
  sessionId?: string;
  storeAuthority?: string;
  runtimeId?: string;
  pid?: number;
  name?: string;
  /** Pairing payload for a launched/resumed session (the phone pairs without a QR). */
  payload?: PairingPayload;
  challenge?: OpenChallenge;
  /** Cancelled after dispatch: the session may still be starting on the laptop. */
  mayBeRunning?: true;
  message?: string;
}
/**
 * v3 `lifecycle_status` payload. `stage` is the latest stage reached; `outcome` is null until the
 * request ends; `reason` explains a failure or a wait (e.g. `controller-conflict` at
 * `awaiting-confirmation`). Unknown stages become "accepted" and unknown reasons "internal-error".
 */
export interface LifecycleStatusMsg {
  requestId: string;
  revision: number;
  stage: OpenStage;
  outcome: OpenOutcome | null;
  reason: OpenReason | null;
  result: OpenResult | null;
}
export interface LifecycleStatusRequestMsg {
  /** v3: renamed from `operationId`. */
  requestId: string;
}
export interface TakeoverConfirmMsg {
  /** v3: renamed from `operationId`. */
  requestId: string;
  challengeId: string;
  revision: number;
}
export interface LifecycleCancelMsg {
  /** v3: renamed from `operationId`. */
  requestId: string;
  revision?: number;
}

// ---- protocol v3: device-link health, endpoint and version notices ----------
export interface SessionHealthRequestMsg {
  sessionId: string;
}
/** Station's sessionHealth() verdict. Unknown labels arrive as "stalled", unknown reasons as null. */
export interface SessionHealthMsg {
  sessionId: string;
  label: SessionHealthLabel;
  reason: SessionHealthReason | null;
  freshAt: number | null;
  observer: SessionHealthObserver;
  runtimeId?: string;
}
export interface EndpointUpdateMsg {
  endpointRevision: number;
  /** New transport descriptor; null when the sender supplied an invalid one. */
  descriptor: TransportDescriptor | null;
}
export interface UpdateRequiredMsg {
  /** Protocol version the sender requires (defaults to PROTOCOL_VERSION). */
  minVersion: number;
  /** Version the peer advertised; null when it advertised none. */
  peerVersion: number | null;
  /** Which side must update Weft (defaults to "laptop"). */
  side: "laptop" | "phone";
}
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
  /** Permission mode this device prefers for new/resumed sessions. Older listeners omit it. */
  defaultPermissionMode?: SpawnMode;
}
export interface SpawnSessionMsg {
  requestId: string;
  projectName: string;
  mode: SpawnMode;
  name: string | null;
}
export type SessionListSort = 'activity' | 'created';
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
  /** Epoch ms of creation, absent on older stations. Null when unparseable. */
  createdAt?: number | null;
  /** A verified live Weft runtime exists. Absent on older stations or when liveness is unknown. */
  running?: boolean;
}
export interface SessionListRequestMsg {
  /** Correlates this refresh and its folder/sort scope with the reply. */
  requestId?: string;
  /** Optional page size; clamped by the listener to SESSION_LIST_MAX. */
  limit?: number;
  /** Optional folder to restrict the query to, applied before the page size so a busy folder's
   *  history isn't hidden behind newer sessions from elsewhere on the machine. */
  cwd?: string;
  /** Newest first by activity (default) or creation; applied before the page limit. */
  sort?: SessionListSort;
}
/** Whole-store session count for one working directory. */
export interface SessionFolder {
  cwd: string;
  count: number;
  updatedAt: number | null;
}
export interface SessionListMsg {
  /** Echoed request scope; optional for older listeners. */
  requestId?: string;
  cwd?: string | null;
  sort?: SessionListSort;
  /** A failed store read is distinct from a successful empty result. */
  errorCode?: 'session-store-unavailable';
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
export type TerminalAction = "open" | "attach" | "detach" | "input" | "resize" | "claim" | "close";
export type TerminalStatus = "opening" | "open" | "closed" | "error";
export type TerminalOwner = "phone" | "laptop" | null;
export interface TerminalRequestMsg {
  requestId: string;
  action: TerminalAction;
  terminalId?: string;
  projectName?: string;
  data?: string;
  /** Per-phone sequence within this terminal generation; only input consumes it. */
  inputSeq?: number;
  cols?: number;
  rows?: number;
}
export interface TerminalStateMsg {
  requestId: string | null;
  terminalId: string | null;
  status: TerminalStatus;
  shell: string | null;
  cwd: string | null;
  cols: number;
  rows: number;
  owner: TerminalOwner;
  nextInputSeq: number;
  error: string | null;
}
export interface TerminalOutputMsg {
  terminalId: string;
  seq: number;
  data: string;
}
export interface TerminalSnapshotMsg {
  terminalId: string;
  /** Last output sequence already represented by the serialized screen. */
  seq: number;
  data: string;
  cols: number;
  rows: number;
  truncated: boolean;
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
/** A model the session can switch to, with the reasoning efforts it supports (may be empty). */
export interface SessionModelOption { id: string; name: string; efforts: string[]; defaultEffort: string | null }
export interface CurrentSessionModel { modelId: string; name: string; reasoningEffort: string | null }
/** Tool approval mode: manual = ask each time, assisted = AI review, allow-all = approve everything. */
export type ApprovalMode = "manual" | "assisted" | "allow-all";
/** The session's approval mode and the modes its policy currently allows. Absent on older laptops. */
export interface SessionApprovals { mode: ApprovalMode; available: ApprovalMode[] }
export interface ModelStateMsg { current: CurrentSessionModel | null; models: SessionModelOption[]; approvals?: SessionApprovals }
export interface ModelSetMsg { modelId?: string; reasoningEffort?: string; approvalMode?: ApprovalMode }
export type ModelState = Envelope<"control", "model_state", ModelStateMsg>;
export type ModelSet = Envelope<"control", "model_set", ModelSetMsg>;
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
export type OpenSessionMessage = Envelope<"control", "open_session", OpenSessionMsg>;
export type LifecycleStatusRequest = Envelope<"control", "lifecycle_status_request", LifecycleStatusRequestMsg>;
export type LifecycleStatusMessage = Envelope<"control", "lifecycle_status", LifecycleStatusMsg>;
export type TakeoverConfirmMessage = Envelope<"control", "takeover_confirm", TakeoverConfirmMsg>;
export type LifecycleCancelMessage = Envelope<"control", "lifecycle_cancel", LifecycleCancelMsg>;
export type LinkReady = Envelope<"control", "link_ready", LinkReadyMsg>;
export type SessionHealthRequest = Envelope<"control", "session_health_request", SessionHealthRequestMsg>;
export type SessionHealthMessage = Envelope<"control", "session_health", SessionHealthMsg>;
export type EndpointUpdateMessage = Envelope<"control", "endpoint_update", EndpointUpdateMsg>;
export type UpdateRequiredMessage = Envelope<"control", "update_required", UpdateRequiredMsg>;
/** @deprecated pre-v3 shapes produced/consumed only by the legacy converters; not in EventEnvelope. */
export type LegacyOpenSessionMessage = Envelope<"control", "open_session", OpenIntentMsg>;
/** @deprecated see {@link LegacyOpenSessionMessage}. */
export type LegacyLifecycleStatusMessage = Envelope<"control", "lifecycle_status", LegacyLifecycleStatusMsg>;
export type SpawnPairing = Envelope<"control", "spawn_pairing", SpawnPairingMsg>;
export type SpawnResult = Envelope<"control", "spawn_result", SpawnResultMsg>;
export type LaunchStatusMessage = Envelope<"control", "launch_status", LaunchStatusMsg>;
export type ForgetDevice = Envelope<"control", "forget_device", ForgetDeviceMsg>;
export type DeviceHeartbeat = Envelope<"control", "device_heartbeat", DeviceHeartbeatMsg>;
export type DeviceMonitorStart = Envelope<"control", "device_monitor_start", DeviceMonitorStartMsg>;
export type DeviceMonitorStop = Envelope<"control", "device_monitor_stop", DeviceMonitorStopMsg>;
export type DeviceSnapshot = Envelope<"control", "device_snapshot", DeviceSnapshotMsg>;
export type TerminalRequest = Envelope<"control", "terminal_request", TerminalRequestMsg>;
export type TerminalState = Envelope<"control", "terminal_state", TerminalStateMsg>;
export type TerminalOutput = Envelope<"control", "terminal_output", TerminalOutputMsg>;
export type TerminalSnapshot = Envelope<"control", "terminal_snapshot", TerminalSnapshotMsg>;
export type TerminalEnvelope = TerminalRequest | TerminalState | TerminalOutput | TerminalSnapshot;
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
export const ATTENTION_CAPABILITY: "attention-v1";
export const WATCH_LEASE_MS: 60000;
export const WATCH_RENEW_MS: 20000;
export const WATCH_COOLDOWN_MS: 5000;
export type WatchLevel = "detail" | "compact" | "off";
export interface WatchMsg {
  watchId: string; level: WatchLevel; leaseMs: number;
  /** Phone's last viewed catch-up position, used to count unseen replies. */
  seenEpoch?: string | null; seenCursor?: number;
}
export interface SessionStatusMsg {
  busy: boolean; epoch: string; cursor: number; pendingApprovals: number; pendingForms: number;
  /** Assistant replies after the phone's last viewed position. */
  unseenReplies?: number;
}
export interface CatchUpRequestMsg { epoch: string | null; cursor: number; limit: number }
export interface CatchUpItem { sequence: number; message: EventEnvelope }
export interface CatchUpPageMsg {
  items: CatchUpItem[]; epoch: string; cursor: number; hasMore: boolean; gap: boolean;
}
export type WatchRequest = Envelope<"control", "watch_request", WatchMsg>;
export type WatchState = Envelope<"control", "watch_state", WatchMsg>;
export type SessionStatusMessage = Envelope<"control", "session_status", SessionStatusMsg>;
export type CatchUpRequest = Envelope<"control", "catch_up_request", CatchUpRequestMsg>;
export type CatchUpPage = Envelope<"control", "catch_up_page", CatchUpPageMsg>;
export function watchRequest(
  watchId: string, level: WatchLevel, leaseMs?: number, seenPosition?: { epoch: string | null; cursor: number } | null,
): WatchRequest;
export function watchState(watchId: string, level: WatchLevel, leaseMs: number): WatchState;
export function sessionStatus(status: SessionStatusMsg): SessionStatusMessage;
export function catchUpRequest(epoch?: string | null, cursor?: number, limit?: number): CatchUpRequest;
export function catchUpPage(items: CatchUpItem[], epoch: string, cursor: number, hasMore?: boolean, gap?: boolean): CatchUpPage;

export type EventEnvelope =
  | WatchRequest
  | WatchState
  | SessionStatusMessage
  | CatchUpRequest
  | CatchUpPage
  | import("./workspace").WorkspaceRequest
  | import("./workspace").WorkspaceResult
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
  | ModelState
  | ModelSet
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
  | OpenSessionMessage
  | LifecycleStatusRequest
  | LifecycleStatusMessage
  | TakeoverConfirmMessage
  | LifecycleCancelMessage
  | LinkReady
  | SessionHealthRequest
  | SessionHealthMessage
  | EndpointUpdateMessage
  | UpdateRequiredMessage
  | SpawnPairing
  | SpawnResult
  | LaunchStatusMessage
  | ForgetDevice
  | DeviceHeartbeat
  | DeviceMonitorStart
  | DeviceMonitorStop
  | DeviceSnapshot
  | TerminalEnvelope
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
/** `protocolVersion` is always PROTOCOL_VERSION; `linkGeneration` is included when it is ≥ 1. */
export function channelUp(
  cwd?: string,
  title?: string,
  capabilities?: string[],
  linkGeneration?: number | null
): ChannelUp;
export function linkReady(link: { linkGeneration: number; controllerRevision: number }): LinkReady;
export function sessionMeta(title?: string, cwd?: string): SessionMeta;
export function channelDown(reason?: string): ChannelDown;
export function heartbeat(latestTurnIndex?: number | null, busy?: boolean | null): Heartbeat;
export function modeChange(mode: SessionMode): ModeChange;
export function modelState(state?: { current?: CurrentSessionModel | null; models?: SessionModelOption[]; approvals?: SessionApprovals | null }): ModelState;
export function modelSet(change: { modelId?: string | null; reasoningEffort?: string | null; approvalMode?: ApprovalMode | null }): ModelSet;
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
  capabilities?: string[];
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
  capabilities?: string[] | null,
  defaultPermissionMode?: SpawnMode
): ProjectListMessage;
/** @deprecated pre-v3; replaced by openSession/lifecycleStatus. Remove once extension/phone stop using it. */
export function spawnSession(
  requestId: string,
  projectName: string,
  mode?: SpawnMode,
  name?: string | null
): SpawnSessionMessage;
export function sessionListRequest(
  limit?: number | null,
  cwd?: string | null,
  sort?: SessionListSort,
  requestId?: string | null
): SessionListRequest;
export function sessionList(
  sessions: StoredSession[],
  folders?: SessionFolder[] | null,
  scope?: { requestId?: string | null; cwd?: string | null; sort?: SessionListSort; errorCode?: 'session-store-unavailable' }
): SessionListMessage;
/** @deprecated pre-v3; replaced by openSession/lifecycleStatus. Remove once extension/phone stop using it. */
export function resumeSession(
  requestId: string,
  sessionId: string,
  mode?: SpawnMode,
  force?: boolean
): ResumeSessionMessage;
/** @deprecated pre-v3. Normalizes the v2 open payload; use {@link normalizeOpenRequest}. */
export function normalizeOpenIntent(intent?: Partial<OpenIntentMsg> & { target?: Partial<OpenTarget> }): OpenIntentMsg;
/** @deprecated pre-v3. Use {@link openRequestFingerprint}. */
export function openIntentFingerprint(intent: OpenIntentMsg | LegacyOpenSessionMessage): Promise<string>;
/** Normalize a v3 `open_session` payload: trims ids, `sessionId` wins over `project`, mode defaults to "default". */
export function normalizeOpenRequest(request?: {
  requestId?: string;
  target?: Partial<{ project: string; sessionId: string; storeAuthority: string }>;
  options?: Partial<OpenRequestOptions>;
}): OpenSessionMsg;
/** Hex sha256 over the canonical (target, options, requester); excludes `requestId`. */
export function openRequestFingerprint(
  request: OpenSessionMsg | OpenSessionMessage,
  requester?: string | null
): Promise<string>;
/** v3 (breaking): one object argument; no caller-chosen action. Throws RangeError("too-large") over 64 KiB. */
export function openSession(request: {
  requestId: string;
  target: OpenRequestTarget;
  options?: Partial<OpenRequestOptions>;
}): OpenSessionMessage;
export function lifecycleStatusRequest(requestId: string): LifecycleStatusRequest;
/** v3 (breaking): `{ requestId, revision, stage, outcome, reason, result }`. */
export function lifecycleStatus(
  status: Partial<LifecycleStatusMsg> & Pick<LifecycleStatusMsg, "requestId" | "stage">
): LifecycleStatusMessage;
export function takeoverConfirm(
  requestId: string,
  challengeId: string,
  revision: number
): TakeoverConfirmMessage;
export function lifecycleCancel(requestId: string, revision?: number | null): LifecycleCancelMessage;
/** @deprecated pre-v3 adapter; emits the v2 open payload. Remove with sessionCompatibility (W1). */
export function openSessionFromLegacy(
  message: SpawnSessionMessage | ResumeSessionMessage | EventEnvelope
): LegacyOpenSessionMessage | null;
/** @deprecated pre-v3 adapter. */
export function openSessionToLegacy(
  message: OpenIntentMsg | LegacyOpenSessionMessage
): SpawnSessionMessage | ResumeSessionMessage | null;
/** @deprecated pre-v3 adapter; emits the v2 lifecycle snapshot. */
export function lifecycleStatusFromLegacy(
  message: LaunchStatusMessage | SpawnPairing | SpawnResult | SessionClaimedMessage | EventEnvelope,
  previous?: LegacyLifecycleStatusMsg | LegacyLifecycleStatusMessage | null
): LegacyLifecycleStatusMessage | null;
/** @deprecated pre-v3 adapter. */
export function lifecycleStatusToLegacy(
  message: LegacyLifecycleStatusMsg | LegacyLifecycleStatusMessage
): Array<LaunchStatusMessage | SpawnPairing | SpawnResult>;
/** Keeps the higher `revision` for the same `requestId` (v3; previously keyed by `operationId`). */
export function latestLifecycleStatus<T extends LifecycleStatusMsg | LifecycleStatusMessage>(
  current: T | null,
  candidate: T | null
): T | null;
export function sessionHealthRequest(sessionId: string): SessionHealthRequest;
export function sessionHealthMsg(health: {
  sessionId: string;
  label: SessionHealthLabel;
  reason?: SessionHealthReason | null;
  freshAt?: number | null;
  observer?: SessionHealthObserver;
  runtimeId?: string | null;
}): SessionHealthMessage;
export function endpointUpdate(update: {
  endpointRevision: number;
  descriptor: TransportDescriptor;
}): EndpointUpdateMessage;
export function updateRequired(notice: {
  minVersion?: number;
  peerVersion?: number | null;
  side: "laptop" | "phone";
}): UpdateRequiredMessage;
/** @deprecated pre-v3; replaced by openSession/lifecycleStatus. Remove once extension/phone stop using it. */
export function spawnPairing(
  requestId: string,
  payload: PairingPayload,
  name?: string | null,
  projectName?: string | null
): SpawnPairing;
/** @deprecated pre-v3; replaced by openSession/lifecycleStatus. Remove once extension/phone stop using it. */
export function spawnResult(
  requestId: string,
  ok: boolean,
  error?: string | null
): SpawnResult;
/** @deprecated pre-v3; replaced by openSession/lifecycleStatus. Remove once extension/phone stop using it. */
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
export function terminalRequest(request: TerminalRequestMsg): TerminalRequest;
export function terminalState(state: TerminalStateMsg): TerminalState;
export function terminalOutput(output: TerminalOutputMsg): TerminalOutput;
export function terminalSnapshot(snapshot: TerminalSnapshotMsg): TerminalSnapshot;
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

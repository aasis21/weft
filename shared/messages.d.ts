// Type definitions for the Helm standardized event-envelope protocol.

import type { HistoryItem } from "./history";

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

export const SUBTYPE: {
  readonly STREAM: {
    readonly ASSISTANT_MESSAGE: "assistant_message";
    readonly ASSISTANT_DELTA: "assistant_delta";
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
  };
  readonly PAIR: { readonly HELLO: "hello"; readonly ACK: "ack" };
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
  /** How it resolved elsewhere: the chosen optionId, "timeout", or "stopped". Informational only. */
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
/** The pre-key pairing handshake payloads (plaintext; only ever carry PUBLIC keys). */
export interface PairHelloMsg {
  v: number;
  pub: string;
}
export interface PairAckMsg {
  v: number;
  ok: boolean;
}

// ---- concrete envelope types (eventType + eventSubtype + typed msg) --------
export type AssistantMessage = Envelope<"stream", "assistant_message", AssistantMessageMsg>;
export type AssistantDelta = Envelope<"stream", "assistant_delta", AssistantDeltaMsg>;
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
export type PairHello = Envelope<"pair", "hello", PairHelloMsg>;
export type PairAck = Envelope<"pair", "ack", PairAckMsg>;

/** The discriminated union of every encrypted (post-pairing) envelope. */
export type EventEnvelope =
  | AssistantMessage
  | AssistantDelta
  | ToolStart
  | ToolComplete
  | LogLine
  | ActivityMessage
  | UserMessageEcho
  | PromptMessage
  | ApprovalRequest
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
  | StateSnapshot;

export function assistantMessage(content: string, messageId?: string): AssistantMessage;
export function assistantDelta(content: string, messageId?: string): AssistantDelta;
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
export function prompt(text: string, attachments?: PromptAttachment[] | null): PromptMessage;
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

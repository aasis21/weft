// Type definitions for Helm shared message protocol.

import type { HistoryItem } from "./history";

export type LogicalEvent =
  | "stream"
  | "prompt"
  | "approval"
  | "decision"
  | "elicitation"
  | "elicitation_response"
  | "control";

export type SessionMode = "interactive" | "plan" | "autopilot";

export type ElicitationMode = "form" | "url";
export type ElicitationAction = "accept" | "decline" | "cancel";
/** A submitted form value; matches a single JSON-Schema field's accepted types. */
export type ElicitationValue = string | number | boolean | string[];

export const EVENTS: {
  readonly STREAM: "stream";
  readonly PROMPT: "prompt";
  readonly APPROVAL: "approval";
  readonly DECISION: "decision";
  readonly ELICITATION: "elicitation";
  readonly ELICITATION_RESPONSE: "elicitation_response";
  readonly CONTROL: "control";
};

export const KIND: {
  readonly ASSISTANT_MESSAGE: "assistant.message";
  readonly ASSISTANT_DELTA: "assistant.delta";
  readonly TOOL_START: "tool.start";
  readonly TOOL_COMPLETE: "tool.complete";
  readonly LOG: "log";
  readonly ACTIVITY: "stream.activity";
  readonly USER_MESSAGE: "stream.user_message";
  readonly PROMPT: "prompt";
  readonly APPROVAL_REQUEST: "approval.request";
  readonly APPROVAL_DECISION: "approval.decision";
  readonly ELICITATION_REQUEST: "elicitation.request";
  readonly ELICITATION_RESPONSE: "elicitation.response";
  readonly ELICITATION_COMPLETE: "elicitation.complete";
  readonly SESSION_START: "control.session_start";
  readonly SESSION_META: "control.session_meta";
  readonly SESSION_END: "control.session_end";
  readonly HEARTBEAT: "control.heartbeat";
  readonly MODE: "control.mode";
  readonly INTERRUPT: "control.interrupt";
  readonly HISTORY_REQUEST: "control.history_request";
  readonly HISTORY: "control.history";
  readonly STATE_REQUEST: "control.state_request";
  readonly STATE_SNAPSHOT: "control.state_snapshot";
};

export const MODES: readonly SessionMode[];

/** A native permission option, mirroring what the terminal would show. */
export interface ApprovalOption {
  id: string;
  label: string;
}

export interface BaseMessage {
  kind: string;
  ts: number;
  /** Injected by SecureChannel on publish. */
  userId?: string;
  deviceId?: string;
  sessionId?: string;
}

export interface AssistantMessage extends BaseMessage {
  kind: "assistant.message";
  content: string;
  messageId?: string;
}
export interface AssistantDelta extends BaseMessage {
  kind: "assistant.delta";
  content: string;
  messageId?: string;
}
export interface ToolStart extends BaseMessage {
  kind: "tool.start";
  toolCallId: string;
  toolName: string;
  args?: unknown;
}
export interface ToolComplete extends BaseMessage {
  kind: "tool.complete";
  toolCallId: string;
  toolName: string;
  success: boolean;
  resultPreview?: string;
}
export interface LogLine extends BaseMessage {
  kind: "log";
  level: "info" | "warning" | "error";
  message: string;
}
/** Ext -> phone: true while a turn is in flight (generating/acting), false when idle. */
export interface ActivityMessage extends BaseMessage {
  kind: "stream.activity";
  busy: boolean;
}
/** A user prompt echoed from the laptop to the phone, attributed by device. */
export interface UserMessageEcho extends BaseMessage {
  kind: "stream.user_message";
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
export interface PromptMessage extends BaseMessage {
  kind: "prompt";
  text: string;
  attachments?: PromptAttachment[];
}
export interface ApprovalRequest extends BaseMessage {
  kind: "approval.request";
  requestId: string;
  toolName: string;
  toolArgs?: unknown;
  options: ApprovalOption[];
}
export interface ApprovalDecision extends BaseMessage {
  kind: "approval.decision";
  requestId: string;
  optionId: string;
  raw?: unknown;
}
/** JSON Schema for a form-mode elicitation: an object whose properties are the fields. */
export interface ElicitationSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}
/** Ext -> phone: the agent's `ask_user` / elicitation prompt to render as a form. */
export interface ElicitationRequest extends BaseMessage {
  kind: "elicitation.request";
  requestId: string;
  message: string;
  mode: ElicitationMode;
  requestedSchema?: ElicitationSchema;
  toolCallId?: string;
  /** Present only for url-mode elicitations: a link to open on the computer. */
  url?: string;
}
/** Phone -> ext: the user's answer to an elicitation form. */
export interface ElicitationResponse extends BaseMessage {
  kind: "elicitation.response";
  requestId: string;
  action: ElicitationAction;
  content?: Record<string, ElicitationValue>;
}
/** Ext -> phone: an elicitation was resolved elsewhere; dismiss any open form for it. */
export interface ElicitationComplete extends BaseMessage {
  kind: "elicitation.complete";
  requestId: string;
  action?: ElicitationAction;
}
export interface SessionStart extends BaseMessage {
  kind: "control.session_start";
  channelId: string;
  sessionId: string;
  cwd?: string;
  /** CLI chat summary ("title"); may be empty until the CLI derives one. */
  title?: string;
}
export interface SessionMeta extends BaseMessage {
  kind: "control.session_meta";
  /** Latest CLI chat summary ("title"). */
  title?: string;
  cwd?: string;
}
export interface SessionEnd extends BaseMessage {
  kind: "control.session_end";
  reason?: string;
}
export interface Heartbeat extends BaseMessage {
  kind: "control.heartbeat";
  /** Highest committed turn_index in the CLI store at beat time (forward cursor); null if unknown. */
  latestTurnIndex?: number | null;
  /** Authoritative turn-in-flight flag re-asserted each beat; null when unknown. */
  busy?: boolean | null;
}
export interface ModeChange extends BaseMessage {
  kind: "control.mode";
  mode: SessionMode;
}
/** Phone -> ext: stop/cancel the in-flight generation or tool run. */
export interface InterruptMessage extends BaseMessage {
  kind: "control.interrupt";
}
/** Phone -> ext: request a page of turns (cursor = turn_index, exclusive). */
export interface HistoryRequest extends BaseMessage {
  kind: "control.history_request";
  /** Backward cursor: return turns OLDER than this ("load earlier"). */
  before?: number | null;
  /** Forward cursor: return turns NEWER than this, ascending (post-away catch-up). */
  since?: number | null;
  limit?: number;
}
/** Ext -> phone: a page of history items in ascending turn order. */
export interface History extends BaseMessage {
  kind: "control.history";
  items: HistoryItem[];
  nextCursor: number | null;
  hasMore: boolean;
  /** Echo of the request's forward cursor: non-null => FORWARD catch-up page; null => latest/backward. */
  since?: number | null;
}
/** Phone -> ext: request the current session state on (re)connect / refresh / resume. */
export interface StateRequest extends BaseMessage {
  kind: "control.state_request";
}
/** Ext -> phone: a snapshot of the live session state, answering a StateRequest. */
export interface StateSnapshot extends BaseMessage {
  kind: "control.state_snapshot";
  /** A turn is in flight (agent working). */
  busy: boolean;
  /** The in-flight work can be stopped (drives the Stop control at connect time). */
  abortable: boolean;
  /** Current session mode, or null when unknown. */
  mode: SessionMode | null;
  /** Highest committed turn_index in the store (the phone's forward cursor); null if none. */
  latestTurnIndex: number | null;
  /** Pending approval prompts to (re)render, in approvalRequest shape. */
  approvals: ApprovalRequest[];
  /** Pending ask_user / elicitation prompts to (re)render, in elicitationRequest shape. */
  elicitations: ElicitationRequest[];
}

export type InnerMessage =
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
  | SessionStart
  | SessionMeta
  | SessionEnd
  | Heartbeat
  | ModeChange
  | InterruptMessage
  | HistoryRequest
  | History
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
export function prompt(text: string, attachments?: PromptAttachment[]): PromptMessage;
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
export function sessionStart(
  channelId: string,
  sessionId: string,
  cwd?: string,
  title?: string
): SessionStart;
export function sessionMeta(title?: string, cwd?: string): SessionMeta;
export function sessionEnd(reason?: string): SessionEnd;
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
export function stateRequest(): StateRequest;
export function stateSnapshot(snapshot?: {
  busy?: boolean;
  abortable?: boolean;
  mode?: SessionMode | null;
  latestTurnIndex?: number | null;
  approvals?: ApprovalRequest[];
  elicitations?: ElicitationRequest[];
}): StateSnapshot;
export function eventForKind(kind: string): LogicalEvent;
export function isValidInner(msg: unknown): msg is InnerMessage;

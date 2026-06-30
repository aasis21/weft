// Type definitions for Helm shared message protocol.

import type { HistoryItem } from "./history";

export type LogicalEvent = "stream" | "prompt" | "approval" | "decision" | "control";

export type SessionMode = "interactive" | "plan" | "autopilot";

export const EVENTS: {
  readonly STREAM: "stream";
  readonly PROMPT: "prompt";
  readonly APPROVAL: "approval";
  readonly DECISION: "decision";
  readonly CONTROL: "control";
};

export const KIND: {
  readonly ASSISTANT_MESSAGE: "assistant.message";
  readonly ASSISTANT_DELTA: "assistant.delta";
  readonly TOOL_START: "tool.start";
  readonly TOOL_COMPLETE: "tool.complete";
  readonly LOG: "log";
  readonly USER_MESSAGE: "stream.user_message";
  readonly PROMPT: "prompt";
  readonly APPROVAL_REQUEST: "approval.request";
  readonly APPROVAL_DECISION: "approval.decision";
  readonly SESSION_START: "control.session_start";
  readonly SESSION_META: "control.session_meta";
  readonly SESSION_END: "control.session_end";
  readonly HEARTBEAT: "control.heartbeat";
  readonly MODE: "control.mode";
  readonly HISTORY_REQUEST: "control.history_request";
  readonly HISTORY: "control.history";
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
/** A user prompt echoed from the laptop to the phone, attributed by device. */
export interface UserMessageEcho extends BaseMessage {
  kind: "stream.user_message";
  text: string;
  origin: "phone" | "terminal";
  id?: string;
}
export interface PromptMessage extends BaseMessage {
  kind: "prompt";
  text: string;
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
}
export interface ModeChange extends BaseMessage {
  kind: "control.mode";
  mode: SessionMode;
}
/** Phone -> ext: request a page of older turns (cursor = turn_index, exclusive). */
export interface HistoryRequest extends BaseMessage {
  kind: "control.history_request";
  before?: number | null;
  limit?: number;
}
/** Ext -> phone: a page of history items in ascending turn order. */
export interface History extends BaseMessage {
  kind: "control.history";
  items: HistoryItem[];
  nextCursor: number | null;
  hasMore: boolean;
}

export type InnerMessage =
  | AssistantMessage
  | AssistantDelta
  | ToolStart
  | ToolComplete
  | LogLine
  | UserMessageEcho
  | PromptMessage
  | ApprovalRequest
  | ApprovalDecision
  | SessionStart
  | SessionMeta
  | SessionEnd
  | Heartbeat
  | ModeChange
  | HistoryRequest
  | History;

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
export function userMessage(
  text: string,
  origin?: "phone" | "terminal",
  id?: string
): UserMessageEcho;
export function prompt(text: string): PromptMessage;
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
export function sessionStart(
  channelId: string,
  sessionId: string,
  cwd?: string,
  title?: string
): SessionStart;
export function sessionMeta(title?: string, cwd?: string): SessionMeta;
export function sessionEnd(reason?: string): SessionEnd;
export function heartbeat(): Heartbeat;
export function modeChange(mode: SessionMode): ModeChange;
export function historyRequest(before?: number | null, limit?: number): HistoryRequest;
export function history(
  items: HistoryItem[],
  nextCursor?: number | null,
  hasMore?: boolean
): History;
export function eventForKind(kind: string): LogicalEvent;
export function isValidInner(msg: unknown): msg is InnerMessage;

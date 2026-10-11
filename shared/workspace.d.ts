import type { Envelope } from "./messages";
export const WORKSPACE_CAPABILITY: "workspace-view-v1";
export const SESSION_FILES_CAPABILITY: "session-files-v1";
export const WORKSPACE_LIMITS: Readonly<{
  entries: number; directoryEntries: number; fileBytes: number; htmlBytes: number;
  lines: number; pageLines: number; frameBytes: number; pageBytes: number;
  previews: number; ttlMs: number;
}>;
export const WORKSPACE_CODES: readonly string[];
export type WorkspaceCommand =
  | { action: "list"; path: string; cursor?: string; scope?: "workspace" | "touched" }
  | { action: "changes"; cursor?: string }
  | { action: "open"; path: string; format?: "file" | "diff"; base?: string }
  | { action: "page"; previewId: string; offset: number }
  | { action: "close"; previewId: string };
export type WorkspaceRequestMsg = WorkspaceCommand & { requestId: string };
export interface WorkspaceEntry {
  path: string; name: string; kind: "file" | "folder";
  status?: string; oldPath?: string;
  access?: "read" | "written" | "read-written"; external?: boolean;
}
export interface WorkspaceData {
  action: WorkspaceCommand["action"];
  path?: string;
  scope?: "workspace" | "touched";
  entries?: WorkspaceEntry[];
  cursor?: string | null;
  base?: string | null;
  previewId?: string;
  revision?: string;
  format?: "markdown" | "html" | "source" | "diff";
  capturedAt?: number;
  totalLines?: number;
  text?: string;
  offset?: number;
  nextOffset?: number | null;
}
export interface WorkspaceResultMsg {
  requestId: string;
  data?: WorkspaceData;
  error?: { code: string; message: string };
}
export type WorkspaceRequest = Envelope<"control", "workspace_request", WorkspaceRequestMsg>;
export type WorkspaceResult = Envelope<"control", "workspace_result", WorkspaceResultMsg>;
export function workspaceRequest(msg: WorkspaceRequestMsg): WorkspaceRequest;
export function workspaceResult(msg: WorkspaceResultMsg): WorkspaceResult;
export function validWorkspaceRequest(value: unknown): value is WorkspaceRequestMsg;
export function validWorkspaceResult(value: unknown): value is WorkspaceResultMsg;

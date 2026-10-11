// SPDX-License-Identifier: Apache-2.0
export const WORKSPACE_CAPABILITY = "workspace-view-v1";
export const WORKSPACE_LIMITS = Object.freeze({
  entries: 100, directoryEntries: 4000, fileBytes: 2 * 1024 * 1024,
  htmlBytes: 1024 * 1024, lines: 20000, pageLines: 200,
  frameBytes: 16 * 1024, pageBytes: 8000, previews: 4, ttlMs: 5 * 60 * 1000,
});
export const WORKSPACE_CODES = Object.freeze([
  "invalid-request", "unsupported", "denied", "unavailable", "missing",
  "changed", "expired", "too-large", "timeout", "busy",
]);
export const workspaceRequest = (msg) =>
  ({ eventType: "control", eventSubtype: "workspace_request", msg, ts: Date.now() });
export const workspaceResult = (msg) =>
  ({ eventType: "control", eventSubtype: "workspace_result", msg, ts: Date.now() });

export function validWorkspaceRequest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.requestId !== "string" || !/^[a-zA-Z0-9-]{1,96}$/.test(value.requestId)) return false;
  if (!["list", "changes", "open", "page", "close"].includes(value.action)) return false;
  const fields = {
    list: ["path", "cursor"], changes: ["cursor"],
    open: ["path", "format", "base"], page: ["previewId", "offset"],
    close: ["previewId"],
  };
  if (Object.keys(value).some((key) => !["requestId", "action", ...fields[value.action]].includes(key))) return false;
  if (value.path !== undefined && (typeof value.path !== "string" || value.path.length > 2048 || /[\0\r\n]/.test(value.path))) return false;
  if (["list", "open"].includes(value.action) && typeof value.path !== "string") return false;
  if (value.format !== undefined && !["file", "diff"].includes(value.format)) return false;
  if (value.base !== undefined && (typeof value.base !== "string" || !/^[a-f0-9]{40,64}$/.test(value.base))) return false;
  if (value.cursor !== undefined && (typeof value.cursor !== "string" || value.cursor.length > 128)) return false;
  if (["page", "close"].includes(value.action) &&
      (typeof value.previewId !== "string" || !/^[a-f0-9-]{36}$/.test(value.previewId))) return false;
  if (value.action === "page" && (!Number.isSafeInteger(value.offset) || value.offset < 0)) return false;
  return true;
}

export function validWorkspaceResult(value) {
  if (!value || typeof value !== "object" || typeof value.requestId !== "string") return false;
  if (value.error) return typeof value.error.code === "string" && typeof value.error.message === "string";
  const data = value.data;
  if (!data || !["list", "changes", "open", "page", "close"].includes(data.action)) return false;
  if (data.base != null && (typeof data.base !== "string" || !/^[a-f0-9]{40,64}$/.test(data.base))) return false;
  if (data.path !== undefined && (typeof data.path !== "string" || data.path.length > 2048)) return false;
  if (["list", "changes"].includes(data.action)) {
    return Array.isArray(data.entries) && data.entries.length <= WORKSPACE_LIMITS.entries &&
      data.entries.every((entry) => entry && typeof entry.path === "string" && entry.path.length <= 2048 &&
        typeof entry.name === "string" && entry.name.length <= 255 &&
        (entry.status === undefined || typeof entry.status === "string" && entry.status.length <= 1) &&
        (entry.oldPath === undefined || typeof entry.oldPath === "string" && entry.oldPath.length <= 2048) &&
        ["file", "folder"].includes(entry.kind)) &&
      (data.cursor == null || typeof data.cursor === "string" && data.cursor.length <= 128);
  }
  if (data.action === "close") return true;
  return typeof data.previewId === "string" && typeof data.revision === "string" &&
    typeof data.text === "string" && new TextEncoder().encode(data.text).length <= WORKSPACE_LIMITS.pageBytes &&
    Number.isSafeInteger(data.offset) && data.offset >= 0 &&
    (data.nextOffset === null || data.text.length > 0 && data.nextOffset === data.offset + data.text.length) &&
    (data.action !== "open" || typeof data.path === "string" && typeof data.capturedAt === "number" &&
      ["source", "markdown", "html", "diff"].includes(data.format));
}

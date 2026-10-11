// SPDX-License-Identifier: Apache-2.0
import { isAbsolute, resolve } from "node:path";
import { WORKSPACE_LIMITS } from "@aasis21/weft-shared";

const key = (path) => process.platform === "win32" ? path.toLowerCase() : path;
export class SessionFilesError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new SessionFilesError(code, message); };
const absolute = (path) => typeof path === "string" && path.length <= 2048 &&
  !/[\0\r\n]/.test(path) && isAbsolute(path) ? resolve(path) : null;

export function createSessionFiles({ session } = {}) {
  const files = new Map(), pending = new Map();
  let cursor, syncing = null;
  function record(path, access) {
    path = absolute(path);
    if (!path) return;
    const id = key(path);
    if (!files.has(id) && files.size >= WORKSPACE_LIMITS.directoryEntries) {
      fail("too-large", "This session touched too many files to list safely.");
    }
    const previous = files.get(id) ?? { path, read: false, written: false };
    files.set(id, { ...previous, [access]: true });
  }
  function observe(event) {
    const data = event?.data;
    if (!data) return;
    const id = `${event.agentId ?? ""}:${data.toolCallId ?? ""}`;
    if (data.sandboxed || data.mcpServerName || data.mcpToolName) {
      if (event.type === "tool.execution_complete") pending.delete(id);
      return;
    }
    if (event.type === "tool.execution_start") {
      if (!data.toolCallId) return;
      const access = ["view", "read_file"].includes(data.toolName) ? "read" :
        ["create", "edit"].includes(data.toolName) ? "written" : null;
      const path = access && absolute(data.arguments?.path);
      if (path) {
        if (pending.size >= WORKSPACE_LIMITS.directoryEntries && !pending.has(id)) {
          fail("too-large", "Too many file operations are pending in this session.");
        }
        pending.set(id, { path, access });
      }
    } else if (event.type === "tool.execution_complete") {
      const started = pending.get(id);
      pending.delete(id);
      if (data.success === true && !data.error && started) record(started.path, started.access);
      // Native fileEdits describes committed mutations, including partial failures.
      for (const edit of Array.isArray(data.fileEdits) ? data.fileEdits : []) {
        if (["create", "edit", "delete"].includes(edit.kind)) record(edit.path, "written");
      }
    }
  }
  async function readHistory() {
    if (!session?.rpc?.eventLog?.read) fail("unsupported", "Update Copilot: session file history is unavailable.");
    for (let batch = 0; batch < 20; batch++) {
      let result;
      try {
        result = await session.rpc.eventLog.read({
          ...(cursor ? { cursor } : {}), max: 500, waitMs: 0, includeEphemeral: false,
          types: ["tool.execution_start", "tool.execution_complete"], agentScope: "all",
        });
      } catch {
        fail("unavailable", "Copilot session file history could not be read. Reconnect or update Copilot.");
      }
      if (result?.cursorStatus === "expired") {
        files.clear(); pending.clear(); cursor = undefined;
        fail("changed", "The session history changed. Refresh to rebuild its file list.");
      }
      if (result?.cursorStatus !== "ok" || !Array.isArray(result.events) ||
          typeof result.cursor !== "string" || typeof result.hasMore !== "boolean" ||
          result.hasMore && result.cursor === cursor) {
        fail("unavailable", "Copilot returned incomplete session file history.");
      }
      for (const event of result.events) observe(event);
      cursor = result.cursor;
      if (!result.hasMore) return;
    }
    fail("too-large", "Session file history is still loading. Refresh to continue.");
  }
  return {
    sync() {
      if (!syncing) syncing = readHistory().finally(() => { syncing = null; });
      return syncing;
    },
    has(path) { return files.has(key(resolve(path))); },
    entries() { return [...files.values()].map((entry) => ({ ...entry })); },
  };
}

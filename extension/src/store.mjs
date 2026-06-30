// SPDX-License-Identifier: Apache-2.0
// Read-only access to the Copilot CLI's own session store (~/.copilot/session-store.db)
// for the chat title (summary) and conversation history (turns). This is the SAME data
// the CLI session picker shows, so Helm's phone stays in sync with the terminal without
// depending on the experimental session-metadata RPC. node:sqlite ships built-in on
// Node 24 (no flag).
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  clipText,
} from "@aasis21/helm-shared";

const DB_PATH = join(homedir(), ".copilot", "session-store.db");

async function openDb(dbPath = DB_PATH) {
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(dbPath, { readOnly: true });
}

/**
 * The chat title ("summary") the CLI derives for a session as the conversation grows.
 * Returns "" for an unknown session or if the store can't be read (older Node without
 * node:sqlite, missing DB, locked file, …) — the caller falls back to the cwd basename.
 */
export async function readSummary(sessionId, dbPath = DB_PATH) {
  if (!sessionId) return "";
  try {
    const db = await openDb(dbPath);
    try {
      const row = db.prepare("SELECT summary FROM sessions WHERE id = ?").get(sessionId);
      return (row && row.summary) || "";
    } finally {
      db.close();
    }
  } catch {
    return "";
  }
}

/**
 * A page of conversation history for a session, newest-turns-first on the wire but
 * returned ascending for display. Reads the CLI's `turns` table (one row per completed
 * turn = user_message + final assistant_response, text only). Each turn yields up to two
 * HistoryItems: `{ turnIndex, role, text, ts }`. The in-flight turn has a NULL
 * assistant_response → its assistant item is skipped.
 *
 * Pagination is cursor-based on `turn_index`:
 *  - `before` (exclusive) — return turns with `turn_index < before`; null/undefined = latest.
 *  - `limit` — clamped to HISTORY_PAGE_MAX so each encrypted broadcast stays small.
 * Returns `{ items, nextCursor, hasMore }` where `nextCursor` is the `before` to pass for
 * the next older page (or null when there is nothing older).
 *
 * Returns an empty page on any read failure (missing DB, old Node, locked file, …).
 */
export async function readHistory(sessionId, { before = null, limit } = {}, dbPath = DB_PATH) {
  const empty = { items: [], nextCursor: null, hasMore: false };
  if (!sessionId) return empty;
  const pageSize = clampLimit(limit);
  try {
    const db = await openDb(dbPath);
    try {
      // Fetch one extra row to detect whether older turns remain (hasMore).
      const hasCursor = Number.isFinite(before);
      const sql =
        "SELECT turn_index, user_message, assistant_response, timestamp FROM turns " +
        "WHERE session_id = ?" +
        (hasCursor ? " AND turn_index < ?" : "") +
        " ORDER BY turn_index DESC LIMIT ?";
      const params = hasCursor ? [sessionId, before, pageSize + 1] : [sessionId, pageSize + 1];
      const rows = db.prepare(sql).all(...params);

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      // `page` is newest-first; the oldest turn in it is the cursor for the next page.
      const nextCursor = hasMore ? page[page.length - 1].turn_index : null;

      page.reverse(); // ascending for display
      const items = [];
      for (const r of page) {
        const ts = parseTs(r.timestamp);
        const u = (r.user_message || "").trim();
        const a = (r.assistant_response || "").trim();
        if (u) items.push({ turnIndex: r.turn_index, role: "user", text: clipText(u), ts });
        if (a) items.push({ turnIndex: r.turn_index, role: "assistant", text: clipText(a), ts });
      }
      return { items, nextCursor, hasMore };
    } finally {
      db.close();
    }
  } catch {
    return empty;
  }
}

function clampLimit(limit) {
  const n = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : HISTORY_PAGE_DEFAULT;
  return Math.min(n, HISTORY_PAGE_MAX);
}

/** CLI stores `timestamp` as ISO-8601 text; normalize to epoch ms (0 if unparseable). */
function parseTs(raw) {
  if (raw == null) return 0;
  if (typeof raw === "number") return raw;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? 0 : ms;
}

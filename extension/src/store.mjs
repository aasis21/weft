// SPDX-License-Identifier: Apache-2.0
// Read-only access to the Copilot CLI's own session store (~/.copilot/session-store.db)
// for the chat title (summary) and conversation history (turns). This is the SAME data
// the CLI session picker shows, so Weft's phone stays in sync with the terminal without
// depending on the experimental session-metadata RPC. node:sqlite ships built-in on
// Node 24 (no flag).
import { homedir } from "node:os";
import { join } from "node:path";
import {
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  clipText,
} from "@aasis21/weft-shared";

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
 * A page of conversation history for a session. Reads the CLI's `turns` table (one row per
 * completed turn = user_message + final assistant_response, text only). Each turn yields up to two
 * HistoryItems: `{ turnIndex, role, text, ts }`, returned ascending for display. The in-flight turn
 * has a NULL assistant_response → its assistant item is skipped.
 *
 * Cursor-based pagination on `turn_index`, one of three directions (backward is the default):
 *  - `since` (exclusive)  — FORWARD catch-up: turns with `turn_index > since`, oldest-first. Takes
 *    precedence over `before` when both are given. `nextCursor` = highest turn_index in the page.
 *  - `before` (exclusive) — BACKWARD scrollback: turns with `turn_index < before`; null = latest.
 *    `nextCursor` = lowest turn_index in the page (the next older page's `before`).
 *  - `limit` — clamped to HISTORY_PAGE_MAX so each encrypted broadcast stays small.
 * Returns `{ items, nextCursor, hasMore }`; `nextCursor` continues in the SAME direction (or null
 * when nothing more remains). Returns an empty page on any read failure (missing DB, old Node, …).
 */
export async function readHistory(
  sessionId,
  { before = null, since = null, limit } = {},
  dbPath = DB_PATH,
) {
  const empty = { items: [], nextCursor: null, hasMore: false };
  if (!sessionId) return empty;
  const pageSize = clampLimit(limit);
  const forward = Number.isFinite(since);
  try {
    const db = await openDb(dbPath);
    try {
      // Fetch one extra row to detect whether more turns remain (hasMore).
      let sql;
      let params;
      if (forward) {
        // Forward catch-up: turns NEWER than `since`, oldest-first so gap pages fill in order.
        sql =
          "SELECT turn_index, user_message, assistant_response, timestamp FROM turns " +
          "WHERE session_id = ? AND turn_index > ? ORDER BY turn_index ASC LIMIT ?";
        params = [sessionId, since, pageSize + 1];
      } else {
        const hasCursor = Number.isFinite(before);
        sql =
          "SELECT turn_index, user_message, assistant_response, timestamp FROM turns " +
          "WHERE session_id = ?" +
          (hasCursor ? " AND turn_index < ?" : "") +
          " ORDER BY turn_index DESC LIMIT ?";
        params = hasCursor ? [sessionId, before, pageSize + 1] : [sessionId, pageSize + 1];
      }
      const rows = db.prepare(sql).all(...params);

      const hasMore = rows.length > pageSize;
      const page = hasMore ? rows.slice(0, pageSize) : rows;
      // Cursor to continue in the SAME direction: forward pages end on the NEWEST turn (highest
      // index), backward pages end on the OLDEST turn (lowest index) — both are page[last].
      const nextCursor = hasMore ? page[page.length - 1].turn_index : null;

      if (!forward) page.reverse(); // backward pages come DESC; flip to ascending for display
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

/**
 * The highest `turn_index` recorded for a session (its most recent committed turn), or null when
 * the session has no turns yet or the store can't be read. Used as the phone's forward cursor so a
 * post-away catch-up knows where "now" is (carried on the heartbeat and in the state snapshot).
 */
export async function readLatestTurnIndex(sessionId, dbPath = DB_PATH) {
  if (!sessionId) return null;
  try {
    const db = await openDb(dbPath);
    try {
      const row = db
        .prepare("SELECT MAX(turn_index) AS maxTurn FROM turns WHERE session_id = ?")
        .get(sessionId);
      const max = row && row.maxTurn;
      return Number.isFinite(max) ? max : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
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

// SPDX-License-Identifier: Apache-2.0
// In-memory recent-turns buffer for the Helm extension.
//
// The CLI's session store (~/.copilot/session-store.db) persists only a turn's FINAL assistant text
// and leaves it NULL for long / multi-tool / task-ending turns — so DB-backed scrollback shows those
// turns as user-only. This buffer instead captures the assistant text LIVE (from the same SDK
// `assistant.message` events the relay already forwards to the phone), so a connecting phone can
// backfill recent turns at FULL fidelity. It is seeded once from the store at startup (so turns from
// before the extension started still appear, best-effort) and then enriched from the live stream.
//
// Model: a flat, chronological list of message entries `{ role, text, ts, id }`, capped to the last
// `max` TURNS (a turn boundary = a user message). Pure + injectable clock → unit-testable.

import { clipText, RECENT_TURNS_DEFAULT } from "@aasis21/helm-shared";

export function createRecentTurns({ max = RECENT_TURNS_DEFAULT, now = () => Date.now() } = {}) {
  const cap = Number.isFinite(max) && max > 0 ? Math.floor(max) : RECENT_TURNS_DEFAULT;
  /** @type {{ role: 'user'|'assistant', text: string, ts: number, id: string }[]} */
  let entries = [];

  // The index where the last `n` turns begin (a turn boundary = a user message). Counting user
  // entries from the end, the nth user from the end starts the nth-from-last turn. Returns 0 when
  // there are fewer than `n` turns.
  const startOfLastTurns = (n) => {
    let turns = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      if (entries[i].role === "user") {
        turns += 1;
        if (turns === n) return i;
      }
    }
    return 0;
  };

  const capByTurns = () => {
    const start = startOfLastTurns(cap);
    if (start > 0) entries = entries.slice(start);
  };

  const push = (role, text, ts, id) => {
    const t = typeof text === "string" ? text.trim() : "";
    if (!t) return;
    entries.push({
      role,
      text: clipText(t),
      ts: Number.isFinite(ts) ? ts : now(),
      id: String(id ?? `${role}-${ts}`),
    });
    capByTurns();
  };

  return {
    /**
     * Prime the buffer from a store history page (ascending HistoryItem[]) — ONLY when still empty,
     * so a later re-seed can't clobber live-captured turns. Seeded assistant text is whatever the
     * store had (possibly missing for old lossy turns); live turns overwrite that with full text.
     */
    seed(items) {
      if (entries.length || !Array.isArray(items)) return;
      for (const it of items) {
        if (!it || (it.role !== "user" && it.role !== "assistant")) continue;
        push(it.role, it.text, it.ts, `seed-${it.turnIndex}-${it.role}`);
      }
    },
    /** Record a user prompt (either origin) starting/continuing a turn. */
    recordUser(text, ts, id) {
      push("user", text, ts, id);
    },
    /**
     * Record a full assistant message. A turn can emit several assistant messages (text interleaved
     * with tools); the SDK streams `assistant.message_delta` then a final `assistant.message` with
     * the SAME messageId — so if the last entry is that same assistant message, REPLACE its text
     * instead of appending a duplicate bubble.
     */
    recordAssistant(text, ts, id) {
      const t = typeof text === "string" ? text.trim() : "";
      if (!t) return;
      const last = entries[entries.length - 1];
      if (last && last.role === "assistant" && last.id === String(id)) {
        // Same messageId: a final-text retransmission or cumulative delta carries a superset of
        // what we already have (REPLACE), but a distinct segment resuming after an interleaved
        // tool does not — concatenate that so multi-part assistant turns aren't truncated (#116).
        const clipped = clipText(t);
        last.text = clipped === last.text || clipped.startsWith(last.text) ? clipped : clipText(`${last.text}\n${t}`);
        if (Number.isFinite(ts)) last.ts = ts;
        return;
      }
      push("assistant", text, ts, id);
    },
    /** The last `limit` turns as ascending (chronological) message entries (defensive copies). */
    snapshot(limit = cap) {
      const n = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), cap) : cap;
      return entries.slice(startOfLastTurns(n)).map((e) => ({ ...e }));
    },
    /** Number of buffered message entries (for tests / diagnostics). */
    get size() {
      return entries.length;
    },
  };
}

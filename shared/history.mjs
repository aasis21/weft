// SPDX-License-Identifier: Apache-2.0
// Pure, dependency-free helpers for the history-backfill feature. Shared so the
// extension (page builder) and the mobile reducer (page merger) agree on shapes,
// ids, ordering, and clipping — and so the logic is unit-testable with node:test.

/** Default page size the phone asks for and the extension serves. */
export const HISTORY_PAGE_DEFAULT = 50;
/** Hard cap the extension enforces regardless of what the phone requests, so each
 *  encrypted broadcast stays well under the Supabase payload limit. */
export const HISTORY_PAGE_MAX = 50;
/** Per-message text clip (characters) applied to each history item. */
export const HISTORY_TEXT_CLIP = 4000;

/** How many trailing turns the extension keeps in its in-memory recent-turns buffer (and the phone
 *  asks for). One "turn" ≈ a user message plus the assistant reply that follows it. */
export const RECENT_TURNS_DEFAULT = 50;

/** Stable id for a history item: a turn yields at most one user + one assistant item. */
export function historyItemId(item) {
  return `${item.turnIndex}:${item.role}`;
}

/** Clip a string to `max` chars, appending an ellipsis when truncated. */
export function clipText(text, max = HISTORY_TEXT_CLIP) {
  if (typeof text !== "string") return "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Order two history items: ascending by turnIndex, user before assistant within a turn. */
export function compareHistory(a, b) {
  if (a.turnIndex !== b.turnIndex) return a.turnIndex - b.turnIndex;
  if (a.role === b.role) return 0;
  return a.role === "user" ? -1 : 1;
}

/**
 * Merge an incoming page into the existing (ascending) history list: dedup by
 * stable id (incoming wins), then re-sort ascending. Pure — returns a new array.
 */
export function mergeHistory(existing = [], incoming = []) {
  const byId = new Map();
  for (const item of existing) byId.set(historyItemId(item), item);
  for (const item of incoming) byId.set(historyItemId(item), item);
  return [...byId.values()].sort(compareHistory);
}

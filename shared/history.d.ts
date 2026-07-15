// Type definitions for Weft history-backfill helpers.

/** One backfilled message: a turn yields at most one user + one assistant item. */
export interface HistoryItem {
  turnIndex: number;
  role: "user" | "assistant";
  text: string;
  ts: number;
}

export const HISTORY_PAGE_DEFAULT: number;
export const HISTORY_PAGE_MAX: number;
export const HISTORY_TEXT_CLIP: number;
export const RECENT_TURNS_DEFAULT: number;
export const SESSION_LIST_DEFAULT: number;
export const SESSION_LIST_MAX: number;

export function historyItemId(item: HistoryItem): string;
export function clipText(text: string, max?: number): string;
export function compareHistory(a: HistoryItem, b: HistoryItem): number;
export function mergeHistory(existing?: HistoryItem[], incoming?: HistoryItem[]): HistoryItem[];

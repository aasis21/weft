import type { StoredSession } from '@aasis21/weft-shared';


/** A folder the resumable-session list can be narrowed to. `count` drives the "(3)" suffix so you
 *  can tell a busy checkout from one with a single stale session before selecting it. */
export interface FolderOption {
  /** Absolute cwd — the option's value, and what {@link filterStoredSessions} matches on. */
  path: string;
  /** Last path segment, shown in the picker. Ambiguous on its own (two repos can both end in
   *  `main`), which is why the full path is kept as the option's title attribute. */
  label: string;
  count: number;
}

export const ALL_FOLDERS = 'all';

/** Split a path on either separator — the laptop may be Windows or POSIX, and the phone has no way
 *  to know which, so both are always treated as separators. Trailing separators are ignored so
 *  `C:\repo\` and `C:\repo` produce the same label. */
export function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/** Distinct cwds across the list, most-sessions-first then alphabetical, so the folders you actually
 *  work in surface at the top of the picker instead of being ordered by an accident of mtime. */
export function folderOptions(sessions: StoredSession[]): FolderOption[] {
  const counts = new Map<string, number>();
  for (const session of sessions) {
    if (!session.cwd) continue;
    counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, count]) => ({ path, label: basename(path), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label) || a.path.localeCompare(b.path));
}

/** Every term must match somewhere in the row (AND, not OR) so adding a word always narrows the
 *  list — typing "auth bug" finding strictly less than "auth" is the behaviour people expect from
 *  a search box, and OR would do the opposite. */
function matchesQuery(session: StoredSession, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const haystack = [session.title, session.cwd, session.repository, session.branch]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export interface SessionFilter {
  query: string;
  /** An absolute cwd, or {@link ALL_FOLDERS}. A folder that is not a real choice is treated as
   *  {@link ALL_FOLDERS} rather than matching nothing: refreshing can drop the folder you had
   *  selected, and silently showing an empty list reads as "the refresh broke" instead of "that
   *  folder is gone". */
  folder: string;
}

/**
 * @param knownFolders The folders actually on offer in the picker. Without it, "real choice" is
 *   inferred from the rows themselves, which cannot tell a folder that has gone away from one that
 *   is simply empty — and a folder can be a legitimate selection with no sessions in it, which is
 *   the normal state of a device's configured default before anything has been run there. Passing
 *   the picker's own options keeps the list honest: an empty folder shows empty rather than
 *   quietly widening back out to everything.
 */
export function filterStoredSessions(
  sessions: StoredSession[],
  { query, folder }: SessionFilter,
  knownFolders?: readonly string[],
): StoredSession[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const known =
    folder !== ALL_FOLDERS &&
    (knownFolders ? knownFolders.includes(folder) : sessions.some((s) => s.cwd === folder));
  return sessions.filter((session) => {
    if (known && session.cwd !== folder) return false;
    return matchesQuery(session, terms);
  });
}

/** Whether the controls are actually narrowing anything — drives the "Showing 3 of 40" line and the
 *  Clear button, both of which are noise when nothing is filtered. */
export function isFiltering({ query, folder }: SessionFilter): boolean {
  return query.trim().length > 0 || folder !== ALL_FOLDERS;
}

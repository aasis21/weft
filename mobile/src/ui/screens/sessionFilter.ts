import type { StoredSession } from '@aasis21/weft-shared';


/** A folder the resumable-session list can be narrowed to. `count` drives the "(3)" suffix so you
 *  can tell a busy checkout from one with a single stale session before selecting it. */
export interface FolderOption {
  /** Absolute cwd — the option's value, and what {@link filterStoredSessions} matches on. */
  path: string;
  /** Display name. Normally the last path segment; extended leftwards when that alone would be
   *  ambiguous — see {@link folderOptions}. */
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

/** Enough of the tail of each path to tell them apart. Two different checkouts really can both end
 *  in `axon`, and rendering both as "axon (2)" made the picker unusable — you chose one, got someone
 *  else's sessions, and concluded the refresh was stale. A native <select> on a phone shows no title
 *  tooltip, so the disambiguation has to be in the visible text. Only the colliding labels grow, and
 *  only by as many segments as it takes. */
function disambiguate(paths: string[]): Map<string, string> {
  const labels = new Map<string, string>();
  const segments = new Map<string, string[]>();
  for (const path of paths) segments.set(path, path.split(/[\\/]+/).filter(Boolean));
  let depth = 1;
  let remaining = paths;
  while (remaining.length > 0 && depth <= 6) {
    const byLabel = new Map<string, string[]>();
    for (const path of remaining) {
      const parts = segments.get(path) ?? [path];
      const label = parts.slice(Math.max(0, parts.length - depth)).join('/');
      byLabel.set(label, [...(byLabel.get(label) ?? []), path]);
    }
    const stillColliding: string[] = [];
    for (const [label, group] of byLabel) {
      const parts = segments.get(group[0] ?? '') ?? [];
      // A path can't grow past its own root; once it is fully spelled out it is as distinct as it
      // will ever be, collision or not.
      if (group.length === 1 || depth >= parts.length) {
        for (const path of group) labels.set(path, label);
      } else {
        stillColliding.push(...group);
      }
    }
    remaining = stillColliding;
    depth += 1;
  }
  for (const path of remaining) labels.set(path, path);
  return labels;
}

/** Distinct cwds across the list, most-sessions-first then alphabetical, so the folders you actually
 *  work in surface at the top of the picker instead of being ordered by an accident of mtime.
 *
 * @param registered Folders the device has registered as projects. These are offered whether or not
 *   anything resumable has been run in them yet, and always sort above the rest: the two sets
 *   demonstrably diverge (the store knows every folder a session has ever run in, including ones
 *   that were never registered and ones that no longer exist), and a picker that only listed cwds
 *   would hide the folder you are most likely to want simply because it is empty today.
 * @param totals Whole-store per-folder counts reported by the laptop. The rows on hand are only the
 *   most recent page, so counting them tells you how much of a folder survived the cap rather than
 *   how much of it exists — a folder with a hundred sessions could advertise "(2)". When the laptop
 *   supplies real totals they win; otherwise we fall back to counting what we have.
 */
export function folderOptions(
  sessions: StoredSession[],
  registered: readonly string[] = [],
  totals?: ReadonlyMap<string, number>,
): FolderOption[] {
  const counts = new Map<string, number>();
  for (const path of registered) {
    if (path) counts.set(path, 0);
  }
  for (const session of sessions) {
    if (!session.cwd) continue;
    counts.set(session.cwd, (counts.get(session.cwd) ?? 0) + 1);
  }
  if (totals) {
    for (const [path, total] of totals) counts.set(path, total);
  }
  const isRegistered = new Set(registered.filter(Boolean));
  const labels = disambiguate([...counts.keys()]);
  return [...counts.entries()]
    .map(([path, count]) => ({ path, label: labels.get(path) ?? basename(path), count }))
    .sort(
      (a, b) =>
        Number(isRegistered.has(b.path)) - Number(isRegistered.has(a.path)) ||
        b.count - a.count ||
        a.label.localeCompare(b.label) ||
        a.path.localeCompare(b.path),
    );
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

import { describe, expect, it } from 'vitest';
import type { StoredSession } from '@aasis21/weft-shared';
import { ALL_FOLDERS, filterStoredSessions, folderOptions, isFiltering } from '@/ui/screens/sessionFilter';

function session(partial: Partial<StoredSession> & { sessionId: string }): StoredSession {
  return {
    title: null,
    cwd: 'C:\\repo',
    repository: null,
    branch: null,
    updatedAt: null,
    ...partial,
  };
}

const sessions: StoredSession[] = [
  session({ sessionId: 'a', title: 'Fix the auth bug', cwd: 'C:\\CLP\\ModernOrder', repository: 'ModernOrder', branch: 'main' }),
  session({ sessionId: 'b', title: 'Add retries', cwd: 'C:\\CLP\\ModernOrder', repository: 'ModernOrder', branch: 'users/me/retry' }),
  session({ sessionId: 'c', title: null, cwd: 'C:\\CLP\\ModernOrder', repository: 'ModernOrder', branch: 'main' }),
  session({ sessionId: 'd', title: 'Weft pairing', cwd: '/home/me/weft', repository: 'weft', branch: 'main' }),
];

describe('folderOptions', () => {
  it('collapses duplicate cwds and counts them', () => {
    expect(folderOptions(sessions)).toEqual([
      { path: 'C:\\CLP\\ModernOrder', label: 'ModernOrder', count: 3 },
      { path: '/home/me/weft', label: 'weft', count: 1 },
    ]);
  });

  it('labels with the basename under either path separator', () => {
    const options = folderOptions([session({ sessionId: 'x', cwd: '/var/tmp/alpha/' }), session({ sessionId: 'y', cwd: 'D:\\work\\beta' })]);
    expect(options.map((o) => o.label)).toEqual(['alpha', 'beta']);
  });

  it('orders by count, then label, so busy checkouts surface first', () => {
    const options = folderOptions([
      session({ sessionId: '1', cwd: '/z' }),
      session({ sessionId: '2', cwd: '/a' }),
      session({ sessionId: '3', cwd: '/a' }),
    ]);
    expect(options.map((o) => o.path)).toEqual(['/a', '/z']);
  });

  it('is empty for an empty list', () => {
    expect(folderOptions([])).toEqual([]);
  });
});

describe('filterStoredSessions', () => {
  const ids = (list: StoredSession[]) => list.map((s) => s.sessionId);

  it('returns everything when unfiltered', () => {
    expect(ids(filterStoredSessions(sessions, { query: '', folder: ALL_FOLDERS }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('narrows to one folder', () => {
    expect(ids(filterStoredSessions(sessions, { query: '', folder: '/home/me/weft' }))).toEqual(['d']);
  });

  it('matches title, repository, branch and cwd case-insensitively', () => {
    expect(ids(filterStoredSessions(sessions, { query: 'AUTH', folder: ALL_FOLDERS }))).toEqual(['a']);
    expect(ids(filterStoredSessions(sessions, { query: 'weft', folder: ALL_FOLDERS }))).toEqual(['d']);
    expect(ids(filterStoredSessions(sessions, { query: 'users/me', folder: ALL_FOLDERS }))).toEqual(['b']);
    expect(ids(filterStoredSessions(sessions, { query: 'clp', folder: ALL_FOLDERS }))).toEqual(['a', 'b', 'c']);
  });

  it('ANDs terms, so each extra word narrows', () => {
    expect(ids(filterStoredSessions(sessions, { query: 'modernorder', folder: ALL_FOLDERS }))).toEqual(['a', 'b', 'c']);
    expect(ids(filterStoredSessions(sessions, { query: 'modernorder retries', folder: ALL_FOLDERS }))).toEqual(['b']);
    expect(ids(filterStoredSessions(sessions, { query: 'modernorder nope', folder: ALL_FOLDERS }))).toEqual([]);
  });

  it('ignores surrounding and repeated whitespace', () => {
    expect(ids(filterStoredSessions(sessions, { query: '   ', folder: ALL_FOLDERS }))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(filterStoredSessions(sessions, { query: '  auth   bug ', folder: ALL_FOLDERS }))).toEqual(['a']);
  });

  it('combines folder and query', () => {
    expect(ids(filterStoredSessions(sessions, { query: 'main', folder: 'C:\\CLP\\ModernOrder' }))).toEqual(['a', 'c']);
  });

  it('falls back to all folders when the selected folder is gone after a refresh', () => {
    expect(ids(filterStoredSessions(sessions, { query: '', folder: 'C:\\deleted' }))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('tolerates rows with null metadata', () => {
    const sparse = [session({ sessionId: 'n', title: null, repository: null, branch: null, cwd: 'C:\\repo' })];
    expect(ids(filterStoredSessions(sparse, { query: 'repo', folder: ALL_FOLDERS }))).toEqual(['n']);
    expect(ids(filterStoredSessions(sparse, { query: 'missing', folder: ALL_FOLDERS }))).toEqual([]);
  });
});

describe('isFiltering', () => {
  it('is false only when nothing is narrowing the list', () => {
    expect(isFiltering({ query: '', folder: ALL_FOLDERS })).toBe(false);
    expect(isFiltering({ query: '   ', folder: ALL_FOLDERS })).toBe(false);
    expect(isFiltering({ query: 'x', folder: ALL_FOLDERS })).toBe(true);
    expect(isFiltering({ query: '', folder: '/a' })).toBe(true);
  });
});

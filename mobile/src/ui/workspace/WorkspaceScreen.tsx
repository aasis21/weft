import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX, ReactNode } from 'react';
import type { WorkspaceCommand, WorkspaceData, WorkspaceEntry } from '@aasis21/weft-shared';
import { WORKSPACE_LIMITS } from '@aasis21/weft-shared';
import { Markdown } from '@/ui/thread/Markdown';
import { fileReference, referencedFilePath } from './fileReference';
import { htmlPreview } from './htmlPreview';
import { diffRows } from './diffRows';
import './workspace.css';

interface Props {
  initial: 'files' | 'changes';
  initialFile?: string | undefined;
  connected: boolean;
  request(command: WorkspaceCommand, signal?: AbortSignal): Promise<WorkspaceData>;
  onBack(): void;
  approvalControls?: ReactNode;
  workspaceName?: string | undefined;
}
interface FileView {
  data: WorkspaceData; text: string; next: number | null; source: boolean;
}
export function WorkspaceScreen({ initial, initialFile, connected, request, onBack, approvalControls, workspaceName }: Props): JSX.Element {
  const [folders, setFolders] = useState<Record<string, WorkspaceData>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['']));
  const [changes, setChanges] = useState<WorkspaceData | null>(null);
  const [file, setFile] = useState<FileView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const abort = useRef<AbortController | null>(null);
  const fileRef = useRef<FileView | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const started = useRef(false);
  const backButton = useRef<HTMLButtonElement>(null);
  const listScroll = useRef(0);
  const diffOrigin = useRef<{ path: string; base: string } | null>(null);
  const fetchingPage = useRef(false);
  fileRef.current = file;
  const closeSnapshot = useCallback((id?: string): void => {
    if (id) void request({ action: 'close', previewId: id }).catch(() => {});
  }, [request]);

  useEffect(() => () => {
    abort.current?.abort();
    closeSnapshot(fileRef.current?.data.previewId);
  }, [closeSnapshot]);
  useEffect(() => {
    backButton.current?.focus();
  }, []);

  const run = useCallback(async (operation: (signal: AbortSignal) => Promise<void>): Promise<void> => {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const current = ++generation.current;
    setLoading(true); setError(null);
    try {
      await operation(controller.signal);
    } catch (error) {
      if (current === generation.current && !controller.signal.aborted) {
        setError(error instanceof Error ? error.message : 'Could not load the workspace.');
      }
    } finally { if (current === generation.current) setLoading(false); }
  }, []);

  const loadFolder = useCallback((path: string, more = false): Promise<void> => run(async (signal) => {
    const previous = folders[path];
    const result = await request({ action: 'list', path,
      ...(more && previous?.cursor ? { cursor: previous.cursor } : {}) }, signal);
    if (signal.aborted) return;
    setFolders((current) => ({ ...current, [path]: {
      ...result, entries: more ? [...(current[path]?.entries ?? []), ...(result.entries ?? [])] : result.entries ?? [],
    } }));
  }), [folders, request, run]);

  const loadChanges = useCallback((more = false): Promise<void> => run(async (signal) => {
    const result = await request({ action: 'changes', ...(more && changes?.cursor ? { cursor: changes.cursor } : {}) }, signal);
    if (signal.aborted) return;
    setChanges((previous) => ({ ...result,
      entries: more ? [...(previous?.entries ?? []), ...(result.entries ?? [])] : result.entries ?? [],
    }));
  }), [changes, request, run]);

  const openFile = useCallback((path: string, format: 'file' | 'diff' = 'file', base?: string): Promise<void> => run(async (signal) => {
    if (!fileRef.current) listScroll.current = scrollRef.current?.scrollTop ?? 0;
    const reference = fileReference(path);
    const data = await request({ action: 'open', path: reference?.path ?? path, format, ...(base ? { base } : {}) }, signal);
    let retained = false;
    try {
    let text = data.text ?? '', next = data.nextOffset ?? null;
    const bytes = (): number => new TextEncoder().encode(text).length;
    while (next !== null && (data.format === 'html' || reference?.line && text.split('\n').length < reference.line)) {
      if (!data.previewId) throw new Error('The laptop returned an invalid preview.');
      const page = await request({ action: 'page', previewId: data.previewId, offset: next }, signal);
      if (page.revision !== data.revision || page.offset !== next) throw new Error('The preview revision changed. Refresh.');
      text += page.text ?? ''; next = page.nextOffset ?? null;
      if (bytes() > (data.format === 'html' ? WORKSPACE_LIMITS.htmlBytes : WORKSPACE_LIMITS.fileBytes)) throw new Error('Preview exceeds the size limit.');
    }
    if (signal.aborted) { closeSnapshot(data.previewId); return; }
    closeSnapshot(fileRef.current?.data.previewId);
    setFile({ data, text, next, source: Boolean(reference?.line) || data.format === 'source' || data.format === 'diff' });
    retained = true;
    if (format === 'diff' && base) diffOrigin.current = { path: data.path ?? path, base };
    else if (diffOrigin.current?.path !== data.path) diffOrigin.current = null;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
    if (reference?.line) window.requestAnimationFrame(() => {
      scrollRef.current?.querySelector(`[data-line="${reference.line}"]`)?.scrollIntoView({ block: 'center' });
    });
    } finally {
      if (!retained) closeSnapshot(data.previewId);
    }
  }), [request, run, closeSnapshot]);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (initialFile) void openFile(initialFile);
    else if (initial === 'changes') void loadChanges();
    else void loadFolder('');
  }, [initial, initialFile, openFile, loadChanges, loadFolder]);

  const loadMore = (): void => {
    const current = fileRef.current;
    if (!current?.data.previewId || current.next === null || loading || fetchingPage.current) return;
    fetchingPage.current = true;
    const previewId = current.data.previewId, offset = current.next;
    void run(async (signal) => {
      const page = await request({ action: 'page', previewId, offset }, signal);
      if (signal.aborted) return;
      if (page.revision !== current.data.revision || page.offset !== current.text.length) throw new Error('Preview changed. Refresh.');
      const text = current.text + (page.text ?? '');
      if (new TextEncoder().encode(text).length > WORKSPACE_LIMITS.fileBytes) throw new Error('Preview exceeds the size limit.');
      setFile({ ...current, text, next: page.nextOffset ?? null });
    }).finally(() => { fetchingPage.current = false; });
  };
  const refresh = (): void => {
    if (file?.data.path) {
      const path = file.data.path;
      if (file.data.format === 'diff') {
        void run(async (signal) => {
          const latest = await request({ action: 'changes' }, signal);
          if (!signal.aborted) {
            setChanges(latest);
            void openFile(path, 'diff', latest.base ?? undefined);
          }
        });
      } else void openFile(path);
    }
    else if (initialFile) void openFile(initialFile);
    else if (initial === 'changes') void loadChanges();
    else {
      void run(async (signal) => {
        for (const path of expanded) {
          const result = await request({ action: 'list', path }, signal);
          if (signal.aborted) return;
          setFolders((current) => ({ ...current, [path]: result }));
        }
      });
    }
  };
  const back = (): void => {
    abort.current?.abort(); ++generation.current; setLoading(false); setError(null);
    if (!file || initialFile) { onBack(); return; }
    closeSnapshot(file.data.previewId); setFile(null);
    window.requestAnimationFrame(() => { if (scrollRef.current) scrollRef.current.scrollTop = listScroll.current; });
  };
  const renderEntries = (path: string, depth = 0): JSX.Element => <ul className="workspace-tree">
    {folders[path] && !folders[path].entries?.length && !loading ? <li className="workspace-meta">No visible files in this folder.</li> : null}
    {(folders[path]?.entries ?? []).map((entry) => <li key={entry.path}>
      <button type="button" disabled={!connected || loading}
        aria-expanded={entry.kind === 'folder' ? expanded.has(entry.path) : undefined}
        onClick={() => {
          if (entry.kind !== 'folder') { void openFile(entry.path); return; }
          setExpanded((current) => {
            const next = new Set(current);
            if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path);
            return next;
          });
          if (!expanded.has(entry.path) && !Object.prototype.hasOwnProperty.call(folders, entry.path)) void loadFolder(entry.path);
        }}>
        <span aria-hidden="true">{entry.kind === 'folder' ? expanded.has(entry.path) ? '▾' : '▸' : '·'}</span>
        <span>{entry.name}</span>
      </button>
      {entry.kind === 'folder' && expanded.has(entry.path) ? renderEntries(entry.path, depth + 1) : null}
    </li>)}
    {folders[path]?.cursor ? <li><button type="button" disabled={loading || !connected}
      onClick={() => void loadFolder(path, true)}>Load more files</button></li> : null}
  </ul>;
  const srcdoc = useMemo(() => file?.data.format === 'html' && !file.source ? htmlPreview(file.text) : undefined, [file]);
  const openChange = (entry: WorkspaceEntry): void => {
    if (entry.status === '?') void openFile(entry.path);
    else void openFile(entry.path, 'diff', changes?.base ?? undefined);
  };
  const rows = useMemo(() => file?.data.format === 'diff' ? diffRows(file.text) : [], [file]);
  return <main className="workspace-screen">
    <header className="workspace-header">
      <button ref={backButton} type="button" onClick={back}>‹ {file && !initialFile ? initial === 'files' ? 'Files' : 'Changes' : 'Chat'}</button>
      <strong>{file?.data.path?.split('/').pop() ?? (initialFile ? 'Preview' : initial === 'files' ? 'Files' : 'Changes')}</strong>
      <button type="button" disabled={!connected || loading} onClick={refresh}>Refresh</button>
    </header>
    {!file && workspaceName ? <div className="workspace-meta">{workspaceName}</div> : null}
    {!connected ? <p role="status" className="workspace-notice">Saved preview · laptop offline. Reconnect to fetch more.</p> : null}
    {loading ? <p role="status" className="workspace-notice">Loading from laptop… Respond to any Copilot approval to continue.</p> : null}
    {approvalControls}
    {error ? <div role="alert" className="workspace-error">{error}<button type="button" disabled={!connected || loading} onClick={refresh}>Retry</button></div> : null}
    {file ? <>
      <div className="workspace-meta">
        <div>{file.data.path}</div>
        <span>Read-only · captured {new Date(file.data.capturedAt ?? 0).toLocaleTimeString()} · revision {file.data.revision?.slice(0, 8)}</span>
        {file.data.base ? <span>HEAD {file.data.base.slice(0, 8)} → captured working file</span> : null}
        {diffOrigin.current ? <div className="workspace-modes">
          <button type="button" disabled={loading || !connected} aria-pressed={file.data.format === 'diff'}
            onClick={() => { const origin = diffOrigin.current; if (origin) void openFile(origin.path, 'diff', origin.base); }}>Diff</button>
          <button type="button" disabled={loading || !connected || changes?.entries?.find((entry) => entry.path === file.data.path)?.status === 'D'}
            aria-pressed={file.data.format !== 'diff'} onClick={() => { if (file.data.path) void openFile(file.data.path); }}>Current file</button>
        </div> : null}
        {file.data.format !== 'source' && file.data.format !== 'diff' ? <div className="workspace-modes">
          <button type="button" aria-pressed={!file.source} onClick={() => setFile({ ...file, source: false })}>Preview</button>
          <button type="button" aria-pressed={file.source} onClick={() => setFile({ ...file, source: true })}>Source</button>
        </div> : null}
      </div>
      <div className="workspace-content" ref={scrollRef} onScroll={(event) => {
        if (file.next !== null && event.currentTarget.scrollHeight - event.currentTarget.scrollTop - event.currentTarget.clientHeight < 150) loadMore();
      }}>
        {!file.text.length ? <p>{file.data.format === 'diff' ? 'No differences against this baseline.' : 'Empty file.'}</p> : null}
        {srcdoc ? <iframe title={`Preview of ${file.data.path}`} sandbox="" referrerPolicy="no-referrer" srcDoc={srcdoc} /> :
          !file.source && file.data.format === 'markdown'
            ? <Markdown text={file.text} allowImages={false} onOpenFile={(href) => {
              const reference = fileReference(href);
              if (reference) {
                void openFile(referencedFilePath(file.data.path ?? '', reference));
              }
            }} />
            : file.data.format === 'diff' ? <pre className="workspace-diff">{rows.map((row, i) => <div key={i} className={row.kind}>
              <span className="workspace-line">{row.before ?? ''}</span><span className="workspace-line">{row.after ?? ''}</span>{row.text || ' '}
            </div>)}</pre>
            : <pre className="workspace-source">{file.text.split('\n').map((line, i) =>
              <div key={i} data-line={i + 1}><span className="workspace-line">{i + 1}</span>{line || ' '}</div>)}</pre>}
        {file.next !== null ? <button type="button" disabled={loading || !connected} onClick={loadMore}>Load more content</button> : null}
      </div>
    </> : <div className="workspace-content" ref={scrollRef}>
      {initial === 'files' ? renderEntries('') : <>
        {changes?.base ? <p className="workspace-meta">HEAD {changes.base.slice(0, 8)} → working files</p> : null}
        <ul className="workspace-tree">{(changes?.entries ?? []).map((entry) => <li key={entry.path}>
          <button type="button" aria-label={`${entry.status} ${entry.path}`} disabled={loading || !connected} onClick={() => openChange(entry)}>
            <span>{entry.status === '?' ? 'New' : entry.status}</span>
            <span>{entry.oldPath ? `${entry.oldPath} → ` : ''}{entry.path}</span>
          </button>
        </li>)}</ul>
        {changes?.cursor ? <button type="button" disabled={loading || !connected} onClick={() => void loadChanges(true)}>Load more changes</button> : null}
        {changes && !changes.entries?.length && !changes.cursor && !loading ? <p>No changes in this workspace.</p> : null}
      </>}
    </div>}
  </main>;
}

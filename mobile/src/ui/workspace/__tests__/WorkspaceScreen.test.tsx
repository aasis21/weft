import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import type { WorkspaceCommand, WorkspaceData } from '@aasis21/weft-shared';
import { WorkspaceScreen } from '../WorkspaceScreen';
import { fileReference, referencedFilePath } from '../fileReference';
import { htmlPreview } from '../htmlPreview';
import { diffRows } from '../diffRows';
import { Markdown } from '@/ui/thread/Markdown';

const preview = (path: string, text = 'first\nsecond\n', format: 'source' | 'html' | 'markdown' | 'diff' = 'source'): WorkspaceData => ({
  action: 'open', path, format, previewId: '12345678-1234-4234-8234-123456789012', revision: 'revision',
  capturedAt: 1234, text, offset: 0, nextOffset: null,
});
describe('workspace viewer', () => {
  it('shows independent current-folder and touched trees, fetches folders lazily and restores both on Back', async () => {
    const request = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceData> => {
      if (command.action === 'list') return { action: 'list', scope: command.scope ?? 'workspace', entries:
        command.scope === 'touched' ? [{ path: 'docs/file.md', name: 'file.md', kind: 'file', access: 'written' }]
        : command.path ? [{ path: 'docs/file.md', name: 'file.md', kind: 'file' }, { path: 'docs/unread.md', name: 'unread.md', kind: 'file' }]
        : [{ path: 'docs', name: 'docs', kind: 'folder' }], cursor: null };
      if (command.action === 'open') return preview(command.path, '# Read me', 'markdown');
      return { action: 'close' };
    });
    const onBack = vi.fn();
    render(<WorkspaceScreen initial="files" connected request={request} onBack={onBack} workspacePath={'C:\\repo'} workspaceName="repo" />);
    const current = within(screen.getByRole('region', { name: 'Current folder' }));
    const touched = within(screen.getByRole('region', { name: 'Agent-touched files' }));
    await touched.findByRole('button', { name: 'docs' });
    expect(request).toHaveBeenCalledTimes(2);
    expect(current.getByText('C:\\repo')).toBeInTheDocument();
    fireEvent.click(touched.getByRole('button', { name: 'docs' }));
    expect(touched.getByText('Written')).toBeInTheDocument();
    expect(request).toHaveBeenCalledTimes(2);
    fireEvent.click(current.getByRole('button', { name: 'docs' }));
    await current.findByRole('button', { name: 'docs/unread.md' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled());
    expect(request).toHaveBeenLastCalledWith({ action: 'list', scope: 'workspace', path: 'docs' }, expect.any(AbortSignal));
    expect(touched.queryByRole('button', { name: 'docs/unread.md' })).not.toBeInTheDocument();
    expect(request.mock.calls.some(([command]) => command.action === 'open')).toBe(false);
    fireEvent.click(current.getByRole('button', { name: 'docs/unread.md' }));
    await screen.findByRole('heading', { name: 'Read me' });
    fireEvent.click(screen.getByRole('button', { name: '‹ Files' }));
    expect(within(screen.getByRole('region', { name: 'Current folder' })).getByRole('button', { name: 'docs/unread.md' })).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Agent-touched files' })).getByRole('button', { name: 'docs/file.md' })).toBeInTheDocument();
    expect(onBack).not.toHaveBeenCalled();
  });

  it('opens an external touched path exactly and does not browse its parent directory', async () => {
    const path = 'C:\\Users\\demo\\reports\\outside.md';
    const request = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceData> => {
      if (command.action === 'list') return { action: 'list', scope: command.scope ?? 'workspace', entries:
        command.scope === 'touched' ? [{ path, name: 'outside.md', kind: 'file', access: 'read-written', external: true }] : [], cursor: null };
      if (command.action === 'open') return preview(path, '# Outside workspace', 'markdown');
      return { action: 'close' };
    });
    render(<WorkspaceScreen initial="files" connected request={request} onBack={vi.fn()} />);
    const touched = within(screen.getByRole('region', { name: 'Agent-touched files' }));
    await touched.findByRole('button', { name: 'Outside workspace' });
    for (const folder of ['Outside workspace', 'C:', 'Users', 'demo', 'reports']) {
      fireEvent.click(touched.getByRole('button', { name: folder }));
    }
    expect(touched.getByText('Read and written · Outside workspace')).toBeInTheDocument();
    expect(request.mock.calls.filter(([command]) => command.action === 'list')).toHaveLength(2);
    fireEvent.click(touched.getByRole('button', { name: path }));
    await screen.findByRole('heading', { name: 'Outside workspace' });
    expect(request).toHaveBeenCalledWith({ action: 'open', path, format: 'file' }, expect.any(AbortSignal));
    expect(request.mock.calls.filter(([command]) => command.action === 'list')).toHaveLength(2);
    expect(request.mock.calls.some(([command]) => command.action === 'list' && command.path !== '')).toBe(false);
  });

  it('paginates each tree independently and keeps both visible if Refresh fails', async () => {
    let failRefresh = false;
    const request = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceData> => {
      if (command.action !== 'list') return { action: 'close' };
      if (failRefresh) throw new Error('Copilot policy is unavailable.');
      const touched = command.scope === 'touched';
      const path = `${touched ? 'touched' : 'current'}${command.cursor ? '-more' : ''}.txt`;
      return { action: 'list', scope: command.scope ?? 'workspace', entries: [{ path, name: path, kind: 'file' }],
        cursor: command.cursor ? null : touched ? 'touched-page' : 'folder-page' };
    });
    render(<WorkspaceScreen initial="files" connected request={request} onBack={vi.fn()} />);
    await screen.findByRole('button', { name: 'Load more touched files' });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Load more touched files' }));
    await screen.findByRole('button', { name: 'touched-more.txt' });
    expect(request).toHaveBeenLastCalledWith({ action: 'list', scope: 'touched', path: '', cursor: 'touched-page' }, expect.any(AbortSignal));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled());
    fireEvent.click(screen.getByRole('button', { name: 'Load more folder entries' }));
    await screen.findByRole('button', { name: 'current-more.txt' });
    expect(request).toHaveBeenLastCalledWith({ action: 'list', scope: 'workspace', path: '', cursor: 'folder-page' }, expect.any(AbortSignal));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Refresh' })).not.toBeDisabled());
    failRefresh = true;
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Copilot policy is unavailable.');
    expect(screen.getByRole('button', { name: 'current-more.txt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'touched-more.txt' })).toBeInTheDocument();
  });

  it('opens a file reference directly without reading directory contents', async () => {
    const request = vi.fn().mockResolvedValue(preview('file.txt'));
    render(<WorkspaceScreen initial="files" initialFile="file.txt#L2" connected request={request} onBack={vi.fn()} />);
    await screen.findByText('second');
    expect(request).toHaveBeenCalledWith({ action: 'open', path: 'file.txt', format: 'file' }, expect.any(AbortSignal));
    expect(request.mock.calls.some(([command]) => command.action === 'list')).toBe(false);
  });

  it('opens Changes as path metadata and requests only the selected diff', async () => {
    const base = 'a'.repeat(40);
    const request = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceData> => command.action === 'changes'
      ? { action: 'changes', base, entries: [{ name: 'a.ts', path: 'a.ts', kind: 'file', status: 'M' }] }
      : command.action === 'open' ? { ...preview('a.ts', '-old\n+new', 'diff'), base } : { action: 'close' });
    render(<WorkspaceScreen initial="changes" connected request={request} onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /M a.ts/ }));
    await screen.findByText('+new');
    expect(request).toHaveBeenCalledWith({ action: 'open', path: 'a.ts', format: 'diff', base }, expect.any(AbortSignal));
  });

  it('keeps captured text visible offline and prevents additional reads', async () => {
    const request = vi.fn().mockResolvedValue(preview('file.txt'));
    const props = { initial: 'files' as const, initialFile: 'file.txt', connected: true, request, onBack: vi.fn() };
    const { rerender } = render(<WorkspaceScreen {...props} />);
    await screen.findByText('second');
    rerender(<WorkspaceScreen {...props} connected={false} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByText(/laptop offline/)).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('renders HTML as an opaque sandbox and never enables scripts', async () => {
    const request = vi.fn().mockResolvedValue(preview('report.html', '<h1>Report</h1><script>parent.hacked=true</script>', 'html'));
    const { container } = render(<WorkspaceScreen initial="files" initialFile="report.html" connected request={request} onBack={vi.fn()} />);
    await waitFor(() => expect(container.querySelector('iframe')).toBeTruthy());
    const iframe = container.querySelector('iframe')!;
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.srcdoc).not.toMatch(/<script>/);
    expect(iframe.srcdoc).toContain('Content-Security-Policy');
  });

  it('keeps an existing preview when Refresh fails and displays the failure', async () => {
    let opens = 0;
    const request = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceData> => {
      if (command.action === 'close') return { action: 'close' };
      if (++opens === 1) return preview('file.txt', 'Captured text');
      throw new Error('The file is now denied.');
    });
    render(<WorkspaceScreen initial="files" initialFile="file.txt" connected request={request} onBack={vi.fn()} />);
    await screen.findByText('Captured text');
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Captured text')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('now denied');
  });

  it('only requests another source page when the user asks for more', async () => {
    const request = vi.fn(async (command: WorkspaceCommand): Promise<WorkspaceData> => {
      if (command.action === 'open') return { ...preview('file.txt', 'first\n'), nextOffset: 6 };
      if (command.action === 'page') return { action: 'page', previewId: command.previewId,
        revision: 'revision', text: 'second', offset: 6, nextOffset: null };
      return { action: 'close' };
    });
    render(<WorkspaceScreen initial="files" initialFile="file.txt" connected request={request} onBack={vi.fn()} />);
    await screen.findByText('first');
    expect(request.mock.calls.some(([command]) => command.action === 'page')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Load more content' }));
    await screen.findByText('second');
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ action: 'page', offset: 6 }), expect.any(AbortSignal));
  });
});

describe('file links and HTML isolation', () => {
  it('keeps old and new line numbers separate in a unified diff', () => {
    const rows = diffRows('@@ -3,2 +3,2 @@\n context\n-old\n+new\n\\ No newline at end of file');
    expect(rows[1]).toEqual({ text: ' context', kind: '', before: 3, after: 3 });
    expect(rows[2]).toEqual({ text: '-old', kind: 'delete', before: 4, after: null });
    expect(rows[3]).toEqual({ text: '+new', kind: 'insert', before: null, after: 4 });
    expect(rows[4].text).toContain('No newline');
  });
  it('recognizes explicit local file links without making commands or unsafe URLs clickable', () => {
    expect(fileReference('src/file.ts#L42')).toEqual({ path: 'src/file.ts', line: 42 });
    expect(fileReference('C:\\repo\\my%20file.md')).toEqual({ path: 'C:\\repo\\my file.md' });
    expect(referencedFilePath('docs/guide.md', { path: '../README.md', line: 2 })).toBe('README.md#L2');
    expect(referencedFilePath('guide.md', { path: '../outside.md' })).toBe('../outside.md');
    expect(referencedFilePath('guide.md', { path: 'C:\\reports\\outside.md', line: 2 })).toBe('C:\\reports\\outside.md#L2');
    for (const input of ['https://example.com/a.md', 'javascript:alert(1)', '//server/a.txt', 'data:text/html,x', 'npm run build']) expect(fileReference(input)).toBeNull();
    const open = vi.fn();
    render(<Markdown text={'[Open](src/file.ts#L42)\n\n`src/file.ts`\n\n[Unsafe](javascript:alert(1))'} onOpenFile={open} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));
    expect(open).toHaveBeenCalledWith('src/file.ts#L42');
    expect(screen.queryByRole('link', { name: 'Unsafe' })).not.toBeInTheDocument();
  });

  it('removes active HTML, forms, external assets and unsafe image data types', () => {
    const html = htmlPreview('<script>x</script><iframe src="http://localhost"></iframe><img src="http://secret"><img src="data:image/svg+xml,x"><form action="http://secret"><input></form><a href="http://secret">link</a><p onclick="x">Safe</p>');
    expect(html).not.toMatch(/<script|<iframe|<form|<input|onclick=|href=|src="http|image\/svg/);
    expect(html).toContain('External image omitted');
    expect(html).toContain("default-src 'none'");
  });
});

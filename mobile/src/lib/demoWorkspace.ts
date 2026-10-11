import { validWorkspaceRequest, workspaceResult, WORKSPACE_LIMITS } from '@aasis21/weft-shared';
import type { SecureChannel, WorkspaceData } from '@aasis21/weft-shared';

const files: Record<string, { format: 'source' | 'markdown' | 'html'; text: string }> = {
  'README.md': { format: 'markdown', text: '# Demo workspace\n\nOpen the [report](reports/summary.html) or inspect [source](src/app.ts#L2).\n\nThese files are simulated; no laptop files are read.' },
  'src/app.ts': { format: 'source', text: 'export const title = "Weft preview";\nexport const version = 2;\n' },
  'reports/summary.html': { format: 'html', text: '<!doctype html><html><head><style>body{font:16px system-ui;padding:24px}h1{color:#166534}</style></head><body><h1>Demo report</h1><p>Files, Changes, and chat links open the same read-only preview.</p></body></html>' },
};
const patch = 'diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n export const title = "Weft preview";\n-export const version = 1;\n+export const version = 2;\n';
export function attachDemoWorkspace(channel: SecureChannel): () => void {
  const previews = new Map<string, { text: string; revision: string }>();
  return channel.onEvent('control', (message) => {
    if (message.eventSubtype !== 'workspace_request' || !validWorkspaceRequest(message.msg)) return;
    const input = message.msg;
    let data: WorkspaceData;
    const path = 'path' in input ? input.path.replace(/\\/g, '/').replace(/^\.\//, '') : '';
    if (input.action === 'list') {
      const prefix = path ? path + '/' : '';
      const names = new Map<string, 'file' | 'folder'>();
      for (const file of Object.keys(files).filter((file) => file.startsWith(prefix))) {
        const tail = file.slice(prefix.length);
        names.set(tail.split('/')[0], tail.includes('/') ? 'folder' : 'file');
      }
      data = { action: 'list', path, entries: [...names].map(([name, kind]) => ({ name, path: prefix + name, kind })), cursor: null };
    } else if (input.action === 'changes') {
      data = { action: 'changes', entries: [{ name: 'app.ts', path: 'src/app.ts', kind: 'file', status: 'M' }],
        base: 'a'.repeat(40), cursor: null };
    } else if (input.action === 'open' && files[path]) {
      const file = files[path], diff = input.format === 'diff';
      const previewId = crypto.randomUUID(), text = diff ? patch : file.text;
      previews.set(previewId, { text, revision: 'demo-revision' });
      data = { action: 'open', path, previewId, format: diff ? 'diff' : file.format, revision: 'demo-revision',
        text: text.slice(0, WORKSPACE_LIMITS.pageBytes), offset: 0, nextOffset: text.length > WORKSPACE_LIMITS.pageBytes ? WORKSPACE_LIMITS.pageBytes : null,
        capturedAt: Date.now(), totalLines: text.split('\n').length, ...(diff ? { base: 'a'.repeat(40) } : {}) };
    } else if (input.action === 'page' && previews.has(input.previewId)) {
      const snapshot = previews.get(input.previewId);
      if (!snapshot) return;
      const end = Math.min(snapshot.text.length, input.offset + WORKSPACE_LIMITS.pageBytes);
      data = { action: 'page', previewId: input.previewId, revision: snapshot.revision,
        text: snapshot.text.slice(input.offset, end), offset: input.offset, nextOffset: end < snapshot.text.length ? end : null };
    } else if (input.action === 'close') {
      previews.delete(input.previewId); data = { action: 'close' };
    } else {
      void channel.send(workspaceResult({ requestId: input.requestId, error: { code: 'missing', message: 'This file is not part of the demo.' } }));
      return;
    }
    void channel.send(workspaceResult({ requestId: input.requestId, data }));
  });
}

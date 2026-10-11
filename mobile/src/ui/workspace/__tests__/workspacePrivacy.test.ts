import { describe, expect, it } from 'vitest';
import { toDebugEvent, redactClipboardEvent } from '@/lib/eventLog';
import { workspaceResult } from '@aasis21/weft-shared';
describe('workspace diagnostics', () => {
  it('never stores file contents or names in debug events', () => {
    const event = toDebugEvent('in', workspaceResult({
      requestId: 'r1', data: { action: 'open', path: 'private.md', text: 'private contents' },
    }), 1, 'test');
    expect(event.msg).toEqual({ private: true });
    expect(JSON.stringify(event)).not.toContain('private.md');
    expect(JSON.stringify(event)).not.toContain('private contents');
  });
  it('redacts native workspace approval arguments when saved or restored', () => {
    const event = redactClipboardEvent({
      id: '1', dir: 'in', eventType: 'approval', eventSubtype: 'request', ts: 1, senderName: 'test',
      msg: { toolName: 'weft_workspace_access', toolArgs: { path: 'private.md' } },
    });
    expect(event.msg).toEqual({ private: true });
  });
});

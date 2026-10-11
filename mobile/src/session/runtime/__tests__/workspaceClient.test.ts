import { describe, it, expect, vi } from 'vitest';
import type { EventEnvelope } from '@aasis21/weft-shared';
import { WorkspaceClient } from '../workspaceClient';
describe('workspace request correlation', () => {
  it('matches replies without exposing file contents to session history', async () => {
    const sent: EventEnvelope[] = [];
    const client = new WorkspaceClient(async (message) => { sent.push(message); });
    const pending = client.request({ action: 'list', path: '' });
    const id = sent[0].msg as { requestId: string };
    client.receive({ requestId: 'wrong', data: { action: 'list', entries: [] } });
    client.receive({ requestId: id.requestId, data: { action: 'list', entries: [] } });
    expect(await pending).toEqual({ action: 'list', entries: [] });
    client.dispose();
  });
  it('rejects explicitly on disconnect and cancellation', async () => {
    const client = new WorkspaceClient(vi.fn().mockResolvedValue(undefined));
    const signal = new AbortController();
    const cancelled = client.request({ action: 'changes' }, signal.signal);
    signal.abort();
    await expect(cancelled).rejects.toThrow(/cancelled/);
    const disconnected = client.request({ action: 'changes' });
    client.dispose();
    await expect(disconnected).rejects.toThrow(/connection ended/);
  });

  it('does not substitute a touched-file listing for a current-folder request', async () => {
    const sent: EventEnvelope[] = [];
    const client = new WorkspaceClient(async (message) => { sent.push(message); });
    const pending = client.request({ action: 'list', scope: 'workspace', path: '' });
    const id = sent[0].msg as { requestId: string };
    client.receive({ requestId: id.requestId, data: { action: 'list', scope: 'touched', entries: [] } });
    await expect(pending).rejects.toThrow(/unexpected workspace response/);
    client.dispose();
  });
});

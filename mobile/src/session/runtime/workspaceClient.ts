import { workspaceRequest, validWorkspaceResult } from '@aasis21/weft-shared';
import type { EventEnvelope, WorkspaceCommand, WorkspaceData } from '@aasis21/weft-shared';

export class WorkspaceClient {
  private readonly pending = new Map<string, {
    resolve(data: WorkspaceData): void; reject(error: Error): void;
    cleanup(): void;
    action: WorkspaceCommand['action'];
    scope?: 'workspace' | 'touched';
  }>();
  constructor(private readonly send: (message: EventEnvelope) => Promise<void>) {}

  request(command: WorkspaceCommand, signal?: AbortSignal): Promise<WorkspaceData> {
    if (signal?.aborted) return Promise.reject(new Error('Preview request cancelled.'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const cancel = (): void => {
        this.pending.get(requestId)?.cleanup();
        this.pending.delete(requestId);
        reject(new Error('Preview request cancelled.'));
      };
      const timer = setTimeout(() => {
        this.pending.get(requestId)?.cleanup();
        this.pending.delete(requestId);
        reject(new Error('The laptop did not answer. Retry when it is online.'));
      }, 60_000);
      const cleanup = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', cancel);
      };
      signal?.addEventListener('abort', cancel, { once: true });
      this.pending.set(requestId, { resolve, reject, cleanup, action: command.action,
        ...(command.action === 'list' && command.scope ? { scope: command.scope } : {}) });
      void this.send(workspaceRequest({ ...command, requestId })).catch(() => {
        const entry = this.pending.get(requestId);
        entry?.cleanup();
        this.pending.delete(requestId);
        entry?.reject(new Error('Could not reach the laptop. Reconnect and retry.'));
      });
    });
  }

  receive(value: unknown): void {
    if (!validWorkspaceResult(value)) return;
    const entry = this.pending.get(value.requestId);
    if (!entry) {
      if (value.data?.action === 'open' && value.data.previewId) {
        void this.send(workspaceRequest({ action: 'close', previewId: value.data.previewId,
          requestId: crypto.randomUUID() })).catch(() => {});
      }
      return;
    }
    entry.cleanup();
    this.pending.delete(value.requestId);
    if (value.error) entry.reject(new Error(value.error.message));
    else if (value.data?.action === entry.action && (entry.scope === undefined || value.data.scope === entry.scope)) entry.resolve(value.data);
    else entry.reject(new Error('The laptop returned an unexpected workspace response. Retry.'));
  }

  dispose(): void {
    for (const entry of this.pending.values()) {
      entry.cleanup();
      entry.reject(new Error('The workspace connection ended. Reconnect and retry.'));
    }
    this.pending.clear();
  }
}

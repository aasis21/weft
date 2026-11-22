import { afterEach, expect, it, vi } from 'vitest';
import { runConnectivityProbe } from '@/lib/wsProbe';

afterEach(() => vi.unstubAllGlobals());

it('checks the configured relay separately without printing its URL or close reason', async () => {
  const relay = 'wss://relay.example/realtime/v1/websocket?apikey=synthetic-key';
  const endpoints: string[] = [];
  class ProbeSocket {
    onopen?: () => void;
    onerror?: () => void;
    onclose?: (event: Pick<CloseEvent, 'code' | 'reason'>) => void;

    constructor(url: string) {
      endpoints.push(url);
      queueMicrotask(() => {
        if (url !== relay) this.onopen?.();
        else {
          this.onerror?.();
          this.onclose?.({ code: 1006, reason: 'synthetic-key' });
        }
      });
    }

    close(): void {}
  }
  vi.stubGlobal('WebSocket', ProbeSocket);

  const summary = await runConnectivityProbe(relay);
  expect(endpoints).toEqual(['wss://echo.websocket.org', relay]);
  expect(summary).toContain('[OPEN] Public echo');
  expect(summary).toContain('[ERROR] Supabase Realtime relay');
  expect(summary).toContain('code 1006');
  expect(summary).not.toMatch(/synthetic-key|apikey|relay\.example/);
});

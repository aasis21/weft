/**
 * Compare a public echo socket with the relay from the failed pairing. A successful
 * WebSocket upgrade does not prove private-channel authorization or Weft pairing.
 */

export interface ProbeResult {
  label: string;
  outcome: 'open' | 'error' | 'timeout';
  detail: string;
  ms: number;
}

function probeOne(label: string, url: string, timeoutMs = 8000): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    let errorTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(errorTimer);
      try {
        ws?.close();
      } catch {
        // best-effort cleanup
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ label, outcome: 'timeout', detail: `no connection within ${timeoutMs}ms`, ms: Date.now() - started }),
      timeoutMs,
    );
    try {
      ws = new WebSocket(url);
    } catch {
      finish({
        label,
        outcome: 'error',
        detail: 'WebSocket could not be opened.',
        ms: Date.now() - started,
      });
      return;
    }
    ws.onopen = () => finish({ label, outcome: 'open', detail: 'socket connected', ms: Date.now() - started });
    ws.onerror = () => {
      errorTimer ??= setTimeout(() => finish({ label, outcome: 'error',
        detail: 'WebSocket error (no reason exposed by the browser)', ms: Date.now() - started }), 200);
    };
    ws.onclose = (ev: CloseEvent) =>
      finish({
        label,
        outcome: 'error',
        detail: `socket closed before opening (code ${ev.code})`,
        ms: Date.now() - started,
      });
  });
}

export async function runConnectivityProbe(relay: string | null): Promise<string> {
  const probes = [probeOne('Public echo', 'wss://echo.websocket.org')];
  if (relay) probes.push(probeOne('Supabase Realtime relay', relay));
  const results = await Promise.all(probes);
  return results
    .map((r) => `[${r.outcome.toUpperCase()}] ${r.label} (${r.ms}ms)\n  ${r.detail}`)
    .join('\n\n');
}

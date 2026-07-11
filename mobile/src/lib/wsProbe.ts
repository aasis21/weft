/**
 * Raw-WebSocket connectivity probe for the debug panel.
 *
 * The Supabase JS client (and Phoenix Channels underneath it) normalizes every connect failure
 * into a generic "channel error: transport failure" with no code or reason — by design, browsers
 * never expose *why* a socket failed, for security. A bare `new WebSocket(...)` gives us the raw
 * `CloseEvent` (numeric `code` + `reason`) or a plain `error` Event instead, which is enough to
 * tell "reached the server and got rejected" apart from "never left the device" (DNS/TLS/firewall).
 *
 * A single probe against a known-good public echo server is enough: it proves the WebView can
 * open ANY external WebSocket. The real relay endpoint isn't known until the user scans a
 * pairing QR (mobile has no build-time transport config — everything comes from the scan; see
 * `mobile/src/lib/weftClient.ts` → `createTransportFromDescriptor`), so there's nothing
 * meaningful to probe pre-pair.
 */

export interface ProbeResult {
  label: string;
  url: string;
  outcome: 'open' | 'error' | 'timeout';
  detail: string;
  ms: number;
}

function probeOne(label: string, url: string, timeoutMs = 8000): Promise<ProbeResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const finish = (result: ProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws?.close();
      } catch {
        // best-effort cleanup
      }
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ label, url, outcome: 'timeout', detail: `no open/error event within ${timeoutMs}ms`, ms: Date.now() - started }),
      timeoutMs,
    );
    try {
      ws = new WebSocket(url);
    } catch (err) {
      finish({
        label,
        url,
        outcome: 'error',
        detail: `constructor threw: ${err instanceof Error ? err.message : String(err)}`,
        ms: Date.now() - started,
      });
      return;
    }
    ws.onopen = () => finish({ label, url, outcome: 'open', detail: 'connected', ms: Date.now() - started });
    ws.onerror = () => finish({ label, url, outcome: 'error', detail: 'WebSocket error event (no reason exposed by the browser)', ms: Date.now() - started });
    ws.onclose = (ev: CloseEvent) =>
      finish({
        label,
        url,
        outcome: settled ? 'open' : 'error',
        detail: `closed: code=${ev.code} reason="${ev.reason || 'n/a'}" wasClean=${ev.wasClean}`,
        ms: Date.now() - started,
      });
  });
}

/** Runs the echo probe and renders a plain-text block for the debug panel's <pre>. */
export async function runConnectivityProbe(): Promise<string> {
  const results: ProbeResult[] = [];

  results.push(await probeOne('public echo (wss://echo.websocket.org)', 'wss://echo.websocket.org'));

  return results
    .map((r) => `[${r.outcome.toUpperCase()}] ${r.label} (${r.ms}ms)\n  ${r.url}\n  ${r.detail}`)
    .join('\n\n');
}

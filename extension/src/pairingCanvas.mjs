// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import QRCode from "qrcode";

export async function createPairingCanvasServer({ preparePairing, status }) {
  const prefix = `/${randomBytes(24).toString("hex")}`;
  let origin;
  let cachedCode = null;
  let cachedQr = null;
  let setupError = null;
  let pairing = false;

  async function snapshot() {
    const current = status();
    const connected = current.state === "active";
    const paired = connected || current.paired === true;
    const payload = current.pairingPayload;
    const expired = !paired && payload?.expiresAt <= Date.now();
    const code = !paired && !expired && payload ? JSON.stringify(payload) : null;
    if (code !== cachedCode) {
      const qr = code ? await QRCode.toDataURL(code, { width: 480, margin: 4 }) : null;
      cachedQr = qr;
      cachedCode = code;
    }
    return {
      state: current.state,
      connected,
      paired,
      expired,
      transport: payload?.transport?.kind ?? null,
      expiresAt: payload?.expiresAt ?? null,
      code,
      qr: cachedQr,
      error: setupError,
    };
  }

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: error.message }));
    });
  });
  async function handle(req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy",
      "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self';");
    if (req.headers.host !== new URL(origin).host) {
      res.writeHead(403);
      res.end();
      return;
    }
    const path = new URL(req.url, origin).pathname;
    if (req.method === "GET" && path === `${prefix}/`) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(renderPairingHtml());
      return;
    }
    if (req.method === "GET" && path === `${prefix}/state`) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify(await snapshot()));
      return;
    }
    if (req.method === "POST" && path === `${prefix}/pair`) {
      if (req.headers.origin !== origin || req.headers["content-type"] !== "application/json") {
        res.writeHead(403);
        res.end();
        return;
      }
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024) throw new Error("Pairing request is too large.");
      }
      const input = JSON.parse(body);
      if (!input || typeof input !== "object" || Array.isArray(input) ||
          Object.keys(input).some((key) => !["transport", "confirm"].includes(key))) {
        throw new Error("Pairing request must contain only transport and confirmation.");
      }
      if (input.transport != null && !["supabase", "devtunnel"].includes(input.transport)) {
        throw new Error("Choose Supabase or Dev Tunnel.");
      }
      const current = status();
      if ((current.state === "active" || current.paired === true) && input.confirm !== true) {
        throw new Error("Confirm before replacing the connected phone.");
      }
      if (pairing) throw new Error("A pairing request is already in progress.");
      pairing = true;
      try {
        await preparePairing({ transport: input.transport, refresh: true });
        setupError = null;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.end(JSON.stringify(await snapshot()));
      } finally {
        pairing = false;
      }
      return;
    }
    res.writeHead(404);
    res.end();
  }
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  server.unref();
  return {
    url: `${origin}${prefix}/`,
    setError(message) { setupError = message; },
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      server.closeIdleConnections();
    }),
  };
}

export function renderPairingHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Weft - pair your phone</title>
<style>
body { margin:0; padding:24px; background:var(--background-color-default,#fff); color:var(--text-color-default,#1f2328); font:var(--text-body-medium,14px)/1.5 var(--font-sans,system-ui); }
main { max-width:520px; margin:auto; } h1 { margin:0; font-size:26px; }
p { color:var(--text-color-muted,#59636e); } a { color:var(--true-color-blue,#0969da); }
section { padding:20px; border:1px solid var(--border-color-default,#d1d9e0); border-radius:16px; margin:20px 0; }
#qr { display:block; width:100%; max-width:360px; margin:12px auto; border-radius:8px; }
button,select { font:inherit; padding:10px 14px; border:1px solid var(--border-color-default,#d1d9e0); border-radius:8px; background:var(--background-color-default,#fff); color:inherit; }
button { cursor:pointer; } button:disabled { opacity:.5; cursor:default; }
.controls { display:flex; gap:10px; flex-wrap:wrap; } textarea { box-sizing:border-box; width:100%; height:100px; font:12px var(--font-mono,monospace); }
#error { color:var(--true-color-red,#cf222e); } [hidden] { display:none!important; }
</style></head><body><main>
<h1>Weft</h1><p>Your Copilot session, off the desk.</p>
<section><strong id="status" role="status" aria-live="polite">Preparing pairing...</strong>
<img id="qr" alt="Scan this QR in the Weft phone app" hidden>
<p id="instructions">Open <a href="https://useweft.netlify.app" target="_blank" rel="noreferrer">Weft on your phone</a> and choose Scan QR to pair.</p>
<p id="details"></p><button id="copy" type="button" disabled>Copy pairing code</button>
<textarea id="code" aria-label="Pairing code" readonly hidden></textarea></section>
<div class="controls"><select id="transport" aria-label="Pairing transport"><option value="">Current transport</option><option value="supabase">Supabase</option><option value="devtunnel">Dev Tunnel</option></select>
<button id="refresh" type="button">New pairing code</button></div>
<section id="confirmation" hidden aria-label="Replace connected phone">
<p>Replace the connected phone? It will need to pair again.</p>
<div class="controls"><button id="replace" type="button">Replace phone</button>
<button id="cancel" type="button">Cancel</button></div></section>
<p id="error" role="alert" hidden></p>
<p>Already paired to Device Station? Open Resume on your phone to connect to this running session. CLI users can still use <code>/weft</code>.</p>
<p>End-to-end encrypted. Closing this panel does not disconnect your phone.</p>
</main><script>
const $ = id => document.getElementById(id);
let state = null, busy = false, copying = false;
function showError(message) { $('error').textContent=message; $('error').hidden=!message; }
function render(next) {
  state=next;
  $('status').textContent=next.connected?'Phone connected':next.paired?'Phone reconnecting':next.expired?'Pairing code expired':next.code?'Waiting for your phone':'Choose a transport to pair';
  $('qr').hidden=!next.qr; if(next.qr) $('qr').src=next.qr; else $('qr').removeAttribute('src');
  $('copy').disabled=!next.code; $('code').value=next.code||''; if(!next.code) $('code').hidden=true;
  $('details').textContent=next.transport?('Relay: '+next.transport+(next.expired?' - request a new code':'')):'';
  $('instructions').hidden=next.connected;
}
async function request(path, options) {
  const response=await fetch(new URL(path,location.href),options);
  const data=await response.json();
  if(!response.ok) throw new Error(data.error||'Could not reach Weft.');
  return data;
}
async function poll() {
  if(busy||copying) return;
  try { const next=await request('state'); render(next); showError(next.error||''); }
  catch(error) { showError(error.message); $('qr').hidden=true; $('copy').disabled=true; }
}
$('copy').onclick=async()=>{
  copying=true;
  try { await navigator.clipboard.writeText(state.code); $('copy').textContent='Copied'; }
  catch { $('code').hidden=false; $('code').focus(); $('code').select(); showError('Clipboard is unavailable. Copy the selected code below.'); }
  finally { copying=false; }
};
async function pair(confirm=false) {
  if(busy) return;
  if(state?.paired&&!confirm) { $('confirmation').hidden=false; return; }
  $('confirmation').hidden=true;
  busy=true; $('refresh').disabled=true; $('replace').disabled=true;
  try { render(await request('pair',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({transport:$('transport').value||null,confirm})})); showError(''); $('copy').textContent='Copy pairing code'; }
  catch(error) { showError(error.message); }
  finally { busy=false; $('refresh').disabled=false; $('replace').disabled=false; }
}
$('refresh').onclick=()=>pair();
$('replace').onclick=()=>pair(true);
$('cancel').onclick=()=>{ $('confirmation').hidden=true; };
void poll(); const timer=setInterval(poll,2000); window.addEventListener('pagehide',()=>clearInterval(timer));
</script></body></html>`;
}

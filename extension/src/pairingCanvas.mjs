// SPDX-License-Identifier: Apache-2.0
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { hostname } from "node:os";
import QRCode from "qrcode";
import { readSession } from "./store.mjs";
import { loadDeviceName } from "./transportConfig.mjs";
import { resolveVersion } from "./version.mjs";

export async function readCanvasSessionDetails(session, readSavedSession = readSession) {
  const calls = [
    () => session?.rpc?.metadata?.snapshot?.(),
    () => session?.rpc?.metadata?.activity?.(),
    () => session?.rpc?.model?.getCurrent?.(),
    () => session?.rpc?.name?.get?.(),
    () => session?.sessionId ? readSavedSession(session.sessionId) : null,
  ];
  const results = await Promise.allSettled(calls.map((call) => Promise.resolve().then(call)));
  const [metadata, activity, model, name, saved] = results.map((result) =>
    result.status === "fulfilled" ? result.value : null);
  const text = (value) => typeof value === "string" && value.trim() ? value.trim() : null;
  return {
    sessionId: text(session?.sessionId),
    title: text(name?.name) ?? text(metadata?.initialName) ?? text(metadata?.summary) ?? text(saved?.title),
    cwd: text(metadata?.workingDirectory) ?? text(saved?.cwd),
    branch: text(saved?.branch),
    repository: text(saved?.repository),
    model: text(model?.modelId) ?? text(metadata?.selectedModel),
    reasoning: text(model?.reasoningEffort),
    mode: text(metadata?.currentMode),
    busy: typeof activity?.hasActiveWork === "boolean" ? activity.hasActiveWork : null,
    startedAt: text(metadata?.startTime),
    deviceName: loadDeviceName() ?? hostname(),
    version: resolveVersion(),
    warning: results.some((result) => result.status === "rejected")
      ? "Some live session details are unavailable. Reopen the panel to retry."
      : null,
  };
}

export async function createPairingCanvasServer({ session, preparePairing, status }) {
  const prefix = `/${randomBytes(24).toString("hex")}`;
  let origin;
  let cachedCode = null;
  let cachedQr = null;
  let setupError = null;
  let pairing = false;
  let details = null;
  let detailsAt = 0;

  async function sessionDetails() {
    if (!details || Date.now() - detailsAt >= 10_000) {
      details = await readCanvasSessionDetails(session);
      detailsAt = Date.now();
    }
    return details;
  }

  async function snapshot() {
    const session = await sessionDetails();
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
      session,
      phoneName: current.phoneName ?? null,
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
    getTitle() { return "Weft | Phone companion"; },
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
<title>Weft | Phone companion</title>
<style>
body { margin:0; padding:24px; background:var(--background-color-default,#fff); color:var(--text-color-default,#1f2328); font-family:var(--font-sans,system-ui,-apple-system,"Segoe UI",sans-serif); font-size:var(--text-body-medium,14px); line-height:1.5; }
main { max-width:700px; margin:auto; } h1 { margin:0; font-size:25px; line-height:1.25; overflow-wrap:anywhere; }
p { color:var(--text-color-muted,#59636e); } a { color:var(--true-color-blue,#0969da); }
section { padding:20px; border:1px solid var(--border-color-default,#d1d9e0); border-radius:16px; margin:20px 0; }
.brand { display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:24px; }
.wordmark { display:flex; align-items:center; gap:9px; font-size:19px; font-weight:700; }
.mark { background:#c6f24e; color:#172114; border-radius:10px; padding:3px 9px; font-weight:800; }
.eyebrow { color:var(--text-color-muted,#59636e); font-size:11px; font-weight:600; letter-spacing:.1em; text-transform:uppercase; }
.badge { display:inline-flex; align-items:center; gap:6px; font-size:12px; padding:4px 10px; border-radius:20px; border:1px solid var(--border-color-default,#d1d9e0); }
.badge::before { content:''; width:6px; height:6px; border-radius:50%; background:#86939e; }
.badge.online::before { background:#238636; }
.session-card { margin-bottom:16px; } .session-card p { margin:6px 0 0; }
.session-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:16px; margin:18px 0 0; }
dt { color:var(--text-color-muted,#59636e); font-size:12px; } dd { margin:3px 0 0; overflow-wrap:anywhere; }
.full { grid-column:1/-1; } .mono { font:12px/1.5 var(--font-mono,monospace); }
.pair-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(180px,.85fr); gap:24px; align-items:center; }
#qr { display:block; width:100%; max-width:320px; margin:12px auto; border-radius:8px; }
.step { display:flex; align-items:flex-start; gap:10px; margin:15px 0; }
.step b { background:var(--background-color-default,#fff); border:1px solid var(--border-color-default,#d1d9e0); border-radius:50%; font-size:12px; padding:1px 7px; }
.step p { margin:0; } .step strong { color:var(--text-color-default,#1f2328); }
.connected-note { border-left:3px solid #238636; padding:8px 14px; margin:20px 0; }
button,select { font:inherit; padding:10px 14px; border:1px solid var(--border-color-default,#d1d9e0); border-radius:8px; background:var(--background-color-default,#fff); color:inherit; }
button { cursor:pointer; } button:disabled { opacity:.5; cursor:default; }
.primary { background:#c6f24e; border-color:#a4cd36; color:#172114; font-weight:600; }
.controls { display:flex; gap:10px; flex-wrap:wrap; } textarea { box-sizing:border-box; width:100%; height:100px; font:12px var(--font-mono,monospace); }
#error { color:var(--true-color-red,#cf222e); } .footer { font-size:12px; }
[hidden] { display:none!important; }
@media(max-width:560px) { body { padding:16px; } section { padding:16px; } .pair-grid { grid-template-columns:1fr; gap:8px; } .session-grid { gap:12px; } }
</style></head><body><main>
<header class="brand"><span class="wordmark"><span class="mark" aria-hidden="true">W</span>Weft</span>
<span id="version" class="eyebrow">SESSION COMPANION</span></header>
<div class="eyebrow">YOUR COPILOT SESSION</div>
<h1>Continue on your phone</h1>
<p>Continue this session on your phone. Same conversation, same workspace.</p>
<section class="session-card" aria-label="Session details">
<div class="controls"><span id="activity" class="badge">Activity unavailable</span><span id="mode" class="badge">Mode unavailable</span><span id="device" class="badge">This laptop</span></div>
<dl class="session-grid">
<div class="full"><dt>Session</dt><dd id="session-title">Loading session details...</dd></div>
<div class="full"><dt>Workspace</dt><dd id="workspace" class="mono">Unavailable</dd></div>
<div><dt>Branch</dt><dd id="branch">Unavailable</dd></div>
<div><dt>Model</dt><dd id="model">Unavailable</dd></div>
<div><dt>Relay</dt><dd id="relay">Not configured</dd></div>
<div><dt>Phone</dt><dd id="phone">Not paired</dd></div>
<div class="full"><dt>Session ID</dt><dd id="session-id" class="mono">Unavailable</dd></div>
<div class="full"><dt>Started</dt><dd id="started">Unavailable</dd></div>
</dl>
<p id="metadata-warning" class="footer" hidden></p>
</section>
<section aria-label="Phone pairing"><strong id="status" role="status" aria-live="polite">Preparing pairing...</strong>
<div id="pair-grid" class="pair-grid"><div>
<img id="qr" alt="Scan this QR in the Weft phone app" hidden>
<p id="details" class="footer"></p></div><div id="instructions">
<div class="step"><b aria-hidden="true">1</b><p><strong>Open Weft on your phone</strong><br><a href="https://useweft.netlify.app" target="_blank" rel="noreferrer">useweft.netlify.app</a></p></div>
<div class="step"><b aria-hidden="true">2</b><p><strong>Scan QR to pair</strong><br>Choose Scan QR in the phone app and scan this code.</p></div>
<div class="step"><b aria-hidden="true">3</b><p><strong>Stay with this session</strong><br>Follow the work, send prompts, and answer native approval requests.</p></div>
<button id="copy" class="primary" type="button" disabled>Copy pairing code</button></div></div>
<div id="connected-note" class="connected-note" hidden>Your phone is connected to this session. Closing this panel keeps that connection open.</div>
<textarea id="code" aria-label="Pairing code" readonly hidden></textarea></section>
<div class="controls"><select id="transport" aria-label="Pairing transport"><option value="">Keep current relay</option><option value="supabase">Supabase</option><option value="devtunnel">Dev Tunnel</option></select>
<button id="refresh" type="button">New pairing code</button></div>
<section id="confirmation" hidden aria-label="Replace connected phone">
<p>Replace the connected phone? It will need to pair again.</p>
<div class="controls"><button id="replace" type="button">Replace phone</button>
<button id="cancel" type="button">Cancel</button></div></section>
<p id="error" role="alert" hidden></p>
<p class="footer">Already paired to this laptop? Choose this session in Resume on your phone. No camera needed.</p>
<p class="footer">End-to-end encrypted. Pairing codes are short-lived and single-use. CLI users can still run <code>/weft</code>.</p>
</main><script>
const $ = id => document.getElementById(id);
let state = null, busy = false, copying = false;
function showError(message) { $('error').textContent=message; $('error').hidden=!message; }
function render(next) {
  state=next;
  const session=next.session||{};
  $('session-title').textContent=session.title||'Copilot session';
  $('workspace').textContent=session.cwd||'Unavailable';
  $('branch').textContent=session.branch||'Unavailable';
  $('model').textContent=[session.model,session.reasoning].filter(Boolean).join(' / ')||'Unavailable';
  $('mode').textContent=session.mode?session.mode.charAt(0).toUpperCase()+session.mode.slice(1):'Mode unavailable';
  $('activity').textContent=session.busy===true?'Working':session.busy===false?'Ready':'Activity unavailable';
  $('activity').classList.toggle('online',session.busy===false);
  $('device').textContent=session.deviceName||'This laptop';
  $('version').textContent=session.version?'WEFT '+session.version:'SESSION COMPANION';
  $('session-id').textContent=session.sessionId||'Session ID unavailable';
  $('started').textContent=session.startedAt?new Date(session.startedAt).toLocaleString():'Unavailable';
  $('metadata-warning').textContent=session.warning||''; $('metadata-warning').hidden=!session.warning;
  $('relay').textContent=next.transport==='devtunnel'?'Dev Tunnel':next.transport==='supabase'?'Supabase':next.transport||'Not configured';
  $('phone').textContent=next.connected?(next.phoneName||'Connected phone'):next.paired?'Reconnecting':'Not paired';
  $('status').textContent=next.connected?'Phone connected':next.paired?'Phone reconnecting':next.expired?'Pairing code expired':next.code?'Waiting for your phone':'Choose a transport to pair';
  $('qr').hidden=!next.qr; if(next.qr) $('qr').src=next.qr; else $('qr').removeAttribute('src');
  $('copy').disabled=!next.code; $('code').value=next.code||''; if(!next.code) $('code').hidden=true;
  $('details').textContent=next.transport?('Relay: '+next.transport+(next.expired?' - request a new code':'')):'';
  $('instructions').hidden=next.connected;
  $('pair-grid').hidden=next.connected; $('connected-note').hidden=!next.connected;
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

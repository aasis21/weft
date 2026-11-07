// SPDX-License-Identifier: Apache-2.0

export function renderControlCenterPage() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
<title>Weft | Control Center</title>
<style>${styles}</style>
</head>
<body>
<a class="skip-link" href="#main">Skip to content</a>
<div class="shell">
  <aside class="sidebar" aria-label="Control Center navigation">
    <div class="brand"><span class="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M7 8l8 16M15 8l8 16M8 24L24 8M8 16l8-8M16 24l8-8" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg></span><span>weft<span class="brand-caption">CONTROL CENTER</span></span></div>
    <p class="nav-label">YOUR WORKSPACE</p>
    <nav id="navigation" aria-label="Main"></nav>
    <div class="sidebar-bottom"><span class="local-dot"></span><div>On this computer<small>Private, local control</small></div><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4zM9 12l2 2 4-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg></div>
  </aside>
  <div class="workspace">
    <header class="topbar"><div class="breadcrumb">WEFT <span>/</span> LOCAL WORKSPACE</div><div class="toolbar"><span id="freshness" class="badge">Loading status</span><button id="refresh" class="button compact" type="button">Refresh status</button></div></header>
    <main id="main" tabindex="-1">
      <div class="page-heading"><div><p class="eyebrow">CONTROL CENTER</p><h1 id="page-title" tabindex="-1">Overview</h1><p id="page-description" class="muted">Your computer, phone, and sessions. One clear view.</p></div><span id="device-chip" class="device-chip">This computer</span></div>
      <div id="connection-error" class="notice error" role="alert" hidden><strong>Status unavailable</strong><p id="connection-message"></p><button id="retry" type="button" class="button compact">Try again</button></div>
      <div id="operation" class="operation" role="status" aria-live="polite" hidden><span id="operation-dot" class="activity-dot"></span><div><strong id="operation-title"></strong><p id="operation-detail"></p></div><button id="operation-retry" class="button compact" type="button" hidden>Check operation</button><button id="operation-dismiss" class="button compact" type="button" hidden>Dismiss</button></div>

      <section id="panel-overview" class="panel" aria-labelledby="page-title">
        <div class="hero"><div><p class="eyebrow">CONNECTED, ON YOUR TERMS</p><h2>Your desk.<br>Your pocket. In sync.</h2><p>Keep work on your computer. Choose what connects to your phone, without leaving a session behind.</p><div class="actions"><button class="button primary" type="button" data-go="pairing">Manage phone pairing <span aria-hidden="true">↗</span></button><button class="button" type="button" data-go="sessions">View sessions</button></div></div><div class="hero-art" aria-hidden="true"><div class="orbit orbit-one"></div><div class="orbit orbit-two"></div><svg viewBox="0 0 200 180"><rect x="20" y="35" width="115" height="80" rx="9" fill="none" stroke="currentColor" stroke-width="3"/><path d="M32 100h90M62 116l-5 14h44l-5-14M48 130h60" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/><rect x="130" y="65" width="48" height="82" rx="9" fill="var(--hero-bg)" stroke="currentColor" stroke-width="3"/><path d="M149 73h10M150 137h8M142 97l8 8 16-19" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="96" cy="73" r="5" fill="currentColor"/><path d="M53 73h24" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg><span class="art-note">LOCAL FIRST. ALWAYS.</span></div></div>
        <div class="metric-grid"><div class="metric"><span>Discovered sessions</span><strong id="metric-sessions">—</strong><small>Existing Copilot runtimes</small></div><div class="metric"><span>Connected phones</span><strong id="metric-connected">—</strong><small id="metric-connected-note">Waiting for a fresh status</small></div><div class="metric"><span>Registered projects</span><strong id="metric-projects">—</strong><small>Workspaces you choose</small></div></div>
        <div class="section-heading"><h2>Connection infrastructure</h2><span class="muted small">Nothing starts automatically</span></div>
        <div class="service-grid">
          <article class="card service"><div class="card-heading"><span class="icon-tile" data-icon="station"></span><span id="station-status" class="badge">Unknown</span></div><h3>Device Station</h3><p>Phone access to this computer’s utilities. Independent of your Copilot sessions.</p><div class="service-meta"><span id="station-phone">Phone status unknown</span><span id="station-pid"></span></div><p id="station-error" class="inline-error" hidden></p><p id="station-remedy" class="hint"></p><div class="actions"><button id="station-start" class="button primary" type="button">Start Station</button><button id="station-restart" class="button" type="button">Restart</button><button id="station-stop" class="button danger-quiet" type="button">Stop</button></div></article>
          <article class="card service"><div class="card-heading"><span class="icon-tile" data-icon="relay"></span><span id="relay-status" class="badge">Unknown</span></div><h3>Dev Tunnel relay</h3><p>A transport for encrypted traffic. Start it only when you use Dev Tunnel.</p><div class="service-meta"><span id="relay-address">No relay address available</span><span id="relay-pid"></span></div><p id="relay-error" class="inline-error" hidden></p><p id="relay-remedy" class="hint"></p><div class="actions"><button id="relay-start" class="button primary" type="button">Start relay</button><button id="relay-restart" class="button" type="button">Restart</button><button id="relay-stop" class="button danger-quiet" type="button">Stop</button></div></article>
        </div>
        <div id="warnings-card" class="notice warning" hidden><h3>Worth a look</h3><ul id="warnings"></ul><button class="button compact" type="button" data-go="diagnostics">Open diagnostics</button></div>
      </section>

      <section id="panel-sessions" class="panel" hidden aria-labelledby="page-title">
        <div class="notice subtle"><strong>Your Copilot process stays yours.</strong><p>Activate Weft for an existing runtime, explicitly start a session in a registered project, or disconnect its phone link. No transcripts or terminal emulator are shown here.</p></div>
        <form id="session-start-form" class="card launch-card"><div><h2>Start a Copilot session</h2><p id="session-start-remedy" class="muted small">Start Device Station and configure transport first.</p></div><div class="launch-fields"><div><label for="session-project">Project</label><select id="session-project" required><option value="">Choose a registered project</option></select></div><div><label for="session-name">Session name <span class="muted">(optional)</span></label><input id="session-name" maxlength="200" autocomplete="off" placeholder="What are you working on?"></div><div><label for="session-mode">Approval mode</label><select id="session-mode"><option value="default">Default — native approvals</option><option value="allow-all">Allow all — broader permissions</option></select></div><button id="session-start" type="submit" class="button primary" disabled>Start session</button></div></form>
        <div class="list-toolbar"><label class="search-field"><span data-icon="search"></span><span class="sr-only">Search sessions</span><input id="session-search" type="search" placeholder="Search title, folder, or session ID"></label><label class="filter-field"><span class="sr-only">Filter sessions</span><select id="session-filter"><option value="all">All sessions</option><option value="connected">Connected phones</option><option value="attention">Needs attention</option></select></label></div>
        <div id="sessions-list" class="session-list" aria-live="polite"></div>
      </section>

      <section id="panel-projects" class="panel" hidden aria-labelledby="page-title">
        <div class="two-column"><div><div class="section-heading"><h2>Your projects</h2><span id="project-count" class="badge">—</span></div><div id="projects-list" class="project-list"></div></div>
          <form id="project-form" class="card form-card"><span class="icon-tile" data-icon="folder"></span><h2>Add a workspace</h2><p class="muted">Register a folder on this computer. Adding a project does not start a session.</p><label for="project-name">Project name</label><input id="project-name" name="name" required maxlength="100" autocomplete="off" placeholder="My project"><label for="project-path">Folder path</label><input id="project-path" name="path" required maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Absolute folder path"><p class="field-help">Use the existing local folder’s full path.</p><label class="check"><input id="project-default" type="checkbox">Make this the default project</label><button id="project-add" class="button primary" type="submit">Add project</button></form>
        </div>
      </section>

      <section id="panel-settings" class="panel" hidden aria-labelledby="page-title">
        <form id="settings-form">
          <div class="settings-heading"><p class="muted">Changes are saved only when you choose Save. Polling never replaces unsaved edits.</p><span id="settings-dirty" class="badge" hidden>Unsaved changes</span></div>
          <fieldset id="settings-fields" disabled>
            <div class="card settings-card"><div class="settings-intro"><span class="icon-tile" data-icon="device"></span><h2>Identity &amp; transport</h2><p>How this computer appears, and how its encrypted connection travels.</p></div><div class="settings-inputs"><label for="device-name">Device name</label><input id="device-name" required maxlength="200" autocomplete="off" placeholder="This computer’s name"><p class="field-help">The system name is prefilled when no custom name is configured.</p><label for="transport">Transport</label><select id="transport"><option value="clear">Not configured (clear selection)</option><option value="supabase">Supabase Realtime</option><option value="devtunnel">Microsoft Dev Tunnel</option></select><p class="field-help">Changing transport can interrupt phone connections. Clearing it does not start or stop a worker.</p></div></div>
            <div class="card settings-card"><div class="settings-intro"><span class="icon-tile" data-icon="shield"></span><h2>Trust &amp; permissions</h2><p>Keep approval boundaries intentional. Broader access requires your confirmation.</p></div><div class="settings-inputs"><label for="permission-mode">Approval mode</label><select id="permission-mode"><option value="default">Default — native approvals</option><option value="allow-all">Allow all — broader permissions</option></select><label for="pairing-mode">Pairing trust</label><select id="pairing-mode"><option value="persistent">Persistent — remember the phone</option><option value="ephemeral">Ephemeral — temporary pairing</option></select><label class="check"><input id="terminal-enabled" type="checkbox">Enable phone terminal access</label><p class="field-help">Terminal access is separate from session chat and workspace previews.</p></div></div>
            <div class="card settings-card"><div class="settings-intro"><span class="icon-tile" data-icon="folder"></span><h2>Read-only file sharing</h2><p>Only explicitly requested files within your allowed roots. Host permissions and native approvals still apply.</p></div><div class="settings-inputs"><label class="check"><input id="files-enabled" type="checkbox">Enable file sharing with the phone</label><div class="section-heading"><h3>Allowed roots</h3><button id="root-add" class="button compact" type="button">Add root</button></div><p class="field-help">Each root needs a unique name and an absolute local folder path.</p><div id="roots"></div><p id="roots-empty" class="hint">No roots configured. File access needs an explicitly allowed root.</p><label for="file-excludes">Excluded paths / patterns</label><textarea id="file-excludes" rows="4" spellcheck="false" placeholder="One exclusion per line"></textarea><p class="field-help">Preserves your explicit exclusions; do not enter credentials here.</p></div></div>
          </fieldset>
          <div class="save-bar"><span id="settings-note" class="muted small">Loading saved settings…</span><div class="actions"><button id="settings-reset" class="button" type="button" disabled>Discard edits</button><button id="settings-save" class="button primary" type="submit" disabled>Save settings</button></div></div>
        </form>
      </section>

      <section id="panel-pairing" class="panel" hidden aria-labelledby="page-title">
        <div class="pairing-toolbar"><div><label for="pairing-target">Pairing destination</label><select id="pairing-target"><option value="">Device Station</option></select></div><button id="pairing-refresh" class="button" type="button">Refresh pairing</button></div>
        <div class="card pairing-card"><div class="pairing-visual"><span id="pairing-badge" class="badge">Not loaded</span><div id="qr-placeholder" class="qr-placeholder"><span data-icon="phone"></span><strong id="pairing-visual-title">Your phone, connected securely</strong><p id="pairing-visual-detail">Pairing details load only in this view.</p></div><img id="pairing-qr" alt="Scan this QR code in the Weft phone app to pair" hidden><p class="small muted">Pairing codes are private. Never share them in chat or logs.</p></div><div class="pairing-instructions"><p class="eyebrow">A PRIVATE HANDSHAKE</p><h2>Bring your phone<br>into the loop.</h2><ol class="steps"><li><strong>Open Weft on your phone</strong><p>Use your installed phone app or PWA.</p></li><li><strong>Choose Scan QR</strong><p>Scan the code on this computer. Keep this page private.</p></li><li><strong>Stay connected</strong><p>Pairing establishes trust; a live connection also needs an available transport.</p></li></ol><p id="pairing-message" class="hint" role="status" aria-live="polite"></p><details id="pairing-code-details" hidden><summary>Use a pairing code instead</summary><label class="sr-only" for="pairing-code">Private pairing code</label><textarea id="pairing-code" readonly rows="4" spellcheck="false"></textarea><button id="pairing-copy" class="button compact" type="button">Copy pairing code</button></details></div></div>
        <div class="notice warning pairing-trust"><div><strong>Replacing a phone changes trust.</strong><p>The previous phone loses its pairing. This is an explicit trust rotation, not a reconnect button.</p></div><button id="pairing-replace" class="button danger-quiet" type="button" disabled>Replace paired phone</button></div>
      </section>

      <section id="panel-diagnostics" class="panel" hidden aria-labelledby="page-title">
        <div class="service-grid"><article class="card"><span class="icon-tile" data-icon="pulse"></span><h2>Local installation</h2><dl class="diagnostic-list"><div><dt>Running version</dt><dd id="diagnostic-version">Unknown</dd></div><div><dt>Computer</dt><dd id="diagnostic-device">Unknown</dd></div><div><dt>Platform</dt><dd id="diagnostic-platform">Unknown</dd></div><div><dt>Last checked</dt><dd id="diagnostic-checked">Not yet checked</dd></div><div><dt>Transport</dt><dd id="diagnostic-transport">Unknown</dd></div></dl><p class="hint">This is the version served by the local Control Center. Repository source changes are not installed updates; running workers may need a restart after an installed update.</p></article><article class="card"><span class="icon-tile" data-icon="update"></span><h2>Release check</h2><p class="muted">Check availability without installing, deploying, or restarting anything.</p><p id="update-result" class="hint" role="status" aria-live="polite">No release check requested.</p><button id="update-check" type="button" class="button">Check for updates</button><p class="small muted">Installed clients change only after a published release is explicitly installed.</p></article></div>
        <article class="card remediation"><h2>When something isn’t connected</h2><div class="remedy-grid"><div><h3>Unknown or stale status</h3><p>Refresh status. If the local service is unavailable, reopen Control Center from Weft. Unknown does not mean disconnected.</p></div><div><h3>Phone trusted, not connected</h3><p>Keep your existing trust. Check the selected transport and open the phone app before replacing a pairing.</p></div><div><h3>Worker unsupported</h3><p>Background workload controls require Windows. Copilot session discovery and supported session actions remain separate.</p></div></div><div id="diagnostic-warnings" class="notice warning" hidden><strong>Reported warnings</strong><ul id="diagnostic-warning-list"></ul></div><p class="small muted">Only status and sanitized remediation are shown here. No transcripts, logs, or pairing secrets.</p></article>
      </section>
    </main>
    <footer><span>Weft Control Center <span aria-hidden="true">·</span> Loopback only</span><span>Work stays on your computer.</span></footer>
  </div>
</div>
<dialog id="confirmation" aria-labelledby="confirmation-title" aria-describedby="confirmation-description"><form method="dialog"><span class="dialog-icon" data-icon="shield"></span><h2 id="confirmation-title">Confirm change</h2><p id="confirmation-description"></p><ul id="confirmation-effects"></ul><div class="actions"><button id="confirmation-cancel" class="button" value="cancel" autofocus>Cancel</button><button id="confirmation-accept" class="button danger" value="confirm">Confirm</button></div></form></dialog>
<noscript><p class="notice error">JavaScript is required to load local status and explicitly requested operations.</p></noscript>
<script>(${controlCenterClient.toString()})();</script>
</body></html>`;
}

const styles = `
:root{color-scheme:light dark;--bg:#f7f6f3;--surface:#fff;--text:#252533;--muted:#696978;--border:#e4e2e9;--accent:#6950cf;--accent-hover:#5740b8;--accent-soft:#f0ecfc;--hero-bg:#eeebf8;--hero-text:#463b73;--good:#247259;--good-bg:#e9f5ee;--warn:#846022;--warn-bg:#fff5df;--bad:#a43b4e;--bad-bg:#fceef1;--shadow:0 5px 24px #20203205;--radius:18px}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}button,input,select,textarea{font:inherit}button,select,summary{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.52}button{touch-action:manipulation}input,select,textarea{min-width:0;max-width:100%;color:var(--text);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:10px 12px}input:not([type=checkbox]),textarea{width:100%}textarea{resize:vertical}input[type=checkbox]{width:17px;height:17px;accent-color:var(--accent);flex-shrink:0}label{display:block;font-weight:600;font-size:13px;margin:14px 0 6px}fieldset{padding:0;margin:0;border:0;min-width:0}h1,h2,h3,p{margin-top:0}h1{font-size:32px;line-height:1.2;letter-spacing:-1.2px;margin-bottom:8px}h2{font-size:20px;line-height:1.35;letter-spacing:-.45px;margin-bottom:12px}h3{font-size:16px;line-height:1.4;margin-bottom:8px}p{margin-bottom:14px}svg{display:block;width:20px;height:20px;flex-shrink:0}[hidden]{display:none!important}:focus-visible{outline:3px solid var(--accent);outline-offset:4px}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}.skip-link{position:fixed;top:8px;left:8px;z-index:20;transform:translateY(-150%);background:var(--surface);color:var(--accent);padding:12px;border-radius:8px}.skip-link:focus{transform:none}.shell{display:grid;grid-template-columns:236px minmax(0,1fr);min-height:100vh}.sidebar{height:100vh;position:sticky;top:0;background:#191a28;color:#b3b3c3;padding:32px 18px 20px;display:flex;flex-direction:column}.brand{display:flex;align-items:center;gap:12px;color:#f4f2ff;font-size:29px;letter-spacing:-1px;font-weight:700;padding:0 14px 35px}.brand-mark{display:grid;place-items:center;width:42px;height:42px;background:#bfaef7;color:#29213f;border-radius:13px}.brand-mark svg{width:30px;height:30px}.brand-caption{display:block;font-size:9px;font-weight:600;letter-spacing:2px;color:#aaa5c0;margin-top:-4px}.nav-label{font-size:10px;letter-spacing:1.6px;color:#858399;margin:0 14px 14px}nav{display:flex;flex-direction:column;gap:6px}.nav-button{display:flex;align-items:center;gap:12px;width:100%;border:0;border-radius:10px;background:transparent;color:#b6b4c8;padding:12px 14px;text-align:left;font-weight:500}.nav-button:hover{background:#ffffff08;color:#fff}.nav-button[aria-current=page]{color:#eee7ff;background:#bda0ff20;box-shadow:inset 3px 0 #bba4fa}.nav-button svg{width:19px;height:19px}.sidebar-bottom{margin-top:auto;display:flex;align-items:center;gap:9px;padding:18px 9px 0;border-top:1px solid #ffffff12;font-size:12px;color:#d2cfdf}.sidebar-bottom small{display:block;color:#89869b;font-size:10px}.sidebar-bottom svg{margin-left:auto;color:#9a90b7}.local-dot{width:7px;height:7px;border-radius:50%;background:#ac98e2}.workspace{min-width:0}.topbar{height:77px;display:flex;justify-content:space-between;align-items:center;gap:16px;padding:0 38px;border-bottom:1px solid var(--border);background:var(--bg)}.breadcrumb{font-size:10px;font-weight:600;letter-spacing:1.6px;color:var(--muted)}.breadcrumb span{padding:0 10px;color:#a4a0b4}.toolbar,.actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.button{display:inline-flex;align-items:center;justify-content:center;gap:10px;min-height:40px;padding:9px 15px;border:1px solid var(--border);border-radius:9px;background:var(--surface);color:var(--text);font-weight:600;font-size:12px;white-space:normal;line-height:1.4;text-align:center;transition:background .15s,transform .15s}.button:hover:not(:disabled){background:var(--accent-soft);border-color:#b5a6e5}.button:active:not(:disabled){transform:translateY(1px)}.button.primary{background:var(--accent);color:#fff;border-color:var(--accent);box-shadow:0 3px 8px #6950cf1b}.button.primary:hover:not(:disabled){background:var(--accent-hover)}.button.compact{padding:7px 11px;min-height:34px;font-size:11px}.danger-quiet{color:var(--bad)}.button.danger{background:var(--bad);color:#fff;border-color:var(--bad)}.button.danger:hover:not(:disabled){background:#882b3c}.badge{display:inline-flex;align-items:center;gap:6px;width:fit-content;border:1px solid var(--border);background:var(--surface);border-radius:100px;font-size:11px;font-weight:600;padding:4px 9px;color:var(--muted);overflow-wrap:anywhere}.badge.good{color:var(--good);background:var(--good-bg);border-color:transparent}.badge.warning{color:var(--warn);background:var(--warn-bg);border-color:transparent}.badge.bad{color:var(--bad);background:var(--bad-bg);border-color:transparent}.badge.live::before{content:"";width:5px;height:5px;border-radius:50%;background:currentColor}.device-chip{padding:9px 13px;border:1px solid var(--border);background:var(--surface);border-radius:9px;font-size:12px;color:var(--muted);max-width:240px;overflow-wrap:anywhere}main{max-width:1370px;margin:0 auto;padding:34px 38px 38px}.page-heading{display:flex;justify-content:space-between;gap:20px;align-items:center;margin-bottom:28px}.page-heading p:last-child{margin-bottom:0}.eyebrow{font-size:10px;font-weight:700;letter-spacing:1.8px;color:var(--accent);margin-bottom:9px}.muted{color:var(--muted)}.small{font-size:12px}.hero{background:var(--hero-bg);border:1px solid #bca8eb30;border-radius:var(--radius);padding:31px 34px;display:grid;grid-template-columns:minmax(0,1.6fr) minmax(180px,1fr);gap:20px;overflow:hidden;margin-bottom:20px}.hero h2{font-size:36px;letter-spacing:-1.4px;line-height:1.12;color:var(--hero-text);margin-bottom:15px}.hero p:not(.eyebrow){color:var(--hero-text);opacity:.8;max-width:435px;font-size:13px;margin-bottom:22px}.hero-art{position:relative;display:flex;align-items:center;justify-content:center;flex-direction:column;color:#8070af;min-height:190px}.hero-art svg{width:min(100%,230px);height:190px;z-index:1}.art-note{font-size:8px;letter-spacing:2px;color:#8a7bad;z-index:1}.orbit{position:absolute;width:230px;height:230px;border:1px solid #9e8dbb28;border-radius:50%}.orbit-two{width:310px;height:310px}.metric-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:16px;margin-bottom:30px}.metric{background:var(--surface);border:1px solid var(--border);border-radius:13px;padding:18px 22px;box-shadow:var(--shadow)}.metric span,.metric small{display:block;color:var(--muted);font-size:12px}.metric strong{display:block;font-size:31px;font-weight:600;letter-spacing:-1px;margin:4px 0}.metric small{font-size:10px}.section-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px}.section-heading h2,.section-heading h3{margin:0}.service-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:24px;box-shadow:var(--shadow);min-width:0}.card-heading{display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:15px}.icon-tile{display:grid;place-items:center;width:38px;height:38px;border-radius:11px;background:var(--accent-soft);color:var(--accent);margin-bottom:14px}.card-heading .icon-tile{margin:0}.service h3{font-size:18px}.service p{color:var(--muted);font-size:12px;max-width:420px}.service-meta{display:flex;justify-content:space-between;gap:10px;font-size:11px;color:var(--muted);padding:12px 0;border-top:1px solid var(--border);overflow-wrap:anywhere}.service-meta span:first-child{min-width:0}.hint{color:var(--muted);font-size:12px;background:var(--bg);border-radius:8px;padding:11px 13px;overflow-wrap:anywhere}.service .hint{min-height:55px}.notice{padding:18px 21px;border:1px solid var(--border);border-radius:12px;margin-bottom:20px;overflow-wrap:anywhere}.notice p{font-size:12px;margin:6px 0 12px}.notice p:last-child{margin-bottom:0}.notice.error{background:var(--bad-bg);border-color:#b74c6429;color:var(--bad)}.notice.warning{background:var(--warn-bg);border-color:#a97b3224;color:var(--warn)}.notice.subtle{background:var(--accent-soft);border-color:transparent}.notice ul{padding-left:20px;font-size:12px}.notice h3{margin:0}.inline-error{color:var(--bad)!important;overflow-wrap:anywhere}#warnings-card{margin-top:20px}.operation{display:flex;align-items:center;gap:13px;background:var(--surface);border:1px solid var(--border);border-left:3px solid var(--accent);border-radius:10px;padding:15px 18px;margin-bottom:20px}.operation>div{flex:1;min-width:0}.operation strong{font-size:13px}.operation p{font-size:12px;color:var(--muted);margin:3px 0 0;overflow-wrap:anywhere}.activity-dot{width:8px;height:8px;border-radius:50%;background:var(--accent);flex-shrink:0}.activity-dot.running{animation:breathe 1.6s ease-in-out infinite}.activity-dot.failed{background:var(--bad)}.activity-dot.succeeded{background:var(--good)}@keyframes breathe{50%{opacity:.3}}.list-toolbar{display:flex;gap:14px;margin:23px 0}.search-field{margin:0;position:relative;flex:1;max-width:500px}.search-field>span:not(.sr-only){position:absolute;left:13px;top:13px;color:var(--muted)}.search-field input{padding-left:41px;font-weight:400}.filter-field{margin:0}.filter-field select{height:44px;font-weight:400}.session-list,.project-list{display:grid;gap:12px}.session-card{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:start;gap:17px;padding:21px}.session-card .icon-tile{margin:0}.session-card h3{margin:0 0 5px;overflow-wrap:anywhere}.session-meta{display:flex;flex-wrap:wrap;gap:7px 16px;font-size:11px;color:var(--muted);margin:8px 0;overflow-wrap:anywhere}.session-card .actions{justify-content:flex-end;max-width:240px}.path{font:11px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--muted);overflow-wrap:anywhere}.session-card .path{margin:0}.session-id{font-size:10px;margin-top:8px;color:var(--muted);overflow-wrap:anywhere}.empty-state{display:flex;flex-direction:column;align-items:center;text-align:center;background:var(--surface);border:1px dashed var(--border);border-radius:var(--radius);padding:48px 22px}.empty-state h3{margin:5px 0 8px}.empty-state p{max-width:450px;color:var(--muted);font-size:12px;margin:0}.empty-state .icon-tile{width:48px;height:48px}.two-column{display:grid;grid-template-columns:minmax(0,1.3fr) minmax(280px,1fr);gap:26px;align-items:start}.form-card h2{margin:0 0 8px}.form-card p{font-size:12px}.form-card .button[type=submit]{width:100%;margin-top:17px}.field-help{color:var(--muted);font-size:11px;margin:7px 0 17px}.check{display:flex;align-items:center;gap:10px;font-weight:500;font-size:12px}.project-card .card-heading{align-items:start}.project-card h3{margin:0;overflow-wrap:anywhere}.project-card .path{margin:8px 0 18px}.settings-heading{display:flex;align-items:start;justify-content:space-between;gap:14px}.settings-heading>p{max-width:560px;font-size:12px}.settings-card{display:grid;grid-template-columns:minmax(0,.85fr) minmax(0,1.3fr);gap:32px;margin:20px 0}.settings-intro p{font-size:12px;color:var(--muted)}.settings-inputs>label:first-child{margin-top:0}.settings-inputs select{width:100%}.settings-inputs .section-heading{margin-top:24px}.settings-inputs .section-heading h3{font-size:13px}.root-row{padding:11px;background:var(--bg);border:1px solid var(--border);border-radius:9px;margin:10px 0}.root-fields{display:grid;grid-template-columns:minmax(90px,.6fr) minmax(0,1fr);gap:10px}.root-fields label{font-size:11px;margin:0 0 5px}.root-fields input{font-size:12px}.root-row>.button{margin-top:9px}.save-bar{display:flex;align-items:center;justify-content:space-between;gap:15px;padding:17px 0;border-top:1px solid var(--border)}.pairing-toolbar{display:flex;align-items:end;justify-content:space-between;gap:15px;margin-bottom:20px}.pairing-toolbar label{margin-top:0}.pairing-toolbar select{max-width:100%;width:300px}.pairing-card{display:grid;grid-template-columns:minmax(0,.9fr) minmax(0,1fr);gap:35px;padding:32px}.pairing-visual{display:flex;align-items:center;flex-direction:column;border-radius:12px;background:var(--bg);padding:25px;text-align:center}.pairing-visual>.small{font-size:10px;max-width:250px;margin-bottom:0}.qr-placeholder{min-height:280px;display:flex;align-items:center;justify-content:center;flex-direction:column;padding:15px}.qr-placeholder svg{width:58px;height:58px;color:var(--accent);margin-bottom:22px}.qr-placeholder strong{font-size:14px}.qr-placeholder p{font-size:12px;color:var(--muted);margin:9px 0 0;max-width:230px}#pairing-qr{width:100%;max-width:300px;aspect-ratio:1;object-fit:contain;border-radius:9px;background:#fff;margin:22px 0}.pairing-instructions{padding:15px 0}.pairing-instructions h2{font-size:30px;letter-spacing:-1px}.steps{list-style:none;padding:0;counter-reset:step}.steps li{counter-increment:step;position:relative;padding-left:38px;margin:23px 0}.steps li::before{content:counter(step);display:grid;place-items:center;position:absolute;left:0;top:0;width:25px;height:25px;background:var(--accent-soft);border:1px solid var(--border);border-radius:50%;font-size:11px;color:var(--accent);font-weight:700}.steps strong{font-size:12px}.steps p{font-size:11px;color:var(--muted);margin:4px 0 0}.pairing-trust{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-top:22px}.pairing-trust p{margin-bottom:0}.pairing-trust .button{flex-shrink:0}details summary{font-size:12px;font-weight:600;color:var(--accent);padding:10px 0}details textarea{font:11px/1.5 ui-monospace,Consolas,monospace;margin:5px 0 10px}.diagnostic-list{margin:20px 0}.diagnostic-list>div{display:grid;grid-template-columns:110px minmax(0,1fr);gap:12px;padding:10px 0;border-bottom:1px solid var(--border)}dt{color:var(--muted);font-size:12px}dd{margin:0;font-size:12px;overflow-wrap:anywhere}.remediation{margin-top:22px}.remedy-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:24px;margin:20px 0}.remedy-grid h3{font-size:13px}.remedy-grid p{font-size:12px;color:var(--muted)}footer{max-width:1370px;margin:0 auto;padding:0 38px 24px;display:flex;justify-content:space-between;gap:15px;font-size:10px;color:var(--muted)}dialog{border:1px solid var(--border);border-radius:20px;padding:28px;max-width:480px;width:calc(100% - 32px);background:var(--surface);color:var(--text);box-shadow:0 25px 100px #0004}dialog::backdrop{background:#17182685;backdrop-filter:blur(3px)}dialog h2{font-size:23px}dialog p,dialog ul{font-size:13px;color:var(--muted);overflow-wrap:anywhere}dialog ul{padding-left:20px}dialog .actions{justify-content:flex-end;margin-top:25px}.dialog-icon{display:grid;place-items:center;color:var(--bad);background:var(--bad-bg);width:42px;height:42px;border-radius:12px;margin-bottom:16px}
@media(prefers-color-scheme:dark){:root{--bg:#20212b;--surface:#292a36;--text:#e9e6f2;--muted:#b2afc1;--border:#3a3949;--accent:#b39af6;--accent-hover:#9c82e5;--accent-soft:#393046;--hero-bg:#302c42;--hero-text:#d0bffa;--good:#9ad5bc;--good-bg:#294037;--warn:#e8c385;--warn-bg:#40382b;--bad:#f1a3b6;--bad-bg:#422d38;--shadow:none}.button.primary{color:#241d37}.button.danger{color:#2a1821}.hero-art{color:#a597c7}.button.danger:hover:not(:disabled){background:#e18da5}}
@media(min-width:1550px){.shell{grid-template-columns:256px minmax(0,1fr)}.sidebar{padding-left:23px;padding-right:23px}}
@media(max-width:1100px){.shell{grid-template-columns:205px minmax(0,1fr)}.topbar{padding:0 26px}main{padding:28px 26px}footer{padding-left:26px;padding-right:26px}.hero{padding:28px}.hero h2{font-size:32px}.session-card{grid-template-columns:auto minmax(0,1fr)}.session-card .actions{grid-column:2;max-width:none;justify-content:flex-start}.two-column{grid-template-columns:1fr}.form-card{max-width:none}.settings-card{gap:24px;grid-template-columns:minmax(0,.7fr) minmax(0,1fr)}.pairing-card{gap:23px;padding:24px}.pairing-visual{padding:15px}.remedy-grid{grid-template-columns:1fr;gap:8px}}
@media(max-width:760px){.shell{display:block}.sidebar{position:sticky;z-index:5;height:auto;padding:13px 15px 10px;box-shadow:0 5px 20px #0001}.brand{padding:0 7px 12px;font-size:23px;gap:9px}.brand-mark{width:32px;height:32px;border-radius:9px}.brand-mark svg{width:25px;height:25px}.brand-caption{font-size:8px;display:inline-block;margin-left:13px;letter-spacing:1.3px}.nav-label,.sidebar-bottom{display:none}nav{flex-direction:row;overflow-x:auto;gap:3px;padding:2px 1px 6px}.nav-button{width:auto;flex-shrink:0;padding:9px 11px;gap:7px;font-size:12px}.nav-button svg{width:16px;height:16px}.nav-button[aria-current=page]{box-shadow:inset 0 -2px #bba4fa}.topbar{height:auto;min-height:60px;padding:12px 20px}.breadcrumb{font-size:8px;letter-spacing:1px}.breadcrumb span{padding:0 4px}.toolbar{gap:7px}.toolbar .badge{font-size:9px}.toolbar .button{font-size:10px;padding:7px 9px}main{padding:24px 20px}.page-heading{align-items:start;gap:10px;margin-bottom:23px}h1{font-size:29px}.page-heading .muted{font-size:12px}.device-chip{font-size:10px;max-width:130px;padding:7px 9px}.hero{grid-template-columns:minmax(0,1fr) minmax(100px,.5fr);padding:24px;gap:10px}.hero h2{font-size:29px}.hero p:not(.eyebrow){font-size:12px}.hero-art svg{height:150px}.orbit{width:160px;height:160px}.orbit-two{width:210px;height:210px}.metric-grid{gap:10px}.metric{padding:15px 13px}.metric span{font-size:10px}.metric strong{font-size:27px}.metric small{font-size:9px}.section-heading .small{font-size:10px}.service-grid{gap:14px}.card{padding:20px}.service .actions{gap:7px}.service .actions .button{padding:8px 10px;font-size:11px}.settings-card{grid-template-columns:1fr;gap:14px}.settings-intro .icon-tile{float:left;margin-right:12px}.settings-intro h2{padding-top:7px}.settings-intro p{clear:both}.pairing-card{grid-template-columns:1fr;gap:20px}.pairing-visual{padding:22px}.pairing-instructions{padding:0}.pairing-instructions h2 br{display:none}.pairing-trust{align-items:start;flex-direction:column;gap:15px}.save-bar{align-items:start}.save-bar>.small{max-width:160px}.operation{flex-wrap:wrap}.operation>div{flex-basis:70%}footer{padding:0 20px 22px;font-size:9px}.list-toolbar{flex-wrap:wrap}.search-field{flex-basis:100%;max-width:none}.filter-field select{height:40px}}
@media(max-width:520px){.breadcrumb{display:none}.topbar{justify-content:flex-end;padding:10px 16px;min-height:52px}main{padding:21px 16px}.device-chip{max-width:100px}.hero{grid-template-columns:1fr;padding:23px}.hero-art{display:none}.hero h2{font-size:31px}.hero .actions{gap:8px}.metric-grid{gap:7px}.metric{padding:13px 10px}.metric span{font-size:9px}.metric small{line-height:1.5}.service-grid{grid-template-columns:1fr}.session-card{gap:11px;padding:18px}.session-card .icon-tile{width:30px;height:30px}.session-card .actions{grid-column:1/-1}.session-card h3{font-size:14px}.root-fields{grid-template-columns:1fr}.save-bar{flex-direction:column}.save-bar>.small{max-width:none}.save-bar .actions{width:100%;justify-content:flex-end}.pairing-toolbar{align-items:start;flex-direction:column}.pairing-toolbar>div{width:100%}.pairing-toolbar select{width:100%}.pairing-card{padding:18px}.section-heading{flex-wrap:wrap}footer{padding:0 16px 21px;flex-wrap:wrap}.diagnostic-list>div{grid-template-columns:95px minmax(0,1fr)}}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}
.art-note{color:var(--hero-text)}.launch-card{margin-bottom:22px}.launch-card h2{font-size:17px;margin-bottom:6px}.launch-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1.3fr) minmax(0,1fr) auto;gap:13px;align-items:end}.launch-fields label{font-size:11px}.launch-fields select{width:100%}.launch-fields .button{min-height:43px}@media(max-width:1100px){.launch-fields{grid-template-columns:repeat(2,minmax(0,1fr))}}@media(max-width:520px){.launch-fields{grid-template-columns:1fr}}
`;

function controlCenterClient() {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const icons = {
    overview: "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
    sessions: "M4 4h16v12H4zM8 20h8M12 16v4M8 8h8M8 12h5",
    folder: "M3 7V5h6l2 2h10v13H3V7z",
    settings: "M4 7h16M4 17h16M8 4v6M16 14v6",
    phone: "M7 2h10a2 2 0 012 2v16a2 2 0 01-2 2H7a2 2 0 01-2-2V4a2 2 0 012-2zM10 5h4M11 19h2",
    pairing: "M3 3h6v6H3zM15 3h6v6h-6zM3 15h6v6H3zM15 15h2v2h-2zM21 15v6h-6M12 3v3M3 12h3M12 12h5M12 18v3",
    pulse: "M2 12h5l3-8 4 16 3-8h5",
    station: "M3 4h18v12H3zM8 21h8M12 16v5M7 8h4M7 12h8",
    relay: "M8 8l-4 4 4 4M16 8l4 4-4 4M14 5l-4 14",
    search: "M10 3a7 7 0 100 14 7 7 0 000-14M15 15l6 6",
    device: "M3 4h18v13H3zM7 21h10M12 17v4",
    shield: "M12 3l8 4v5c0 5-8 9-8 9s-8-4-8-9V7l8-4zM9 12l2 2 4-4",
    update: "M20 7V3l-3 3a8 8 0 10 3 9M20 7h-5",
  };
  function element(tag, text, className) {
    const node = document.createElement(tag);
    if (text != null) node.textContent = String(text);
    if (className) node.className = className;
    return node;
  }
  function icon(name) {
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", icons[name] || icons.device);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.6");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
    return svg;
  }
  function text(id, value) { $(id).textContent = value == null || value === "" ? "Unknown" : String(value); }
  function message(value, fallback = "The local operation could not be completed. Refresh status and try again.") {
    const raw = typeof value === "string" ? value : value?.message;
    if (!raw) return fallback;
    return raw.replace(/[\u0000-\u001f\u007f]/g, " ")
      .replace(/\b(Bearer)\s+\S+/gi, "$1 [redacted]")
      .replace(/((?:token|secret|password|api[-_]?key|authorization)\s*[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
      .replace(/https?:\/\/[^\s]+/gi, "[address redacted]")
      .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted]")
      .slice(0, 600);
  }
  const pages = {
    overview: ["Overview", "Your computer, phone, and sessions. One clear view.", "overview"],
    sessions: ["Sessions", "Existing Copilot runtimes. Connect only when you choose.", "sessions"],
    projects: ["Projects", "The local workspaces you want within reach.", "folder"],
    settings: ["Settings", "Intentional defaults. Explicit permissions. Your boundaries.", "settings"],
    pairing: ["Pairing", "A private connection between this computer and your phone.", "pairing"],
    diagnostics: ["Diagnostics", "Clear status and practical next steps. No private logs.", "pulse"],
  };
  const nav = new Map();
  let page = "overview";
  let state = null;
  let stale = true;
  let stateRequest = null;
  let settingsInitialized = false;
  let settingsDirty = false;
  let settingsFingerprint = "";
  let settingsRevision;
  let sessionsFingerprint = "";
  let projectsFingerprint = "";
  let pairingTarget = "";
  let pairingRequest = 0;
  let operation = null;
  let operationTimer = null;
  let confirmationOpen = false;
  let rootSequence = 0;

  for (const [key, [label, , symbol]] of Object.entries(pages)) {
    const button = element("button", null, "nav-button");
    button.type = "button";
    button.append(icon(symbol), element("span", label));
    button.addEventListener("click", () => navigate(key));
    nav.set(key, button);
    $("navigation").append(button);
  }
  for (const node of document.querySelectorAll("[data-icon]")) node.append(icon(node.dataset.icon));
  for (const button of document.querySelectorAll("[data-go]")) {
    button.addEventListener("click", () => navigate(button.dataset.go));
  }
  function navigate(next, runtimeId, pairingDetails) {
    const leavingPairing = page === "pairing";
    page = next;
    for (const [key, button] of nav) {
      if (key === page) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
      $("panel-" + key).hidden = key !== page;
    }
    text("page-title", pages[page][0]);
    text("page-description", pages[page][1]);
    if (leavingPairing && page !== "pairing") clearPairing();
    if (page === "pairing") {
      pairingTarget = runtimeId == null ? "" : String(runtimeId);
      renderPairingTargets();
      void loadPairing(pairingDetails);
    }
    $("page-title").focus({ preventScroll: true });
  }
  nav.get(page).setAttribute("aria-current", "page");

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }
  async function api(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
      let result;
      try { result = await response.json(); } catch { throw new ApiError("The local service returned an unreadable response. Reopen Control Center if refreshing does not help.", response.status); }
      if (!response.ok) {
        const fallback = response.status === 401 || response.status === 403
          ? "Local authorization expired. Reopen Control Center from Weft."
          : "The local service rejected this request. Refresh status and review your settings.";
        throw new ApiError(message(result?.error, fallback), response.status);
      }
      return result;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error.name === "AbortError"
        ? "The local service did not respond within 10 seconds. Check status before repeating an action."
        : "Cannot reach the local service. Reopen Control Center from Weft, then retry.", 0);
    } finally { clearTimeout(timer); }
  }
  async function refreshState() {
    if (stateRequest) return stateRequest;
    $("refresh").disabled = true;
    stateRequest = (async () => {
      try {
        const next = await api("/api/state");
        if (!next || typeof next !== "object" || !Array.isArray(next.sessions) || !Array.isArray(next.projects) || !next.settings) {
          throw new ApiError("Status is incomplete. Reopen Control Center or check the installed version.", 200);
        }
        state = next;
        stale = false;
        $("connection-error").hidden = true;
        renderState();
      } catch (error) {
        stale = true;
        $("connection-error").hidden = false;
        text("connection-message", error.message + " Previous values, if present, are not live.");
        renderState();
      } finally {
        stateRequest = null;
        $("refresh").disabled = false;
      }
    })();
    return stateRequest;
  }
  function statusBadge(node, label, tone = "") {
    node.textContent = label;
    node.className = "badge" + (tone ? " " + tone : "");
  }
  function status(value) {
    if (stale) return ["Unknown · status stale", "warning"];
    const raw = typeof value === "string" ? value.toLowerCase() : "unknown";
    if (["active", "running", "connected", "ready", "listening"].includes(raw)) return [raw[0].toUpperCase() + raw.slice(1), "good"];
    if (["failed", "error"].includes(raw)) return ["Needs attention", "bad"];
    if (["unknown", "stale", "unavailable"].includes(raw)) return ["Unknown · check status", "warning"];
    if (["stopped", "inactive", "dormant", "idle", "disconnected"].includes(raw)) return [raw[0].toUpperCase() + raw.slice(1), ""];
    return [raw.replace(/[-_]/g, " ").slice(0, 80), "warning"];
  }
  function isUnknown(value) { return !value || /unknown|stale|unavailable/i.test(value); }
  function isRunning(value) { return /^(active|running|connected|ready|listening|starting|stopping|restarting|pairing-ready)$/i.test(value || ""); }
  function workloadSupported() {
    return state && /^(win32|windows)$/i.test(state.platform || "");
  }
  function phoneStatus(item) {
    if (stale || isUnknown(item?.state)) return "Phone connection unknown";
    if (item?.connected === true) return "Phone connected" + (item.phoneName ? " · " + item.phoneName : "");
    if (item?.connected === false) return item.paired ? "Phone trusted · not connected" : "Phone not connected";
    return "Phone connection unknown" + (item?.paired ? " · trusted" : "");
  }
  function checkedAt() {
    const date = new Date(state?.checkedAt);
    return Number.isNaN(date.getTime()) ? "Check time unavailable" : date.toLocaleString();
  }
  function renderState() {
    statusBadge($("freshness"), stale ? "Status unavailable" : "Live · every 5s", stale ? "warning" : "good live");
    if (!state) {
      text("station-remedy", "Waiting for local status. Retry if the service is unavailable.");
      text("relay-remedy", "Waiting for local status. No worker starts automatically.");
      renderSessions();
      renderProjects();
      renderLaunchProjects();
      updateControls();
      return;
    }
    text("device-chip", state.deviceName || "This computer");
    text("metric-sessions", state.sessions.length);
    text("metric-projects", state.projects.length);
    const uncertainLinks = stale || state.sessions.some((session) => session.connected == null || isUnknown(session.state)) || isUnknown(state.station?.state);
    // Station's contract has pairing trust, not a live connected boolean.
    text("metric-connected", uncertainLinks ? "Unknown" : state.sessions.filter((session) => session.connected === true).length);
    text("metric-connected-note", "Session phone links; Station trust is shown below");
    for (const kind of ["station", "relay"]) {
      const item = state[kind] || {};
      statusBadge($(kind + "-status"), ...status(item.state));
      text(kind + "-pid", item.pid ? "PID " + item.pid : "");
      if (!item.pid) $(kind + "-pid").textContent = "";
      $(kind + "-error").hidden = !item.error;
      if (item.error) text(kind + "-error", message(item.error));
      const supported = workloadSupported() && (kind !== "station" || item.supported !== false);
      const remedy = !supported ? "Background workload controls require Windows and a supported local installation."
        : stale || isUnknown(item.state) ? "Refresh status before changing this worker."
          : isRunning(item.state) ? "Running locally. Restart and stop always ask for confirmation."
            : kind === "station" ? "Start explicitly when you want phone access to Station utilities."
              : "Use Dev Tunnel transport in Settings, then explicitly start this relay.";
      text(kind + "-remedy", remedy);
    }
    text("station-phone", stale || isUnknown(state.station?.state) ? "Phone trust unknown"
      : state.station?.paired === true ? "Phone trusted" + (state.station.phoneName ? " · " + state.station.phoneName : "")
        : state.station?.paired === false ? "No phone paired" : "Phone trust unknown");
    text("relay-address", safeAddress(state.relay?.baseUrl));
    renderWarnings();
    renderSessions();
    renderProjects();
    renderLaunchProjects();
    const currentRevision = typeof state.settingsRevision === "string" ? state.settingsRevision : undefined;
    if (!settingsInitialized || !settingsDirty && (settingsFingerprint !== JSON.stringify(state.settings) || settingsRevision !== currentRevision)) initializeSettings();
    text("diagnostic-version", state.version);
    text("diagnostic-device", state.deviceName);
    text("diagnostic-platform", state.platform);
    text("diagnostic-checked", checkedAt() + (stale ? " · stale" : ""));
    text("diagnostic-transport", state.settings.transport?.kind || "Not configured");
    renderPairingTargets();
    updateControls();
  }
  function safeAddress(value) {
    if (!value) return "No relay address available";
    try {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol)) return "Relay address unavailable";
      return url.origin;
    } catch { return "Relay address unavailable"; }
  }
  function renderWarnings() {
    const warnings = Array.isArray(state.warnings) ? state.warnings : [];
    for (const [card, list] of [["warnings-card", "warnings"], ["diagnostic-warnings", "diagnostic-warning-list"]]) {
      $(card).hidden = !warnings.length;
      $(list).replaceChildren(...warnings.map((warning) => element("li", message(warning))));
    }
  }
  function empty(container, symbol, title, detail) {
    const box = element("div", null, "empty-state");
    const tile = element("span", null, "icon-tile");
    tile.append(icon(symbol));
    box.append(tile, element("h3", title), element("p", detail));
    container.replaceChildren(box);
  }
  function actionButton(label, handler, className = "button") {
    const button = element("button", label, className);
    button.type = "button";
    button.dataset.mutation = "true";
    button.addEventListener("click", handler);
    return button;
  }
  function renderSessions() {
    const query = $("session-search").value.trim().toLowerCase();
    const filter = $("session-filter").value;
    const fingerprint = JSON.stringify([state?.sessions, query, filter, stale]);
    if (fingerprint === sessionsFingerprint) return;
    sessionsFingerprint = fingerprint;
    const all = state?.sessions || [];
    const sessions = all.filter((session) => [session.title, session.cwd, session.sessionId, session.runtimeId]
      .some((value) => typeof value === "string" && value.toLowerCase().includes(query)))
      .filter((session) => filter === "all" || (filter === "connected" ? !stale && !isUnknown(session.state) && session.connected === true
        : stale || isUnknown(session.state) || session.error || /failed|error/i.test(session.state)));
    const list = $("sessions-list");
    if (!state) {
      empty(list, "sessions", stale && !$("connection-error").hidden ? "Session status unavailable" : "Discovering local sessions…", "No sessions are activated automatically. Refresh local status to continue.");
      return;
    }
    if (!sessions.length) {
      empty(list, "sessions", all.length ? "No matching sessions" : "No sessions discovered yet",
        all.length ? "Try a different search or filter. Unknown connections are not counted as connected."
          : "Open Copilot with the Weft extension loaded, or explicitly start a session in a registered project above. Nothing starts automatically.");
      return;
    }
    const cards = sessions.map((session) => {
      const card = element("article", null, "card session-card");
      const tile = element("span", null, "icon-tile"); tile.append(icon("sessions"));
      const content = element("div");
      const badge = element("span"); statusBadge(badge, ...status(session.state));
      content.append(element("h3", session.title || "Untitled Copilot session"), element("p", session.cwd || "Workspace unavailable", "path"));
      const meta = element("div", null, "session-meta");
      meta.append(badge, element("span", phoneStatus(session)));
      if (session.watchLevel) meta.append(element("span", "Watch: " + session.watchLevel));
      if (session.pid) meta.append(element("span", "PID " + session.pid));
      content.append(meta, element("div", "Session " + (session.sessionId || "unknown") + " · Runtime " + session.runtimeId, "session-id"));
      if (session.error) content.append(element("p", message(session.error), "inline-error small"));
      const controls = element("div", null, "actions");
      const activate = actionButton("Activate Weft", () => void runOperation("session.activate", { runtimeId: session.runtimeId }, undefined, () => navigate("pairing", session.runtimeId)), "button primary");
      activate.dataset.sessionAction = "activate";
      activate.dataset.runtimeId = session.runtimeId;
      const pair = element("button", "Show pairing", "button");
      pair.type = "button";
      pair.addEventListener("click", () => navigate("pairing", session.runtimeId));
      const disconnect = actionButton("Disconnect phone", async () => {
        if (await confirmChange("Disconnect this session’s phone?", "The phone link will close. The Copilot process and its work are preserved.", ["Reconnect from the session when you need the phone again."], "Disconnect phone")) {
          await runOperation("session.disconnect", { runtimeId: session.runtimeId, confirmed: true });
        }
      }, "button danger-quiet");
      disconnect.dataset.sessionAction = "disconnect";
      disconnect.dataset.runtimeId = session.runtimeId;
      controls.append(activate, pair, disconnect);
      card.append(tile, content, controls);
      return card;
    });
    list.replaceChildren(...cards);
  }
  function renderProjects() {
    const projects = state?.projects || [];
    const fingerprint = JSON.stringify([state?.projects, stale]);
    if (fingerprint === projectsFingerprint) return;
    projectsFingerprint = fingerprint;
    text("project-count", state ? projects.length + " registered" : "Loading");
    if (!projects.length) {
      empty($("projects-list"), "folder", state ? "Make room for your work" : "Loading projects…",
        state ? "Register a local folder using the form. Removing a registration never deletes the folder." : "Project registrations will appear after local status is available.");
      return;
    }
    $("projects-list").replaceChildren(...projects.map((project) => {
      const card = element("article", null, "card project-card");
      const heading = element("div", null, "card-heading");
      heading.append(element("h3", project.name));
      if (project.default) heading.append(element("span", "Default", "badge good"));
      const controls = element("div", null, "actions");
      if (!project.default) controls.append(actionButton("Make default", () => void runOperation("project.default", { name: project.name })));
      controls.append(actionButton("Remove", async () => {
        if (await confirmChange("Remove project registration?", "Remove “" + project.name + "” from Weft. The local folder and its files are not deleted.", [], "Remove project")) {
          await runOperation("project.remove", { name: project.name, confirmed: true });
        }
      }, "button danger-quiet"));
      card.append(heading, element("p", project.path, "path"), controls);
      return card;
    }));
  }
  function renderLaunchProjects() {
    const select = $("session-project");
    const projects = state?.projects || [];
    const fingerprint = JSON.stringify(projects.map((project) => [project.name, project.default]));
    if (select.dataset.choices === fingerprint) return;
    const selected = select.value;
    const blank = element("option", "Choose a registered project");
    blank.value = "";
    const options = projects.map((project) => {
      const option = element("option", project.name + (project.default ? " (default)" : ""));
      option.value = project.name;
      return option;
    });
    select.replaceChildren(blank, ...options);
    if (projects.some((project) => project.name === selected)) select.value = selected;
    else if (!select.dataset.initialized && projects.length) select.value = projects.find((project) => project.default)?.name || "";
    if (projects.length) select.dataset.initialized = "true";
    select.dataset.choices = fingerprint;
  }
  function initializeSettings() {
    if (!state?.settings) return;
    const saved = state.settings;
    $("device-name").value = saved.deviceName || state.deviceName || "";
    $("transport").value = ["supabase", "devtunnel"].includes(saved.transport?.kind) ? saved.transport.kind : "clear";
    $("permission-mode").value = saved.permissionMode === "allow-all" ? "allow-all" : "default";
    $("pairing-mode").value = saved.pairingMode === "ephemeral" ? "ephemeral" : "persistent";
    $("terminal-enabled").checked = saved.terminalEnabled === true;
    $("files-enabled").checked = saved.files?.enabled === true;
    $("file-excludes").value = (saved.files?.exclude || []).join("\n");
    $("roots").replaceChildren();
    for (const root of saved.files?.roots || []) addRoot(root);
    $("roots-empty").hidden = $("roots").children.length > 0;
    settingsInitialized = true;
    settingsDirty = false;
    settingsFingerprint = JSON.stringify(saved);
    settingsRevision = typeof state.settingsRevision === "string" ? state.settingsRevision : undefined;
  }
  function addRoot(root = {}) {
    const row = element("div", null, "root-row");
    const fields = element("div", null, "root-fields");
    const sequence = ++rootSequence;
    for (const [key, label] of [["name", "Root name"], ["path", "Folder path"]]) {
      const wrapper = element("div");
      const input = element("input");
      input.id = "root-" + sequence + "-" + key;
      input.dataset.rootField = key;
      input.value = root[key] || "";
      input.required = true;
      input.maxLength = key === "name" ? 100 : 4096;
      input.autocomplete = "off";
      input.spellcheck = false;
      const title = element("label", label);
      title.htmlFor = input.id;
      wrapper.append(title, input);
      fields.append(wrapper);
    }
    const remove = element("button", "Remove root", "button compact danger-quiet");
    remove.type = "button";
    remove.addEventListener("click", () => {
      row.remove(); markSettingsDirty(); $("roots-empty").hidden = $("roots").children.length > 0; $("root-add").focus();
    });
    row.append(fields, remove);
    $("roots").append(row);
    $("roots-empty").hidden = true;
    return row;
  }
  function markSettingsDirty() { settingsDirty = true; updateControls(); }
  function settingsPayload() {
    return {
      deviceName: $("device-name").value.trim(),
      permissionMode: $("permission-mode").value,
      pairingMode: $("pairing-mode").value,
      terminalEnabled: $("terminal-enabled").checked,
      files: {
        enabled: $("files-enabled").checked,
        roots: [...$("roots").children].map((row) => ({
          name: row.querySelector('[data-root-field="name"]').value.trim(),
          path: row.querySelector('[data-root-field="path"]').value.trim(),
        })),
        exclude: $("file-excludes").value.split("\n").map((line) => line.trim()).filter(Boolean),
      },
      transport: { kind: $("transport").value },
    };
  }
  function sensitiveSettings(payload) {
    const saved = state.settings;
    const effects = [];
    if (payload.transport.kind !== (saved.transport?.kind || "clear")) effects.push("Transport changes can interrupt existing phone connections.");
    if (payload.permissionMode !== saved.permissionMode) effects.push(payload.permissionMode === "allow-all" ? "Allow-all mode broadens tool permissions beyond default native approvals." : "The native approval mode will change.");
    if (payload.pairingMode !== saved.pairingMode) effects.push("Pairing persistence changes how long phone trust is retained.");
    if (payload.terminalEnabled !== saved.terminalEnabled) effects.push(payload.terminalEnabled ? "The phone will be allowed to access the terminal." : "Phone terminal access will be disabled.");
    if (JSON.stringify(payload.files) !== JSON.stringify({ enabled: saved.files?.enabled === true, roots: saved.files?.roots || [], exclude: saved.files?.exclude || [] })) {
      effects.push("File-sharing access, allowed roots, or exclusions will change. Review these boundaries before saving.");
    }
    return effects;
  }
  async function confirmChange(title, description, effects, accept) {
    if (confirmationOpen || operation?.state === "running" || operation?.completing || stale) return false;
    confirmationOpen = true;
    const focus = document.activeElement;
    text("confirmation-title", title);
    text("confirmation-description", description);
    text("confirmation-accept", accept);
    $("confirmation-effects").replaceChildren(...effects.map((effect) => element("li", effect)));
    $("confirmation-effects").hidden = !effects.length;
    updateControls();
    const dialog = $("confirmation");
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => {
        confirmationOpen = false;
        updateControls();
        if (focus?.isConnected) focus.focus({ preventScroll: true });
        resolve(dialog.returnValue === "confirm");
      }, { once: true });
      dialog.returnValue = "cancel";
      dialog.showModal();
      $("confirmation-cancel").focus();
    });
  }
  const operationLabels = {
    "station.start": "Starting Device Station", "station.stop": "Stopping Device Station", "station.restart": "Restarting Device Station",
    "relay.start": "Starting relay", "relay.stop": "Stopping relay", "relay.restart": "Restarting relay",
    "project.add": "Adding project", "project.remove": "Removing project registration", "project.default": "Changing default project",
    "settings.save": "Saving settings", "pairing.replace": "Replacing phone trust",
    "session.activate": "Activating Weft session", "session.disconnect": "Disconnecting session phone", "session.start": "Starting Copilot session",
  };
  function renderOperation() {
    $("operation").hidden = !operation;
    if (!operation) return;
    $("operation-dot").className = "activity-dot " + operation.state;
    text("operation-title", operationLabels[operation.action] + (operation.state === "succeeded" ? " · complete" : operation.state === "failed" ? " · failed" : "…"));
    text("operation-detail", operation.detail || "Working locally. You can switch views; this operation will keep being checked.");
    $("operation-dismiss").hidden = operation.state === "running";
    $("operation-retry").hidden = operation.state !== "running" || !operation.pollError;
    updateControls();
  }
  async function runOperation(action, payload, onSuccess, afterSuccess) {
    if (operation?.state === "running" || operation?.completing || confirmationOpen || stale || !state) return;
    operation = { id: crypto.randomUUID(), action, state: "running", onSuccess, afterSuccess };
    renderOperation();
    try {
      const result = await api("/api/operations", { id: operation.id, action, payload });
      await acceptOperation(result);
    } catch (error) {
      if (error.status === 0 || error.status >= 500 || error.status === 202) {
        operation.pollError = true;
        operation.detail = error.message + " The request may have been accepted. Checking the same operation ID; do not repeat it.";
        renderOperation();
        scheduleOperation(1500);
      } else {
        operation.state = "failed";
        operation.detail = error.message;
        renderOperation();
      }
    }
  }
  function scheduleOperation(delay = 800) {
    clearTimeout(operationTimer);
    operationTimer = setTimeout(() => void pollOperation(), delay);
  }
  async function pollOperation() {
    if (operation?.state !== "running" || operation.polling) return;
    const current = operation;
    current.polling = true;
    try { await acceptOperation(await api("/api/operations/" + encodeURIComponent(operation.id))); }
    catch (error) {
      operation.pollError = true;
      operation.detail = error.message + " The outcome is still unknown. This page will keep checking the same operation.";
      renderOperation();
      scheduleOperation(5000);
    } finally { current.polling = false; }
  }
  async function acceptOperation(result) {
    if (!result || result.id !== operation.id || !["running", "succeeded", "failed"].includes(result.state)) {
      throw new ApiError("The local service returned an incomplete operation status.", 202);
    }
    operation.state = result.state;
    operation.pollError = false;
    if (result.state === "running") {
      operation.detail = "Working locally. Switching views or hiding this page does not cancel the operation.";
      renderOperation();
      scheduleOperation();
      return;
    }
    clearTimeout(operationTimer);
    operation.detail = result.state === "failed" ? message(result.error) : "Change completed. Refreshing local status.";
    if (result.state === "succeeded") {
      operation.completing = true;
      // Apply only the submitted draft; edits made while the operation ran are retained.
      operation.onSuccess?.(result.result);
      await refreshState();
      if (operation.afterSuccess) operation.afterSuccess(result.result);
      else if (page === "pairing") await loadPairing();
      operation.detail = stale ? "Change completed, but fresh status is unavailable. Refresh before making another change." : "Change completed. Local status is up to date.";
      operation.completing = false;
    }
    renderOperation();
  }
  function updateControls() {
    const busy = operation?.state === "running" || operation?.completing || confirmationOpen;
    const unavailable = busy || stale || !state;
    for (const button of document.querySelectorAll("[data-mutation]")) button.disabled = unavailable;
    for (const kind of ["station", "relay"]) {
      const item = state?.[kind];
      const unsupported = !workloadSupported() || kind === "station" && item?.supported === false;
      const unknown = isUnknown(item?.state);
      for (const action of ["start", "restart", "stop"]) {
        const button = $(kind + "-" + action);
        button.disabled = unavailable || unsupported || unknown || (action === "start" ? isRunning(item?.state) : !isRunning(item?.state)) || /^(starting|stopping|restarting)$/i.test(item?.state || "");
        button.title = unsupported ? "Background workload controls require Windows and a supported installation." : stale || unknown ? "Refresh to get a known status first." : busy ? "Wait for the current operation." : "";
      }
    }
    for (const button of document.querySelectorAll("[data-session-action]")) {
      const session = state?.sessions.find((item) => item.runtimeId === button.dataset.runtimeId);
      const unknown = isUnknown(session?.state);
      button.disabled = unavailable || unknown || (button.dataset.sessionAction === "activate" ? isRunning(session?.state) : session?.connected !== true && session?.paired !== true);
      button.title = stale || unknown ? "Refresh to get a known session status first."
        : button.dataset.sessionAction === "activate" && isRunning(session?.state) ? "Weft is already active for this runtime." : "";
    }
    $("project-add").disabled = unavailable;
    const stationReady = workloadSupported() && state?.station?.supported !== false && /^(running|active|ready|pairing-ready|listening)$/i.test(state?.station?.state || "");
    const transportReady = ["supabase", "devtunnel"].includes(state?.settings?.transport?.kind);
    $("session-start").disabled = unavailable || !stationReady || !transportReady || !state?.projects?.length;
    text("session-start-remedy", stale ? "Refresh local status before starting a session."
      : !stationReady ? "Start Device Station from Overview first. Background Station controls require Windows."
        : !transportReady ? "Choose a transport in Settings before starting a session."
          : !state?.projects?.length ? "Register a project first."
            : "Starts a new local Copilot process only when you choose Start session.");
    $("settings-fields").disabled = !settingsInitialized;
    $("settings-save").disabled = unavailable || !settingsDirty;
    $("settings-reset").disabled = !settingsDirty || busy || stale;
    $("settings-dirty").hidden = !settingsDirty;
    text("settings-note", !settingsInitialized ? "Loading saved settings…" : settingsDirty ? "Your edits are local until saved." : "Saved settings · no unsaved changes");
    $("pairing-replace").disabled = unavailable || pairingTarget !== "" || !workloadSupported() || state?.station?.supported === false || isUnknown(state?.station?.state) || !isRunning(state?.station?.state);
    $("pairing-replace").title = pairingTarget ? "Trust replacement here applies to Device Station only."
      : !isRunning(state?.station?.state) ? "Start Device Station from Overview first." : "";
  }
  function clearPairing(invalidate = true) {
    if (invalidate) pairingRequest++;
    $("pairing-qr").hidden = true;
    $("pairing-qr").removeAttribute("src");
    $("pairing-code").value = "";
    $("pairing-code-details").hidden = true;
    $("pairing-code-details").open = false;
    $("qr-placeholder").hidden = false;
  }
  function renderPairingTargets() {
    const select = $("pairing-target");
    const choices = [["", "Device Station"], ...(state?.sessions || []).map((session) => [String(session.runtimeId), session.title || "Copilot session " + session.runtimeId])];
    if (pairingTarget && !choices.some(([id]) => id === pairingTarget)) choices.push([pairingTarget, pairingTarget === "__launched" ? "Newly started session" : "Previously selected session · status unavailable"]);
    const fingerprint = JSON.stringify(choices);
    if (select.dataset.choices !== fingerprint) {
      select.replaceChildren(...choices.map(([id, label]) => {
        const option = element("option", label); option.value = id; return option;
      }));
      select.dataset.choices = fingerprint;
    }
    select.value = pairingTarget;
  }
  async function loadPairing(provided) {
    if (page !== "pairing") return;
    clearPairing();
    const request = pairingRequest;
    $("pairing-refresh").disabled = true;
    statusBadge($("pairing-badge"), "Loading pairing", "warning");
    text("pairing-visual-title", "Preparing a private connection");
    text("pairing-visual-detail", "Fetching only the selected destination’s pairing details.");
    text("pairing-message", "Loading pairing details…");
    try {
      if (!provided && pairingTarget === "__launched") throw new ApiError("Choose the newly discovered session from the destination list to refresh its pairing. The launch result did not include a runtime ID.", 200);
      const result = provided || await api("/api/pairing" + (pairingTarget ? "?runtimeId=" + encodeURIComponent(pairingTarget) : ""));
      if (request !== pairingRequest || page !== "pairing") return;
      if (!result || typeof result !== "object") throw new ApiError("Pairing details are unavailable. Refresh this view.", 200);
      const paired = result.paired === true;
      const expired = result.expired === true || result.expiresAt != null && Number(result.expiresAt) <= Date.now();
      statusBadge($("pairing-badge"), paired ? "Phone trusted" : "Not paired", paired ? "good" : "");
      const qr = !paired && !expired && typeof result.qr === "string" && /^data:image\/png;base64,[A-Za-z0-9+/=\r\n]+$/.test(result.qr) && result.qr.length < 2000000 ? result.qr : null;
      if (qr) {
        $("pairing-qr").src = qr;
        $("pairing-qr").hidden = false;
        $("qr-placeholder").hidden = true;
      }
      if (!paired && !expired && typeof result.code === "string" && result.code) {
        $("pairing-code").value = result.code;
        $("pairing-code-details").hidden = false;
      }
      text("pairing-visual-title", paired ? "An existing phone is trusted" : "No pairing QR available");
      text("pairing-visual-detail", paired ? (result.phoneName || "Your paired phone") + ". Trust does not guarantee a live connection."
        : "Start the selected runtime and configure transport. Refresh pairing when ready.");
      text("pairing-message", paired ? "Keep your existing pairing to reconnect. Replace trust only when you intentionally want a different phone."
        : expired ? "This pairing code has expired. Refresh pairing to request the current code."
          : qr || result.code ? "Ready to scan or copy. Pairing trust is established only when the phone completes the handshake."
          : "No usable pairing code is available. Check Overview and transport Settings; this view does not start anything.");
      if (isUnknown(result.state)) {
        statusBadge($("pairing-badge"), "Pairing status unknown", "warning");
        clearPairing(false);
        text("pairing-message", "Pairing status is unknown. Refresh before using or rotating trust.");
      }
    } catch (error) {
      if (request !== pairingRequest || page !== "pairing") return;
      statusBadge($("pairing-badge"), "Pairing unavailable", "bad");
      text("pairing-visual-title", "Let’s restore the connection");
      text("pairing-visual-detail", "No private code is shown while pairing status is unavailable.");
      text("pairing-message", error.message);
    } finally {
      if (request === pairingRequest || page !== "pairing") $("pairing-refresh").disabled = false;
      updateControls();
    }
  }

  $("refresh").addEventListener("click", () => void refreshState());
  $("retry").addEventListener("click", () => void refreshState());
  $("session-search").addEventListener("input", () => { renderSessions(); updateControls(); });
  $("session-filter").addEventListener("change", () => { renderSessions(); updateControls(); });
  $("operation-dismiss").addEventListener("click", () => { if (operation?.state !== "running") { operation = null; renderOperation(); } });
  $("operation-retry").addEventListener("click", () => { clearTimeout(operationTimer); void pollOperation(); });
  for (const kind of ["station", "relay"]) {
    $(kind + "-start").addEventListener("click", () => void runOperation(kind + ".start", {}));
    for (const action of ["stop", "restart"]) {
      $(kind + "-" + action).addEventListener("click", async () => {
        const station = kind === "station";
        const title = (action === "stop" ? "Stop " : "Restart ") + (station ? "Device Station?" : "the Dev Tunnel relay?");
        const description = station
          ? "Station utilities on the phone will close. Your Copilot processes and sessions are preserved."
          : "Phone connections using this relay will be interrupted. Copilot processes remain running.";
        if (await confirmChange(title, description, [action === "stop" ? "It stays stopped until you explicitly start it again." : "The worker will stop and then start again."], action === "stop" ? "Stop " + (station ? "Station" : "relay") : "Restart")) {
          await runOperation(kind + "." + action, { confirmed: true });
        }
      });
    }
  }
  $("project-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const payload = { name: $("project-name").value.trim(), path: $("project-path").value.trim(), makeDefault: $("project-default").checked };
    if (!payload.name || !payload.path) return;
    const draft = JSON.stringify(payload);
    await runOperation("project.add", payload, () => {
      const current = JSON.stringify({ name: $("project-name").value.trim(), path: $("project-path").value.trim(), makeDefault: $("project-default").checked });
      if (draft === current) $("project-form").reset();
    });
  });
  $("session-start-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if ($("session-start").disabled) return;
    const payload = { projectName: $("session-project").value, mode: $("session-mode").value };
    const name = $("session-name").value.trim();
    if (name) payload.name = name;
    if (!payload.projectName) return;
    if (payload.mode === "allow-all" && !await confirmChange("Start with broader permissions?", "Allow-all mode broadens tool permissions for this new Copilot session.", ["Use the default approval mode if you want native approvals."], "Start session")) return;
    if (payload.mode === "allow-all") payload.confirmed = true;
    const draft = JSON.stringify({ projectName: $("session-project").value, name: $("session-name").value, mode: $("session-mode").value });
    await runOperation("session.start", payload, () => {
      if (JSON.stringify({ projectName: $("session-project").value, name: $("session-name").value, mode: $("session-mode").value }) === draft) $("session-name").value = "";
    }, (result) => {
      const details = result?.pairing || result;
      const runtimeId = result?.runtimeId || result?.session?.runtimeId;
      if (runtimeId || details?.code || details?.qr) navigate("pairing", runtimeId || "__launched", details?.code || details?.qr ? details : undefined);
    });
  });
  $("settings-form").addEventListener("input", markSettingsDirty);
  $("settings-form").addEventListener("change", markSettingsDirty);
  $("root-add").addEventListener("click", () => { const row = addRoot(); markSettingsDirty(); row.querySelector("input").focus(); });
  $("settings-reset").addEventListener("click", async () => {
    if (await confirmChange("Discard unsaved settings?", "Your local edits will be replaced by the last retrieved saved settings.", [], "Discard edits")) { initializeSettings(); updateControls(); }
  });
  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!settingsDirty || stale || !state) return;
    const payload = settingsPayload();
    const names = payload.files.roots.map((root) => root.name);
    if (new Set(names).size !== names.length || payload.files.roots.some((root) => !root.name || !root.path)) {
      $("settings-note").textContent = "Every root needs a unique, nonempty name and a folder path.";
      return;
    }
    const effects = sensitiveSettings(payload);
    if (effects.length && !await confirmChange("Save access or connection changes?", "These settings affect trust, permissions, or what the phone can access. Review the effects below.", effects, "Save changes")) return;
    const draft = JSON.stringify(payload);
    await runOperation("settings.save", {
      ...payload,
      ...(settingsRevision === undefined ? {} : { expectedRevision: settingsRevision }),
      ...(effects.length ? { confirmed: true } : {}),
    }, () => {
      if (JSON.stringify(settingsPayload()) === draft) {
        settingsDirty = false;
        settingsFingerprint = "";
      }
    });
  });
  $("pairing-target").addEventListener("change", () => { pairingTarget = $("pairing-target").value; void loadPairing(); });
  $("pairing-refresh").addEventListener("click", () => void loadPairing());
  $("pairing-copy").addEventListener("click", async () => {
    if (!$("pairing-code").value || page !== "pairing") return;
    try {
      await navigator.clipboard.writeText($("pairing-code").value);
      text("pairing-message", "Pairing code copied. Keep it private and clear your clipboard after use.");
    } catch {
      $("pairing-code").focus();
      $("pairing-code").select();
      text("pairing-message", "Clipboard access unavailable. The private code is selected for manual copying.");
    }
  });
  $("pairing-replace").addEventListener("click", async () => {
    if (pairingTarget) return;
    if (await confirmChange("Replace Device Station phone trust?", "This rotates pairing trust. The previous phone will lose access and must be paired again.", ["Do not use this to repair a temporary connection drop.", "Scan the new code on the phone you intend to trust."], "Replace phone trust")) {
      clearPairing();
      await runOperation("pairing.replace", { confirmed: true });
    }
  });
  $("update-check").addEventListener("click", async () => {
    $("update-check").disabled = true;
    text("update-result", "Checking published release availability…");
    try {
      const result = await api("/api/update");
      if (!result || typeof result.available !== "boolean" || typeof result.current !== "string") throw new ApiError("Release availability could not be verified. Try again later.", 200);
      text("update-result", (result.available ? "Update available" + (result.latest ? ": " + result.latest : "") + ". Current installation: " + result.current + "."
        : "No newer published release reported. Current installation: " + result.current + ".") + (result.message ? " " + message(result.message) : "") + " Nothing has been installed.");
    } catch (error) { text("update-result", error.message); }
    finally { $("update-check").disabled = false; }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void refreshState();
      if (page === "pairing") void loadPairing();
    }
  });
  setInterval(() => { if (!document.hidden) void refreshState(); }, 5000);
  renderState();
  void refreshState();
}

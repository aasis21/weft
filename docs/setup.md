# Developer setup

[Documentation handbook](https://aasis21.github.io/weft/#development) ·
[Install the prebuilt release](https://aasis21.github.io/weft/#quickstart)

This guide is for changing Weft itself. To use Weft without a source checkout,
follow the [installation quickstart](https://aasis21.github.io/weft/#quickstart).

Work in this order: install dependencies, exercise the local harness and demo,
then install your source build and try a real phone. Local simulation needs no
Supabase project or phone; it does not prove cross-device connectivity.

- [Prerequisites and dependencies](#prerequisites)
- [Local validation](#verify-everything-no-network-no-phone)
- [Demo and simulator](#run-the-mobile-demosimulator)
- [Install and pair a source build](#run-the-real-extension-under-copilot-cli-or-the-local-app)
- [Deployments](#shipping-it-environments)
- [Custom Supabase](#wire-your-own-supabase-project)
- [Dev Tunnel lifecycle](#pairing-with-the-devtunnel-transport)

## Prerequisites

- Node.js 20 or newer.
- For the hosted web app and demo: a current browser.
- Only for building the native Android app: JDK 21 (`JAVA_HOME`) and Android SDK
  Platform 35 (`ANDROID_HOME`, or `mobile/android/local.properties`). Android Studio
  can provide both. The Gradle wrapper handles Gradle itself.
- The session extension uses `@github/copilot-sdk`, supplied by the CLI or Copilot app
  host at runtime. Device Station launches require an installed, signed-in CLI.

## Install

```sh
cd weft
npm ci --workspaces --include-workspace-root
```

## Verify everything (no network, no phone)

After dependencies are installed, these checks exercise core flows without an
external relay or physical phone:

```sh
# 1. Shared contracts: crypto, pairing handshake, transport, message round-trips
npm test -w @aasis21/weft-shared

# 2. Extension relay end-to-end against a simulated phone (LocalTransport):
#    pairing → stream → approval round-trip → prompt → mode switch → session end
node extension/harness/harness.mjs --auto

# 3. Bundle the extension (esbuild; @github/copilot-sdk left external)
npm run build -w @aasis21/weft-extension   # -> dormant extension.mjs + lazy activeRuntime.mjs

# 4. Build the mobile app (Vite production build)
npm run build -w @aasis21/weft-mobile
```

For the repository-wide checks, run `npm test`, `npm run build`, `npm run lint`,
and `npm run check-version`. Mobile type tests use
`npm run test:types -w @aasis21/weft-mobile`. For browser journeys, install the
Playwright runtimes once with `npx playwright install chromium webkit`, then run
`npm run test:e2e -w @aasis21/weft-mobile`.

## Run the mobile Demo/Simulator

```sh
cd mobile
npm run dev          # open the printed localhost URL
```

### Optional Explore video widget

Explore's balanced Discover deck, Play, Unwind, and live Copilot dock require no
external content provider. The dock only projects activity already available in the
active Weft session and returns attention actions to chat. To exercise the Watch
category, set an HTTPS URL for an isolated, auto-updating widget before starting or
building the mobile app:

```powershell
$env:VITE_EXPLORE_WIDGET_URL = 'https://your-widget-provider.example/embed/...'
npm run dev -w @aasis21/weft-mobile
```

The URL is build-time configuration, not a credential and not committed to source.
Watch does not load it until the user explicitly chooses **Load video feed**. The
provider runs in a sandboxed iframe with no Weft prompt, repository, filename, tool,
agent-activity, channel, or session values appended or posted to it. Weft treats frame
load only as navigation, not proof that cross-origin content rendered. Offline or invalid
configuration produces an unavailable state; an unverified or blank embed keeps explicit
reload, hide, and open-directly controls. The rest of Explore remains offline-capable.

In the app choose **Try the demo**. It stands up a fake laptop side in-process
(real ECDH keypairs + `LocalTransport`), completes the real
`pair.hello`/`pair.challenge`/`pair.proof`/`pair.ack` handshake, then streams scripted
assistant/tool events, an approval card, heartbeats, and reflects mode changes — all
application payloads travel over AES-256-GCM.

## Run the real extension under Copilot CLI (or the local app)

The source installer writes code into your personal Copilot extensions directory.
Review it before running it in a managed environment.

**1. Install the extension** (builds + copies the dormant `extension.mjs` bootstrap, lazy
`activeRuntime.mjs`, and on-demand `pairingCanvas.mjs` into
`~/.copilot/extensions/weft/`, discovered by CLI and local app sessions — that directory holds
installed **code only**):

```sh
.\setup.ps1     # Windows PowerShell
./setup.sh      # macOS/Linux
# remove later with ./uninstall.ps1 / ./uninstall.sh
```

Transport (Supabase vs. devtunnel) is configured via two small files in `~/.weft/`:
`weft.config.json` (the transport **pointer**, written by `weft set-transport`) and
`supabase.json` (the Supabase URL + anon key, seeded by the installer — with the hosted
defaults, or with your own project's creds if you pass `-SupabaseUrl`/`-SupabaseKey`).
They sit alongside `projects.json` and the devtunnel registry (see `weftHome()` in
`extension/src/projects.mjs`), and there is **no env var / `.env`** for either (see
`transportConfig.mjs` / `transportFactory.mjs`). Because they're separate, `weft
set-transport supabase` (which takes no keys) just flips the pointer back after you've experimented
with devtunnel — your creds are still on disk from the last install, no re-typing. And
re-running `setup.ps1`/`setup.sh` (or the site installer) never silently resets or shadows
whatever you've already configured — the installers only re-seed `supabase.json` if it's
absent or you explicitly passed `-SupabaseUrl`/`-SupabaseKey` (or `-Force`), and
`setup.ps1`/`setup.sh` print a reminder to run `weft set-transport` if no pointer is
configured yet.

**2. Get the app on your phone** — use the PWA by default:

- **Hosted PWA (supported primary distribution):** open **<https://useweft.netlify.app>** on your phone,
  then choose **Install app** or **Add to Home Screen** in the browser. It can also run
  directly in the browser. Android Chrome uses `BarcodeDetector` for QR scanning; iOS
  Safari and Firefox use the in-page jsQR fallback.
- **Android test app:** Download the signed APK from the
  [GitHub test prerelease](releases.md#phone-app) for updates that keep your
  pairing and app data. The local debug APK below is for development only.
- **Local dev server:** `cd mobile && npm run dev` serves the demo on your development
  computer. For a physical phone, use an HTTPS-served development deployment:
  an ordinary HTTP LAN address is not a secure context for camera and Web Crypto
  APIs. Manual paste is available in desktop browsers and the native Android app.

To build a debug-signed APK locally, run from the repository root after `npm ci`:

```sh
npm run build:android -w @aasis21/weft-mobile
adb install -r mobile/android/app/build/outputs/apk/debug/app-debug.apk
```

Use an emulator or enable USB debugging on your Android device before running `adb`.
Open Weft, allow camera access if prompted, and scan a fresh QR from your laptop.
Weft uses its in-app camera if the Google Barcode Scanner module is unavailable.
For an emulator or an unavailable camera, choose **Paste pairing code** instead.
Copy the code from the laptop's **Pairing** tab in Weft Control Center, paste it
into the app, and choose **Pair from pasted code**. Don't share the code in logs
or chat.
This APK is for local testing, not a signed production release.

**3. Pair and drive it.** Run `weft start`. On Windows and macOS you can close its
terminal once startup succeeds; Station continues in a manually started per-user
background workload. Use `weft status` and `weft stop` to manage it. For
terminal-owned operation, use `weft start --foreground`; other platforms retain
foreground mode.
Open <https://useweft.netlify.app> on the phone, choose **Scan QR to pair**, and scan the
code. The phone can then start or resume Copilot sessions in registered projects.
For a source-built phone UI, use your HTTPS development deployment instead.

Device Station must remain running for phone-driven project/session discovery, Start,
Open/Resume, and activation of dormant sessions. If the selected Copilot session is
already open, Station uses its user-local lifecycle endpoint to activate that exact
session runtime, including a local Copilot app session; it does not launch a second `copilot --resume`.

If a laptop session has closed, its phone chat offers **Resume on laptop** through a
paired Station. Choose the laptop first if the chat's source device is unknown.
This reopens the same saved conversation, reconnecting to
an existing runtime first when possible. **Reconnect** only retries the old connection.
Station must be running; a takeover still requires confirmation. The **Continue**
list can sort newest-first by **Latest activity** or **Created**. Creation sorting
requires an updated Station to supply creation dates and sort before the result limit.

To pair only the current session, `/weft` shows a terminal QR in CLI or a canvas in
the local Copilot app. You can also ask Copilot to open Weft pairing. Station is not required.
After either path pairs, active prompts, events, approvals, streaming, and terminal data
flow directly between the phone and session over the encrypted relay, bypassing Station
and the local lifecycle endpoint.

Keep the same browser identity when testing reconnection. If its storage has been
cleared, stop the station and follow
[phone replacement](https://aasis21.github.io/weft/#recovery). Do not reset pairing
as a substitute for diagnosing a relay problem.

After `/clear`, the replacement Copilot session starts dormant and must be activated
again through Device Station or a new `/weft` QR.
See [advanced usage](./advanced.md) for per-session transport overrides.

### Laptop Control Center

After installing your source build, run `weft` (or `weft ui`). An installed Chromium
browser opens a private, loopback-only dashboard in its own app-style window,
without browser tabs or an address bar. Edge is preferred on Windows, followed by
Chrome; supported Chrome/Edge/Chromium locations are checked on other platforms.
Use `weft ui --browser` for the ordinary browser. If Chromium is unavailable, Weft
reports that fallback; it does not install a browser or bypass enterprise policy.
All assets are bundled with the CLI, with no
separate frontend server or repository checkout required. It exposes Station/relay
start, stop and restart, project registration/defaults, settings, local session
activation/disconnection, Station-mediated session launch, pairing and update checks.

The app window uses a private persistent profile under
`~/.weft/control-center-profile`, separate from your usual browsing profile.
This is Chromium app mode, not Electron or a system service.
Opening the dashboard starts only its local host. Viewing sessions does not activate
them. Closing the page leaves Station, relay and Copilot running; the unused UI host
expires after five minutes without requests once accepted operations finish.
`weft ui status` checks the host and `weft ui stop` stops it without touching workloads.
Use `weft help`, `weft --help` or `weft -h` for terminal help instead of opening the UI.

The window also loads the bundled Weft logo, without an external image request.
**Setup -> Local diagnostic logging** saves a laptop-wide preference; the CLI
equivalents are `weft set-logging on`, `weft set-logging off`, and `weft show-logging`.
Logging defaults on and updated Weft writers check it on each write. It does not
change Copilot history or delete earlier logs. After installing an update, restart
older Station/relay workers and reload older Weft sessions before expecting the
new setting to affect them.
Use **Diagnostics -> Load diagnostics** or `weft logs` to read the latest 100
sanitized Station/management entries. Startup stages, session-list elapsed times,
terminal broker outcomes and operation identifiers help isolate slow discovery
from failed launch or connection. Nothing is uploaded automatically; review even
sanitized output before sharing. See [privacy](../PRIVACY.md#local-diagnostics).

**Diagnostics -> Phone traffic** shows the latest 100 encrypted messages between this
laptop and your phone, refreshed every 2 seconds only while that page is open. Rows
show time, direction (Phone -> Laptop or Laptop -> Phone), Station or session, a
readable event name, size and result: delivered, replied in N seconds, waiting, no
reply after 60 seconds, or failed. Heartbeats and streaming chunks are grouped.
Filter to Station, sessions or problems only, hide heartbeats, pause, clear the
view, or copy a sanitized table for a bug report. Only metadata is kept, in memory.
Restart older Station workers and reload older sessions after updating; they report
that traffic is unavailable rather than showing nothing.

On Windows, normal installation adds **Weft Control Center** to Start.
`weft ui shortcut` adds a desktop shortcut. Shortcut targets use installed code,
not a fixed localhost port or pairing URL. Foreground-owned workloads must be managed
in their owning terminal; the UI does not silently take ownership or kill them.
Other platforms can use local configuration/session views but retain foreground
workload commands.

Background Station opens a visible Windows console for a phone-launched CLI when
there is no Windows Terminal context. Identity and working directory are restored
inside that shell. Broker success means a terminal was opened, not that Copilot
connected: runtime readiness remains a separate handshake. Do not start duplicate
sessions to recover an uncertain launch.
Copilot can show startup prompts for installed extensions or authentication before
the CLI is fully usable. Complete those native prompts in the opened terminal;
Weft does not grant elevated extension permissions or fix unrelated MCP credentials.
An already-online device is not proof that a new Copilot session finished startup.

Dev Tunnel sign-in remains an explicit terminal step when required:
`devtunnel user login -g`. Browser start does not wait on hidden terminal prompts.
On Dev Tunnel, **Start Station** reuses a healthy relay or starts it first, then
starts Station. A cold `devtunnel --version` can be slow, so Weft allows 30 seconds
and retries later rather than reporting the CLI as missing after a slow check.
Configuration changes explain restart requirements. Stop Relay and trust replacement
require confirmation; unregistering a folder removes only its shortcut registration.

Windows status checks can take several seconds on a busy laptop. Control Center
waits up to 30 seconds and shows the parts it could verify; sign-in is checked in the
background in. If Station or the relay exits without `weft stop`, its card and
`weft status` report "stopped unexpectedly" with the worker exit code, what the
code means, and the last recorded error. Start it again; saved phone trust is
unchanged.

A crashed worker restarts after 1 second, and the wait doubles to at most 30
seconds; a run of 60 seconds or more resets it. After 5 crashes in a row, each
within a minute of starting, the card and `weft status` show **Crashing
repeatedly**. They also show the exact last error (name, code, message, and file
and line), the exit code and the next retry time. **Copy error details** copies
the details for a bug report. Fix the cause, then **Restart**; **Stop** ends the
retries. Errors are recorded only while local diagnostics are on.

Phone connectivity is based on recent authenticated peer traffic, not a saved
pairing record. When no recent evidence is available, the panel reports unknown;
watch level and runtime activation are displayed separately. The Control Center
does not show transcripts or provide an arbitrary command/file browser.

The main **Control** page counts dormant runtimes as **not shared**, not unknown
phone connections. Confirmed mobile links count session links rather than physical
phones; pending/unreported links are listed separately. Worker versions and uptime,
last authenticated phone contact, forwarding checks, and measured startup stages
help distinguish a stopped worker from a slow or recovering transport. Endpoint
display accepts WebSocket URLs and strips private paths, credentials and query data.
Fields absent from older running workers are not inferred from installed code:
restart the worker/reload the session after updating for richer reporting.

**Setup** merges Projects and Settings into one page without merging their storage:
Add/Remove/Set default remain explicit project operations, while configuration
edits require Save settings. Unsaved edits survive navigation and polling.

Control displays Dev Tunnel sign-in provider/account from a bounded, cached
read-only `devtunnel user show --json` query. Refreshing that information never
signs in or switches accounts. With Supabase selected, the card shows project
configuration and reported Station connection state instead, without keys or
tunnel controls. A running unused relay is visible and requires an explicit,
confirmed stop. Changing a selected transport/project does not silently change
an existing worker's connection; the UI calls out a required Station restart.

Saved phone trust is read independently of Station liveness. Stopped or unreadable
runtime data never implies an absent pairing. A fresh QR still requires the
selected endpoint to be running.

Installer-source overrides, clean-install and actual code updates remain terminal
operations. Update checks read the published release manifest, not session content.
Do not use `weft update` to test an unreleased source change; install the source build
explicitly through the documented source installer.

> The web app is a static build of `mobile/dist`; the docs site is the separate
> `docs/` tree on GitHub Pages. The phone reads relay details from its pairing QR,
> so a custom relay does not require a separate web-app build. Deploy the app using
> the release scripts or workflows below so hosted installers and the release
> manifest stay consistent with the app.

### Shipping it: environments

`ship.sh` / `ship.ps1` deploy to Netlify from a laptop. GitHub Actions uses `ship.sh`
with the target environment's site configuration. The test and production workflows
have different triggers and publication rules:

| Workflow | Environment | Netlify site | URL | Triggers |
| --- | --- | --- | --- | --- |
| `Deploy Netlify Production` | `production` | `useweft` | <https://useweft.netlify.app> | manual only |
| `Deploy Netlify Test` | `test` | `useweft-test` | <https://useweft-test.netlify.app> | successful `main` CI + manual |

The test workflow runs after CI succeeds on `main` and checks out that CI run's commit.
A successful deployment publishes that validated commit; a pending or failed deployment
leaves the previous site in place. Production requires an explicit dispatch:

```sh
gh workflow run "Deploy Netlify Production" --repo aasis21/weft
```

**Deploying a feature branch.** The `test` environment has no deployment-branch policy, so the test
workflow can be dispatched from any ref — pick the branch in the Actions UI, or:

```sh
gh workflow run "Deploy Netlify Test" --ref users/<you>/<feature> -f mode=preview
```

`mode=preview` (the default for a manual run) is a Netlify *draft* deploy: it publishes to a unique
throwaway URL and leaves `useweft-test.netlify.app` alone, so several branches can be in flight at
once. `mode=live` overwrites the shared test site, as does the automatic deployment after
successful `main` CI. The resulting URL is printed in the run's job summary.

Each environment holds `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID`. The installers are checked in
with the production origin as their default, so at deploy time the ship scripts resolve the target
site's real URL and rewrite the `mobile/dist` copies of `install.sh` / `install.ps1` (never the
sources) — a test deploy therefore serves an installer that pulls *its own* bundles. (A preview
deploy retargets to the test site's canonical URL, not the throwaway draft URL, since the draft URL
is only known after the upload.)

## Updating an installed laptop

```sh
weft update --check
weft update
```

The check is read-only and also reports mandatory files that need repair at the current
version. The update uses the bundle set declared by the published release manifest,
verifies every downloaded file, replaces installed code and the Weft skill transactionally,
and preserves `~/.weft/` configuration, registered projects, and persistent pairing
material. Restart Station and restart or reload the Copilot session after updating. PWA updates arrive through
the browser; close and reopen the installed PWA if a newly published version is not visible.

Notification behavior depends on the browser and operating system. Exercise permission
prompts and background behavior on a real device; do not treat the local demo as proof of
notification delivery. The session thread remains the place to review pending approvals.
Do not promise that a backgrounded or killed PWA will wake for a request. See the
[notification limitations](https://aasis21.github.io/weft/#notifications).

## Wire your own Supabase project

1. Create a Supabase project.
2. Enable **Realtime Authorization** and add RLS policies on `realtime.messages` that
   allow anonymous/authenticated broadcast only within the `private:weft:*` namespace.
   This is namespace-level gating, not per-user channel authorization. It is stored as code:
   apply [`supabase/migrations/`](../supabase/migrations) to the project (via the Supabase
   MCP, the Supabase CLI `supabase db push`, or by pasting the SQL into the dashboard SQL
   editor). Channels are opened with `config.private = true`, so **joins are denied until
   this migration is applied** (see [`security.md`](./security.md) and
   [`supabase/README.md`](../supabase/README.md)).
3. Wire up the extension's transport (no env var, no `.env` — see
   [`hosting.md`](./hosting.md#configuring-the-extensions-transport)). Supply your project's
   creds at install time, then select the transport:
   ```sh
   # bash installer: seed your own project's creds
   curl -fsSL https://useweft.netlify.app/install.sh | \
     WEFT_SUPABASE_URL="https://YOUR_PROJECT.supabase.co" \
     WEFT_SUPABASE_ANON_KEY="YOUR_CLIENT_SAFE_ANON_KEY" bash
   # (or edit ~/.weft/supabase.json directly), then:
   weft set-transport supabase
   ```
   The mobile side needs no extra wiring — it reads the URL + anon key straight from
   whatever pairing QR the extension stamps (see [`hosting.md`](./hosting.md)).
4. The caller constructs a `@supabase/supabase-js` client, calls
   `client.realtime.setAuth(anonKey)` (the anon key is the Realtime access token that RLS
   authorizes), and passes it to `createSupabaseTransport({ client, channelId })` (the
   `shared/` package stays dependency-free by injecting the client). The extension does
   this automatically once `weft set-transport supabase` has been run.

> `SupabaseTransport` registers a single catch-all broadcast listener
> before `subscribe()` and dispatches internally, so subscriptions added after `connect()`
> still receive events. No subscribe-ordering constraint remains for cross-device use.

## Pairing with the `devtunnel` transport

The devtunnel transport is **operator-run** for `/weft` — the shared local relay +
Microsoft Dev Tunnel is your responsibility to bring up inside a Copilot session, in
exactly the same sense that the Supabase transport expects you to have already spun up a
Supabase project. `/weft` never spawns the tunnel for you; it just reads the shared
registry (`~/.weft/devtunnel.json`) and uses whatever's running.

**`weft start` is the exception**: the standalone Device Station will provision the relay
itself when one isn't already healthy (see
[Self-provisioning with `weft start`](#self-provisioning-with-weft-start) below).

**Explicit relay flow** (after `weft set-transport devtunnel`):

```sh
# bring up the shared relay; Windows returns after background readiness
weft devtunnel start

# terminal 2 — pair as usual; /weft picks up the running relay
copilot                       # then run /weft inside the session
# or, standalone:
weft start
```

On Windows and macOS the shared relay is supervised by a manually started
per-user background workload. Closing the launching terminal does not stop it.
Repeated starts reuse the workload, not competing provisioners. Use
`weft devtunnel status` for health and `weft devtunnel stop` to disable restart
before stopping it. Foreground mode (`weft devtunnel start --foreground`) and
other platforms retain a terminal-owned relay. Every activated session discovers it through
`~/.weft/devtunnel.json`; `/weft` never starts infrastructure.

If you run `/weft` with `transport = devtunnel` and no relay is running, pairing fails
fast with an actionable error pointing you at `weft devtunnel start`. This is deliberate
— it mirrors how the Supabase transport won't try to spin up Supabase for you either.

### Self-provisioning with `weft start`

On Windows and macOS, `weft start` validates configuration/projects and completes
any required interactive sign-in, then starts the shared background relay and
background Station. Neither workload starts at boot/sign-in. A failed workload
restarts under the same signed-in user's permissions. Station stopping leaves the
relay available.

The relay manager checks local service health and public forwarding every 30 seconds.
An unreachable network does not cause endpoint replacement; repeated public rejection
or a dead relay triggers recovery. Saved tunnel ID and local port are preferred.
An endpoint change is explicit: `weft status` reports `endpoint-refresh-needed` and
`weft start` retrieves the updated QR. Direct sessions similarly ask for `/weft` when
their shared endpoint changes. Ordinary reconnects retain trust and use a fresh secure
handshake automatically, without scanning.

In foreground mode, `weft start` on the `devtunnel` transport:

1. **reuses** an already-healthy relay from `~/.weft/devtunnel.json` if there is one (and
   then never touches its lifetime — the owning terminal still owns it), otherwise
2. **checks the `devtunnel` CLI**, and if the account is signed out (including the case
   where `devtunnel user show` exits 0 but prints `Login token expired.`) runs
   `devtunnel user login -g` and re-verifies before continuing,
3. **clears a stale registry entry** (a record claiming a relay that is no longer
   running) and provisions a fresh relay, then
4. **watches its health every 30s** for as long as the station runs, re-provisioning once
   if it goes away — if the new relay comes back on a different URL the station moves
   itself onto it and prints a fresh QR right in the terminal, so you re-scan once
   instead of restarting `weft start` (the channel and keys are unchanged), and
5. **releases it on exit** — but only if this station is the process that started it. A
   relay you brought up with `weft devtunnel start` is never torn down by a station
   shutting down.

With persistent pairing on, teardown keeps the cloud tunnel so the next start comes back
on the same URL and already-paired phones reconnect without re-scanning. Use
`weft devtunnel start` when you want the relay to outlive individual stations (e.g. so
`/weft` in Copilot sessions has something to attach to).

## Configuration reference

Transport (Supabase vs. devtunnel) is **not** an env var — it's configured via `weft
set-transport` (pointer → `~/.weft/weft.config.json`) and, for Supabase, the creds file
`~/.weft/supabase.json` seeded by the installer (`-SupabaseUrl`/`-SupabaseKey` or
`WEFT_SUPABASE_URL`/`WEFT_SUPABASE_ANON_KEY` to use your own project;
see [`hosting.md`](./hosting.md#configuring-the-extensions-transport)). The extension has a
small number of *unrelated*, legitimate tuning env vars:

| Env var | Used by | Meaning |
|---|---|---|
| `WEFT_CHANNEL_ID` | extension | force a channel id (tests); otherwise random 128-bit |

## Docs index

- [`pairing.md`](./pairing.md) — the ECDH pairing handshake.
- [`security.md`](./security.md) — threat model & crypto.
- [`mode-switching.md`](./mode-switching.md) — runtime interactive/plan/autopilot switching.

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
- [Install and pair a source build](#run-the-real-extension-under-copilot-cli-the-real-test)
- [Deployments](#shipping-it-environments)
- [Custom Supabase](#wire-your-own-supabase-project)
- [Dev Tunnel lifecycle](#pairing-with-the-devtunnel-transport)

## Prerequisites

- Node.js 20 or newer.
- For the hosted web app and demo: a current browser.
- Only for building the native Android shell: Android Studio + Android SDK.
- The Copilot CLI extension uses `@github/copilot-sdk`, which the CLI provides at
  runtime — you do **not** install it to run the extension under `copilot`.

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
npm run build -w @aasis21/weft-extension   # -> extension/dist/extension.mjs

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

In the app choose **Try the demo**. It stands up a fake laptop side in-process
(real ECDH keypairs + `LocalTransport`), completes the real
`pair.hello`/`pair.challenge`/`pair.proof`/`pair.ack` handshake, then streams scripted
assistant/tool events, an approval card, heartbeats, and reflects mode changes — all
application payloads travel over AES-256-GCM.

## Run the real extension under Copilot CLI (the "real" test)

The source installer writes code into your personal Copilot extensions directory.
Review it before running it in a managed environment.

**1. Install the extension** (builds + copies the single bundled `extension.mjs` into
`~/.copilot/extensions/weft/`, where the CLI auto-discovers it — that directory holds
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
- **Android development shell:** Weft does not currently publish an APK. Debug,
  unversioned, and third-party APKs are not supported release artifacts.
- **Local dev server:** `cd mobile && npm run dev` serves the demo on your development
  computer. For a physical phone, use an HTTPS-served development deployment:
  an ordinary HTTP LAN address is not a secure context for camera and Web Crypto
  APIs. Manual paste is available on keyboard-and-mouse devices, not touch-only phones.

Developers who need to build the native shell from source can run `npx cap sync android`
and use Android Studio, but that build is not a distributed release APK.

**3. Pair and drive it.** Run `weft start` and leave the Device Station terminal open.
Open <https://useweft.netlify.app> on the phone, choose **Scan QR to pair**, and scan the
code. The phone can then start or resume Copilot sessions in registered projects.
For a source-built phone UI, use your HTTPS development deployment instead.

Keep the same browser identity when testing reconnection. If its storage has been
cleared, stop the station and follow
[phone replacement](https://aasis21.github.io/weft/#recovery). Do not reset pairing
as a substitute for diagnosing a relay problem.

To mirror one existing Copilot session, run `/weft` inside that session instead.
See [advanced usage](./advanced.md) for per-session transport overrides.

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

The check is read-only. The update verifies downloaded bundles against the published
release manifest, replaces installed code and the Weft skill, and preserves `~/.weft/`
configuration, registered projects, and persistent pairing material. Restart Copilot CLI
or Device Station after updating. PWA updates arrive through the browser; close and reopen
the installed PWA if a newly published version is not visible.

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

**Two-terminal flow** (after `weft set-transport devtunnel`):

```sh
# terminal 1 — bring up the shared relay (owns the devtunnel CLI, login, and lifecycle)
weft devtunnel start          # blocks with a live status line until healthy

# terminal 2 — pair as usual; /weft picks up the running relay
copilot                       # then run /weft inside the session
# or, standalone:
weft start
```

The shared relay is a child of the terminal that ran `weft devtunnel start` — keep that
terminal open for as long as you want the tunnel up; Ctrl+C (or closing it) stops the
relay and deletes the cloud tunnel. Every other session on the machine (any Copilot CLI,
`weft start`, etc.) discovers and reuses it via `~/.weft/devtunnel.json`. Running
`weft devtunnel start` from a second terminal attaches as a watcher — its Ctrl+C only
exits the watcher, it doesn't touch the running relay. Use `weft devtunnel status` to
check whether one's already up before opening a new owning terminal, and
`weft devtunnel stop` from anywhere to force it down.

If you run `/weft` with `transport = devtunnel` and no relay is running, pairing fails
fast with an actionable error pointing you at `weft devtunnel start`. This is deliberate
— it mirrors how the Supabase transport won't try to spin up Supabase for you either.

### Self-provisioning with `weft start`

`weft start` on the `devtunnel` transport is single-terminal: before it starts pairing it

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

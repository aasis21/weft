# Weft setup & developer guide

This is the v1 developer workflow. The whole vertical slice runs locally with **no
Supabase and no phone** via the in-process harness + the mobile Demo/Simulator; wiring
the real relay is the only user-gated step.

## Prerequisites

- Node.js ≥ 18 (developed on Node 24).
- For the mobile app on a device: Android Studio + SDK (a web/demo build needs neither).
- The Copilot CLI extension uses `@github/copilot-sdk`, which the CLI provides at
  runtime — you do **not** install it to run the extension under `copilot`.

## Install

```sh
cd weft
npm install          # resolves the npm workspaces: shared, extension, mobile
```

## Verify everything (no network, no phone)

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

## Run the mobile Demo/Simulator

```sh
cd mobile
npm run dev          # open the printed localhost URL
```

In the app choose **Demo / Simulator**. It stands up a fake laptop side in-process
(real ECDH keypairs + `LocalTransport`), completes the real `pair.hello`/`pair.ack`
handshake, then streams scripted assistant/tool events, an approval card, heartbeats,
and reflects mode changes — all over AES-256-GCM (no plaintext on the wire).

## Run the real extension under Copilot CLI (the "real" test)

> The HQ rule is to never write to `~/.copilot` from automation, so **you** run the
> installer; the agent only ships it.

**1. Install the extension** (builds + copies the single bundled `extension.mjs` into
`~/.copilot/extensions/weft/`, where the CLI auto-discovers it — that directory holds
installed **code only**):

```sh
./setup.ps1     # Windows
./setup.sh      # macOS/Linux
# remove later with ./uninstall.ps1 / ./uninstall.sh
```

Transport (Supabase vs. devtunnel) is configured via two small files in `~/.weft/`:
`weft.config.json` (the transport **pointer**, written by `weft set-transport`) and
`supabase.json` (the Supabase URL + anon key, seeded by the installer with the hosted
defaults and overwritten by `weft set-transport supabase --url <url> --anon-key <key>`).
They sit alongside `projects.json` and the devtunnel registry (see `weftHome()` in
`extension/src/projects.mjs`), and there is **no env var / `.env`** for either (see
`transportConfig.mjs` / `transportFactory.mjs`). Because they're separate, `weft
set-transport supabase` (no flags) just flips the pointer back after you've experimented
with devtunnel — your creds are still on disk from the last install, no re-typing. And
re-running `setup.ps1`/`setup.sh` (or the site installer) never silently resets or shadows
whatever you've already configured — the installers only re-seed `supabase.json` if it's
absent or you explicitly passed `-SupabaseUrl`/`-SupabaseKey` (or `-Force`), and
`setup.ps1`/`setup.sh` print a reminder to run `weft set-transport` if no pointer is
configured yet.

**2. Get the app on your phone** — pick one:

- **Hosted web app (easiest, zero install):** open **<https://useweft.netlify.app>**
  on your phone. On Android Chrome it scans the QR with your camera directly in the browser
  (via the `BarcodeDetector` API); on iOS Safari / Firefox it uses an on-page jsQR fallback,
  and if the camera is unavailable you can paste the JSON payload. Served over HTTPS with a
  `camera=(self)` permissions policy so scanning works.
- **Native APK (camera QR scan):** `cd mobile && npx cap sync android` then build/install
  via Android Studio (or `cd android && ./gradlew assembleDebug` and install the APK). The
  build takes no env config — the phone learns the transport, URL, and anon key from the QR
  it scans.
- **Local dev server:** `cd mobile && npm run dev -- --host`, open the printed LAN URL on
  your phone (same in-browser camera scan + paste fallback as the hosted app).

> The hosted site is a static deploy of `mobile/dist` on Netlify (site `useweft`,
> team `aasis21`). It points at the same public relay as everything else; the embedded
> publishable key is client-safe and the channel is guarded by RLS + end-to-end AES-256-GCM.
> Redeploy after a change with `npm run build -w @aasis21/weft-mobile` then a Netlify deploy
> of `mobile/dist` (or connect the repo — `netlify.toml` already has the build config).

**3. Pair and drive it.** Start `copilot` in any repo; Weft prints a pairing QR via
`session.log()` (run `/weft` to re-show it). Scan/paste it, then trigger a Copilot
action (e.g. a file write) and watch the stream — approve/deny and switch modes from the
phone. Everything on the relay is AES-256-GCM ciphertext.

On first pair the app asks for **notification permission**. Grant it so that, when you've
walked away and the app is backgrounded, the phone buzzes and raises a heads-up banner the
moment Copilot pauses for an approval (or the session goes quiet). Alerts carry only the
tool *name* — never arguments or stream content — and nothing is logged off-device. While
the app is in the foreground the on-screen approval card is used instead of a banner. (This
covers the phone-in-hand / app-recent case; full wake-from-killed delivery via FCM is a
planned follow-up.)

## Wire Supabase (Phase 2 — user-provided project)

1. Create a fresh Supabase project. Configure its MCP like `kirana360` does
   (`https://mcp.supabase.com/mcp?project_ref=<ref>` in `mcp/mcp-config.json`).
2. Enable **Realtime Authorization** and add RLS policies on `realtime.messages` so
   only authorized clients may join `private:weft:*` channels. This is stored as code:
   apply [`supabase/migrations/`](../supabase/migrations) to the project (via the Supabase
   MCP, the Supabase CLI `supabase db push`, or by pasting the SQL into the dashboard SQL
   editor). Channels are opened with `config.private = true`, so **joins are denied until
   this migration is applied** (see [`security.md`](./security.md) and
   [`supabase/README.md`](../supabase/README.md)).
3. Wire up the extension's transport (no env var, no `.env` — see
   [`hosting.md`](./hosting.md#configuring-the-extensions-transport)):
   ```sh
   weft set-transport supabase --url <your-project-url> --anon-key <your-anon-key>
   ```
   The mobile side needs no extra wiring — it reads the URL + anon key straight from
   whatever pairing QR the extension stamps (see [`hosting.md`](./hosting.md)).
4. The caller constructs a `@supabase/supabase-js` client, calls
   `client.realtime.setAuth(anonKey)` (the anon key is the Realtime access token that RLS
   authorizes), and passes it to `createSupabaseTransport({ client, channelId })` (the
   `shared/` package stays dependency-free by injecting the client). The extension does
   this automatically once `weft set-transport supabase` has been run.

> **Resolved (p4):** `SupabaseTransport` registers a single catch-all broadcast listener
> before `subscribe()` and dispatches internally, so subscriptions added after `connect()`
> still receive events. No subscribe-ordering constraint remains for cross-device use.

## Pairing with the `devtunnel` transport

The devtunnel transport is **operator-run** — the shared local relay + Microsoft Dev
Tunnel is your responsibility to bring up, in exactly the same sense that the Supabase
transport expects you to have already spun up a Supabase project. Pairing (`/weft`,
`weft start`) never spawns the tunnel for you; it just reads the shared registry
(`~/.weft/devtunnel.json`) and uses whatever's running.

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

If you run `/weft` (or `weft start`) with `transport = devtunnel` and no relay is
running, pairing fails fast with an actionable error pointing you at `weft devtunnel
start`. This is deliberate — it mirrors how the Supabase transport won't try to spin
up Supabase for you either.

## Configuration reference

Transport (Supabase vs. devtunnel) is **not** an env var — it's configured via `weft
set-transport` (pointer → `~/.weft/weft.config.json`) and, for Supabase, `weft
set-transport supabase --url <url> --anon-key <key>` (creds → `~/.weft/supabase.json`;
see [`hosting.md`](./hosting.md#configuring-the-extensions-transport)). The extension has a
small number of *unrelated*, legitimate tuning env vars:

| Env var | Used by | Meaning |
|---|---|---|
| `WEFT_APPROVAL_TIMEOUT_MS` | extension | approval wait before auto-deny (default 120000) |
| `WEFT_ELICITATION_TIMEOUT_MS` | extension | elicitation wait before auto-deny |
| `WEFT_CHANNEL_ID` | extension | force a channel id (tests); otherwise random 128-bit |

## Docs index

- [`pairing.md`](./pairing.md) — the ECDH pairing handshake.
- [`security.md`](./security.md) — threat model & crypto.
- [`mode-switching.md`](./mode-switching.md) — runtime interactive/plan/autopilot switching.

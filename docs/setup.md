# Helm setup & developer guide

This is the v1 developer workflow. The whole vertical slice runs locally with **no
Supabase and no phone** via the in-process harness + the mobile Demo/Simulator; wiring
the real relay is the only user-gated step.

## Prerequisites

- Node.js ≥ 18 (developed on Node 24).
- For the mobile app on a device: Android Studio + SDK (a web/demo build needs neither).
- The Copilot CLI extension uses `@github/copilot-sdk`, which the CLI provides at
  runtime — you do **not** install it to run the extension under `gh copilot`.

## Install

```sh
cd helm
npm install          # resolves the npm workspaces: shared, extension, mobile
```

## Verify everything (no network, no phone)

```sh
# 1. Shared contracts: crypto, pairing handshake, transport, message round-trips
npm test -w @aasis21/helm-shared

# 2. Extension relay end-to-end against a simulated phone (LocalTransport):
#    pairing → stream → approval round-trip → prompt → mode switch → session end
node extension/harness/harness.mjs --auto

# 3. Bundle the extension (esbuild; @github/copilot-sdk left external)
npm run build -w @aasis21/helm-extension   # -> extension/dist/extension.mjs

# 4. Build the mobile app (Vite production build)
npm run build -w @aasis21/helm-mobile
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
`~/.copilot/extensions/helm/`, where the CLI auto-discovers it, and copies a colocated
`.env` if present):

```sh
./setup.ps1     # Windows
./setup.sh      # macOS/Linux
# remove later with ./uninstall.ps1 / ./uninstall.sh
```

The extension auto-loads `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `HELM_TRANSPORT=supabase`
from a `.env` next to it (or inherit them from the shell that launches `gh copilot`; exported
shell vars win).

**2. Get the app on your phone** — pick one:

- **Native APK (camera QR scan):** `cd mobile && npx cap sync android` then build/install
  via Android Studio (or `cd android && ./gradlew assembleDebug` and install the APK). The
  build bakes in `VITE_HELM_TRANSPORT=supabase` + the relay creds from `mobile/.env.local`.
- **Browser (fastest, paste-to-pair):** `cd mobile && npm run dev -- --host`, open the
  printed LAN URL on your phone. Plain browsers can't use the camera scanner, so use the
  **"Manual QR JSON fallback"** box — the extension also prints the raw payload under the QR.

**3. Pair and drive it.** Start `gh copilot` in any repo; Helm prints a pairing QR via
`session.log()` (run `/helm-pair` to re-show it). Scan/paste it, then trigger a Copilot
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
   only authorized clients may join `private:helm:*` channels. This is stored as code:
   apply [`supabase/migrations/`](../supabase/migrations) to the project (via the Supabase
   MCP, the Supabase CLI `supabase db push`, or by pasting the SQL into the dashboard SQL
   editor). Channels are opened with `config.private = true`, so **joins are denied until
   this migration is applied** (see [`security.md`](./security.md) and
   [`supabase/README.md`](../supabase/README.md)).
3. Provide credentials via env (never commit secrets):
   - extension: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
   - mobile: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - `HELM_TRANSPORT=supabase`
4. The caller constructs a `@supabase/supabase-js` client, calls
   `client.realtime.setAuth(anonKey)` (the anon key is the Realtime access token that RLS
   authorizes), and passes it to `createSupabaseTransport({ client, channelId })` (the
   `shared/` package stays dependency-free by injecting the client). The extension does
   this from env automatically when `HELM_TRANSPORT=supabase`.

> **Resolved (p4):** `SupabaseTransport` registers a single catch-all broadcast listener
> before `subscribe()` and dispatches internally, so subscriptions added after `connect()`
> still receive events. No subscribe-ordering constraint remains for cross-device use.

## Configuration reference

| Env var | Used by | Meaning |
|---|---|---|
| `HELM_TRANSPORT` | extension | `local` (default) or `supabase` |
| `HELM_APPROVAL_TIMEOUT_MS` | extension | approval wait before auto-deny (default 120000) |
| `HELM_CHANNEL_ID` | extension | force a channel id (tests); otherwise random 128-bit |
| `SUPABASE_URL` / `SUPABASE_ANON_KEY` | extension | relay credentials |
| `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` | mobile | relay credentials |

## Docs index

- [`pairing.md`](./pairing.md) — the ECDH pairing handshake.
- [`security.md`](./security.md) — threat model & crypto.
- [`mode-switching.md`](./mode-switching.md) — runtime interactive/plan/autopilot switching.

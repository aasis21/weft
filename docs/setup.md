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

## Run the real extension under Copilot CLI (manual, local)

> The HQ rule is to never write to `~/.copilot` from automation. Do this step yourself.

1. Build: `npm run build -w @aasis21/helm-extension`.
2. Copy `extension/dist/` into `~/.copilot/extensions/helm/` (the CLI auto-discovers
   extensions there).
3. Start `gh copilot`; the extension renders a pairing QR via `session.log()` (never
   stdout). Scan it from the mobile app.

Until the Supabase transport is wired (below), set `HELM_TRANSPORT=local` only makes
sense for same-machine tests; cross-device pairing needs the relay.

## Wire Supabase (Phase 2 — user-provided project)

1. Create a fresh Supabase project. Configure its MCP like `kirana360` does
   (`https://mcp.supabase.com/mcp?project_ref=<ref>` in `mcp/mcp-config.json`).
2. Enable **Realtime Authorization** and add RLS policies on `realtime.messages` so
   only authorized clients may join `private:helm:*` channels (see
   [`security.md`](./security.md)).
3. Provide credentials via env (never commit secrets):
   - extension: `SUPABASE_URL`, `SUPABASE_ANON_KEY`
   - mobile: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
   - `HELM_TRANSPORT=supabase`
4. The caller constructs a `@supabase/supabase-js` client and passes it to
   `createSupabaseTransport({ client, channelId })` (the `shared/` package stays
   dependency-free by injecting the client).

> **Known follow-up:** on the real Broadcast transport, subscriptions registered after
> `connect()` may not receive events. `attachRelay` registers `SecureChannel` handlers
> post-connect, so `SupabaseTransport` needs to be made subscribe-order-independent
> (single broadcast listener + internal dispatch) before cross-device use. Tracked in
> `plan.md` and `pairing.md`.

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

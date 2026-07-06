# Supabase provisioning (Weft relay)

Weft's relay is **Supabase Realtime Broadcast with zero database persistence**. There are
no application tables in v1 — the only setup is authorizing the private broadcast channels
the clients join (`private:weft:<channelId>`).

## What's here

- `migrations/` — timestamped SQL (`YYYYMMDDHHmmss_*.sql`), Supabase-CLI compatible.
  - `*_weft_realtime_broadcast_rls.sql` — RLS on `realtime.messages` authorizing
    `private:weft:*` broadcast for the `anon` / `authenticated` roles. **Apply this before
    using `WEFT_TRANSPORT=supabase`** — private channels are denied by default.
- `project.json` — `{ "project_id": "<ref>" }`. The ref of the live Supabase project.

## Live project (operator instance)

The reference public instance is provisioned and the migration applied + verified:

| | |
|---|---|
| Project | `helm` (org **Anvia**; backend project name intentionally retained for now) |
| Ref | `jqzohxjouzxzawqqlifv` (in `project.json`) |
| URL | `https://jqzohxjouzxzawqqlifv.supabase.co` |
| Region | `us-west-1` |
| Postgres | 17 |
| Auth | publishable/anon key (public by design); set via env, never committed |

Credentials live in a gitignored `.env` (extension: `WEFT_SUPABASE_URL` / `WEFT_SUPABASE_ANON_KEY`)
and `mobile/.env.local` (`VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY`). The publishable
key is safe to embed in clients; confidentiality rests on E2E encryption + channelId entropy
(see the security note below). Self-hosters point these at their own project instead.

**Verified live (2026-06):** a private `private:weft:*` channel subscribes and round-trips a
broadcast; a true two-client send→receive works with production `self:false`; a
`private:notweft:*` topic is denied by RLS; the security advisor reports no lints.

## Apply it

Pick one:

**A. Supabase MCP (HQ wiring).** With the Supabase MCP loaded (see
`cortex/mcp/mcp-config.json`), ask the agent to apply `supabase/migrations` to your project.
This is how the live instance above was provisioned (`create_project` → `apply_migration`).

**B. Supabase CLI.**
```sh
supabase link --project-ref <ref>
supabase db push
```

**C. Dashboard.** Paste the migration into the SQL Editor and run it.

## Security note

Applying these policies is a **hardening** step, not a confidentiality requirement: the
relay only ever sees end-to-end AES-256-GCM ciphertext, and the 128-bit channelId is
unguessable. RLS adds an access gate so random anon clients can't enumerate or join
arbitrary weft topics. In v2 (per-user identity) replace the topic-prefix check with an
ownership check. See [`../docs/security.md`](../docs/security.md) and
[`../docs/hosting.md`](../docs/hosting.md).

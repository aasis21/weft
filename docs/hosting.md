# Hosting & self-hosting

Weft's relay is a Supabase Realtime Broadcast channel. The **code** is open source
(Apache-2.0); operating a **relay** is a separate concern. This page covers both the
public instance and self-hosting.

## Two separate things

- **The code license** (Apache-2.0) governs the source: anyone may use, modify, and
  redistribute it. It does **not** grant access to any particular hosted relay.
- **A relay instance** is a Supabase project that someone operates. Access to *that*
  instance is governed by its keys, RLS policies, rate limits, and acceptable-use terms
  — not by the code license.

So you can fork Weft and run your own relay freely, but using *someone else's* relay
requires *their* permission. Open code ≠ a seat on someone's infrastructure bill.

## Option A — use a public instance (if offered)

If a public Weft relay is advertised, the mobile app ships pointing at it. There is no
account — pairing is by QR. The operator may rate-limit or revoke abusive clients. The
relay only ever carries ciphertext (see [`security.md`](./security.md)); the operator
cannot read your session. Use is subject to [`../TERMS.md`](../TERMS.md).

## Option B — self-host (recommended for privacy / control)

You only need a free Supabase project.

1. Create a Supabase project.
2. Enable Realtime; add RLS policies on `realtime.messages` that gate `private:weft:*`
   broadcast channels (see [`setup.md`](./setup.md)).
3. Set rate limits / quotas appropriate to your usage.
4. Point the clients at your project:
   - extension: `weft set-transport supabase --url <your-url> --anon-key <your-anon-key>`
   - mobile: `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`

Because every payload is end-to-end encrypted, the relay (yours or anyone's) is
untrusted infrastructure: it routes ciphertext and learns only timing and channel ids.

## Configuring the extension's transport

Unlike the mobile build (which bakes `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` in at
build time), the Copilot CLI extension has **no env var / `.env`** for this at all — it is
configured once via `weft set-transport supabase --url <url> --anon-key <key>` (or `weft
set-transport devtunnel`), persisted to `~/.weft/weft.config.json`, and read from nowhere
else. This means reinstalling/rebuilding the extension can never silently reset or shadow
your chosen transport — only `weft set-transport` (or the installer, on first run / when
you explicitly pass `-Transport`) ever writes it.

> **Devtunnel transport is operator-run** — pairing (`/weft`, `weft start`) never spawns
> the relay itself, exactly the way it never spins up a Supabase project for you. Bring the
> shared relay up first with `weft devtunnel start` (which owns the `devtunnel` CLI, login,
> and lifecycle), then run `/weft`. If it isn't running, pairing fails fast with an error
> pointing at that command. See [`setup.md`](./setup.md#pairing-with-the-devtunnel-transport).

## Operating a public instance

If you run a relay for others, protect it operationally — none of this is the code
license's job:

- **RLS** on `realtime.messages` so a client can only touch `private:weft:<channelId>`.
- **Rate limits / quotas** to cap abuse of your Supabase bill.
- **Acceptable-use terms** ([`../TERMS.md`](../TERMS.md)) and the right to revoke.
- Keep real project keys out of the repo — the `anon` key is public-by-design; RLS is
  the real guard. `.env*` is gitignored.

# Advanced use

[Documentation handbook](https://aasis21.github.io/weft/#sessions) ·
[Command reference](https://aasis21.github.io/weft/#commands)

The default onboarding path is intentionally short:

1. Install Weft on the laptop.
2. Run `weft start`.
3. Scan the QR with the hosted web app.

The options below are for narrower session mirroring, alternate transports, pairing
lifetime, and multi-project setup.

## Mirror only the current session with `/weft`

Run `/weft` inside an active Copilot CLI session to pair the phone directly to that
session. This pairing uses a fresh channel and key and ends with the session. Use
`/weft supabase` or `/weft devtunnel` only when you need a per-session transport override.

For normal use, prefer `weft start`: one Device Station can reconnect a phone and launch
or resume sessions across registered projects.

## Pairing lifetime

Pairing modes apply to `weft start`; `/weft` is always per-session.

| Mode | Behavior | Command |
|---|---|---|
| Persistent (default) | Reuse the Device Station identity so an already-paired phone reconnects after restart. | `weft set-pairing persistent` |
| Ephemeral | Create a fresh channel and key on every start; scan again each time. | `weft set-pairing ephemeral` |

For a different phone, a new browser profile, or cleared phone storage, stop the
running station and use `weft start --new-device`. It replaces the previously trusted
phone identity and starts with a fresh QR; the old phone pairing can no longer reconnect.
It does not recover phone-local transcripts.

Run `weft rotate-pairing` to invalidate a persistent identity after a phone or QR may
have been exposed, then start the station again. Stop the old station first so it
cannot continue using its in-memory identity. `weft start --new-device` combines
rotation and startup.

## Transports

Both transports carry end-to-end encrypted envelopes. The relay stores no session content
and cannot decrypt payloads, although infrastructure can observe connection metadata such
as timing, sizes, IP addresses, and channel identifiers.

| Transport | When to use it | Command |
|---|---|---|
| Hosted Supabase relay (default) | Fastest setup; no relay account or key entry. | `weft set-transport supabase` |
| Visual Studio Dev Tunnel | You want to operate the relay under your own account. | `weft set-transport devtunnel` |

With the dev-tunnel transport, `weft start` can provision and manage the relay for its own
lifetime. To keep a shared relay running across station restarts, or to use `/weft`, run
`weft devtunnel start` in a separate terminal.

For a self-hosted Supabase project, RLS, and operator guidance, see
[`hosting.md`](hosting.md).

## Commands

| Command | What it does |
|---|---|
| `weft start` | Start the Device Station and print a pairing QR. |
| `weft start --new-device` | Replace the previously trusted phone identity and start with a fresh QR. |
| `weft start --help` | Show station options without starting it. |
| `weft add-project <name> <path> [--default]` | Register a project directory. |
| `weft remove-project <name>` | Remove a registered project. |
| `weft list-projects` | List projects and the default. |
| `weft set-default <name>` | Select the project used by a bare launch. |
| `weft set-name <name>` | Set this laptop's display name. |
| `weft show-name` | Show the effective device name and source. |
| `weft show-transport` | Show the effective transport and source. |
| `weft set-transport <supabase\|devtunnel>` | Select the transport for subsequent starts. |
| `weft set-transport clear` | Remove the explicit transport selection. |
| `weft set-pairing <persistent\|ephemeral>` | Choose the Device Station pairing lifetime. |
| `weft rotate-pairing` | Replace a persistent pairing identity and invalidate the old QR. |
| `weft update --check` | Check for a newer hosted release. |
| `weft version` | Show the installed version. |
| `weft update` | Verify and install the current hosted release without deleting local data. |
| `weft install [--from <dir>] [--skill <file>]` | Install local code bundles, optionally with a specified source and skill. |
| `weft clean-install [--yes]` | **Destructive:** delete installed code and `~/.weft/` data, then reinstall. `--yes` skips confirmation. Prefer update or pairing recovery. |
| `weft devtunnel <start\|status\|stop>` | Operate the shared dev-tunnel relay. |
| `weft help` | Show CLI usage. |

---
name: weft-how-to-use
description: Pair a phone to a running GitHub Copilot CLI session with Weft — show/refresh the QR code, pick a transport (Supabase realtime or a self-hosted Microsoft Dev Tunnel), manage the shared devtunnel relay, and run/manage the standalone `weft` Device Station CLI outside of any Copilot session. Use when the user asks to "pair my phone", "show the Weft QR", "switch Weft transport", "start/check/stop the weft devtunnel", "run weft standalone", or asks why `/weft` or `weft` isn't working.
---

# Weft — pair your phone to a Copilot CLI session

Weft lets a phone (the Weft mobile web app or APK) observe and approve a running
Copilot CLI session in real time: tool-call notifications, approval prompts, and a live
transcript. It ships as a Copilot CLI **extension** (`/weft` inside a session) plus a
standalone **`weft` CLI** (works with no Copilot session at all — e.g. to run a Device
Station on a headless box, or to manage the relay independently).

## Inside a Copilot CLI session — `/weft`

- `/weft` — show the pairing QR + status for the current session. If no transport is
  configured yet, this also prompts you to pick one.
- `/weft <name>` — override the transport for just this session without touching the
  saved config. Valid names: `supabase`, `devtunnel`, `clear`.
- Weft auto-loads at session start and prints one status line; nothing else happens
  until you run `/weft`.

## Standalone `weft` CLI (no Copilot session needed)

Installed alongside the extension as a `weft`/`weft.cmd` shim on PATH (open a **new**
terminal after install for PATH changes to take effect). Full command list:

```
weft start
weft add-project <name> <path> [--default]
weft remove-project <name>
weft list-projects
weft set-default <name>
weft set-transport <supabase|devtunnel|clear> [--url <url>] [--anon-key <key>]
weft show-transport
weft set-name <name>
weft show-name
weft set-pairing <persistent|ephemeral>
weft rotate-pairing
weft devtunnel <start|status|stop>
weft help
```

- **`weft start`** — runs a standalone "Device Station": pairs a phone the same way
  `/weft` does, but without needing an active Copilot CLI session (useful for headless
  boxes or testing transport setup independently).
- **`weft add-project` / `remove-project` / `list-projects` / `set-default`** — manage
  named project shortcuts the mobile app can launch a session into.
- **`weft set-transport` / `show-transport`** — the ONLY way transport is configured.
  There is **no env var, no `.env` file** — config lives in two small files in `~/.weft/`:
  `weft.config.json` (the transport **pointer**, one line: which kind you chose) and, for
  Supabase, `supabase.json` (the URL + anon key). Reinstalling or rebuilding the extension
  never touches either file, so a chosen transport always survives an update. Passing no
  flags to `set-transport devtunnel` is valid (devtunnel needs no URL/key). For Supabase,
  `--url` and `--anon-key` are **optional together**: `weft set-transport supabase` (no
  flags) just flips the pointer and reuses whatever creds are already in `supabase.json`
  (the installer seeds the hosted defaults there on install); `weft set-transport supabase
  --url <url> --anon-key <key>` overwrites `supabase.json` and then flips the pointer.
- **`weft set-pairing persistent`** — reuse the same channel + key across every
  `weft start` / `/weft`, so an already-paired phone reconnects without rescanning the
  QR. Default is `ephemeral` (a fresh channel + key every run, forward-secret).
  `weft rotate-pairing` forces a new identity on demand.
- **`weft set-name` / `show-name`** — set (or check) the display name this machine
  shows to the phone in its DEVICES list. Defaults to the OS hostname until you set one;
  the installer (install.ps1/install.sh) also prompts for this interactively at install
  time, defaulting to the hostname (press Enter to keep it). Persisted alongside the
  transport in `~/.weft/weft.config.json` — reinstalling/rebuilding never resets it.
  Restart `weft start` / `/weft` for a changed name to reach an already-open session.
- **`weft devtunnel start`** — the ONLY command that provisions the shared Microsoft Dev
  Tunnel relay. Foreground: shells out to the `devtunnel` CLI, auto-runs `devtunnel user
  login -g` if needed, spawns the relay+tunnel as a child of this terminal, and blocks
  with a live status line until it's healthy — then keeps blocking. **This terminal owns
  the relay's lifetime**: keep it open for as long as you want the tunnel up; Ctrl+C (or
  closing the terminal) stops the relay and deletes the cloud tunnel. If a healthy relay
  is already running (from another terminal), this one attaches as a watcher and exits
  its watcher on Ctrl+C without disturbing the relay. **Run this before `/weft` /
  `weft start` when the transport is `devtunnel`** — pairing itself never spawns the
  relay (see Picking a transport below).
- **`weft devtunnel status`** — one-shot check: prints whether the shared relay is
  running, its pid, and its public URL, or "not running". **Always check status before
  assuming you need to start** — devtunnel provisioning is shared across sessions on a
  machine, so if any terminal is already running `weft devtunnel start` it's already up.
- **`weft devtunnel stop`** — force-tears-down the shared relay from anywhere (kills the
  child process tree, deletes the cloud tunnel, clears the registry). Use it when you
  want to stop the tunnel without switching back to the owning terminal.

## Picking a transport

| Transport | Setup | Best for |
|---|---|---|
| `supabase` | Installer seeds `~/.weft/supabase.json` with the hosted defaults. Point at your own project with `weft set-transport supabase --url <url> --anon-key <key>`, or just `weft set-transport supabase` (no flags) if the creds file is already there. | No local process to manage; works from anywhere |
| `devtunnel` | `weft set-transport devtunnel` (no flags), **then** `weft devtunnel start` in a separate terminal before pairing. That terminal owns the relay — keep it open; every `/weft` / `weft start` elsewhere on the machine reuses it until you Ctrl+C or close it. | Self-hosted / no third-party account needed, but requires the `devtunnel` CLI installed and a Microsoft account |

Pairing (`/weft`, `weft start`) is symmetric across both transports: it just *uses* the
"server" — Supabase for `supabase`, the local relay + tunnel for `devtunnel` — and never
tries to spin it up for you. If the devtunnel relay isn't running when you pair, you get
an actionable error pointing at `weft devtunnel start` (see Troubleshooting).

Microsoft Dev Tunnels caps accounts at 10 tunnels, which is why Weft provisions **one
shared relay** (not one per session) and reuses it — that's also why `devtunnel
status`/`stop` exist as independent commands, separate from any single Copilot session.

## Troubleshooting

- **"Weft: no transport configured"** — no pointer in `~/.weft/weft.config.json` yet. Run
  `weft set-transport supabase` (reuses installer-seeded creds) or `weft set-transport
  devtunnel`, then retry `/weft` or `weft start`.
- **"Weft: supabase credentials file not found at ~/.weft/supabase.json"** — pointer says
  supabase but the creds file isn't there. Run `weft set-transport supabase --url <url>
  --anon-key <key>` to write it, or re-run the installer to seed the hosted defaults.
- **"Weft: no devtunnel relay is running on this machine"** (with transport =
  `devtunnel`) → pairing never spawns the relay itself. Run `weft devtunnel start` in
  another terminal (blocks until healthy), then retry `/weft` (in-session, run `/weft
  devtunnel` to force a re-resolve) or `weft start`. Use `weft devtunnel status` first to
  confirm whether one is already up (a single relay is shared across all sessions).
- **devtunnel seems stuck / taking a long time on `weft devtunnel start`** → run `weft
  devtunnel status` in another terminal; if it reports "not running" after a couple
  minutes, `weft devtunnel stop` then retry.
- **After a fresh install/reinstall, previous transport choice is gone** → shouldn't
  happen (config is untouched by install/reinstall); run `weft show-transport` to
  confirm, and check `~/.weft/weft.config.json` exists.
- **`weft` command not found after install** → open a **new** terminal (PATH is updated
  per-user but existing shells don't pick it up).

---
name: weft-how-to-use
description: Pair a phone to GitHub Copilot CLI or local Copilot app sessions with Weft. Show/refresh a terminal QR or app canvas, manage Supabase or Dev Tunnel transport, and run the standalone Device Station. Use for "pair my phone", "open Weft pairing", "show the Weft QR", "switch Weft transport", "run weft standalone", or troubleshooting `/weft` and `weft`.
---

# Weft — pair your phone to Copilot

Weft lets the phone PWA follow and control GitHub Copilot CLI or local Copilot app
sessions: prompts, tool activity, approvals, and a live transcript. It ships as a
session **extension** (`/weft`) plus a standalone **`weft` CLI** for Device Station
and relay management. Station launches new sessions through an installed CLI.

## Inside a Copilot CLI session — `/weft`

- `/weft` — show the pairing QR + status for the current session. If no transport is
  configured yet, this also prompts you to pick one.
- `/weft <name>` — override the transport for just this session without touching the
  saved config. Valid names: `supabase`, `devtunnel`, `clear`.
- Weft auto-loads silently at session start. Pairing and transport work start only
  when you run `/weft`, open pairing, or connect through Device Station.

## Inside the GitHub Copilot app

Run **`/weft`** to open or focus the Weft canvas, or ask to **open Weft pairing**.
Call the extension's `weft_pair` tool when available;
it opens the `weft-pairing` canvas on hosts that support canvases and falls back to
the terminal QR on CLI-only hosts. Never copy pairing credentials into generated
files, diagnostic logs, or an agent response. The panel renders the graphical QR
and copy-code fallback directly.

For a phone already paired to Device Station, use Resume and select the correct
laptop/folder. Verified live sessions offer Connect and activate the existing
runtime without starting another CLI. Resume refreshes on reconnect and foreground
return. These paths support local app sessions, not remote or cloud discovery.

## Standalone `weft` CLI (no Copilot session needed)

Installed alongside the extension as a `weft`/`weft.cmd` shim on PATH (open a **new**
terminal after install for PATH changes to take effect). Full command list:

```
weft start [--new-device] [--foreground]
weft status
weft stop
weft ui [status|stop|shortcut]
weft add-project <name> <path> [--default]
weft remove-project <name>
weft list-projects
weft set-default <name>
weft set-transport <supabase|devtunnel|clear> [--url <url>] [--anon-key <key>]
weft show-transport
weft set-name <name>
weft show-name
weft set-permission <default|allow-all>
weft show-permission
weft set-pairing <persistent|ephemeral>
weft rotate-pairing
weft devtunnel <start|status|stop>
weft help
```

## Laptop Control Center and background operation

`weft ui` opens a private local browser dashboard for projects, settings, pairing,
session status/activation, Station-mediated session launch, and Station/relay
start/stop/restart. CLI and UI share management functions. Opening the dashboard
does not start Station or activate sessions; closing it does not stop workloads.
`weft ui status` and `weft ui stop` manage only the on-demand UI host.
Windows installation adds a branded Start menu shortcut; `weft ui shortcut`
adds a desktop shortcut.

On Windows, `weft start` and `weft devtunnel start` use manually started per-user
background tasks. Their launch terminal can close. Crashes restart automatically;
`weft stop` disables Station restart but leaves the shared relay available;
`weft devtunnel stop` disables relay restart and stops the shared relay.
No boot/sign-in startup is registered. Use `--foreground` for terminal-owned
operation, which remains the default outside Windows.

The dashboard reports unknown connectivity when no recent authenticated peer
traffic proves contact. Foreground-owned workloads stay under their terminal's
control. Browser startup never waits on hidden sign-in prompts; if required, run
`devtunnel user login -g` in a terminal and retry. Destructive/access-changing UI
actions require confirmation. Code updates and clean-install remain CLI-only.

- **`weft start`** — runs a standalone "Device Station": pairs a phone the same way
  `/weft` does, but without needing an active Copilot CLI session (useful for headless
  boxes or testing transport setup independently). On the `devtunnel` transport it is
  self-contained — see "Self-provisioning" below.
- **`weft start --new-device`** — forgets the previously trusted phone, rotates the
  persistent pairing identity, and starts immediately with a fresh QR. Use it for a
  different phone, after reinstalling/refreshing the phone app or clearing its storage,
  or when a valid QR repeatedly reports that the laptop did not acknowledge it.
- **Shared terminal access** is enabled by default on supported Windows laptops.
  To disable it, set `"terminal": {"enabled": false}` in `~/.weft/weft.config.json`,
  preserving other settings, then restart Station. This is direct local-account
  shell access, not a Copilot tool approval. No startup flag is required.
- **`weft add-project` / `remove-project` / `list-projects` / `set-default`** — manage
  named project shortcuts the mobile app can launch a session into.
- **`weft set-transport` / `show-transport`** — configure transport from the CLI;
  Control Center Settings writes the same central configuration.
  There is **no env var, no `.env` file** — config lives in two small files in `~/.weft/`:
  `weft.config.json` (the transport **pointer**, one line: which kind you chose) and, for
  Supabase, `supabase.json` (the URL + anon key). Reinstalling or rebuilding the extension
  never touches either file, so a chosen transport always survives an update. Passing no
  flags to `set-transport devtunnel` is valid (devtunnel needs no URL/key). For Supabase,
  `--url` and `--anon-key` are **optional together**: `weft set-transport supabase` (no
  flags) just flips the pointer and reuses whatever creds are already in `supabase.json`
  (the installer seeds the hosted defaults there on install); `weft set-transport supabase
  --url <url> --anon-key <key>` overwrites `supabase.json` and then flips the pointer.
- **`weft set-pairing persistent`** — reuse the same channel + device identity across every
  `weft start`, so an already-paired phone reconnects without rescanning the QR. This is
  the default. Use `weft set-pairing ephemeral` for a fresh channel + key on every station
  run. `weft rotate-pairing` forces a new persistent identity on demand. The in-session
  `/weft` command always uses a fresh per-session identity.
- **`weft set-name` / `show-name`** — set (or check) the display name this machine
  shows to the phone in its DEVICES list. Defaults to the OS hostname until you set one;
  the installer (install.ps1/install.sh) also prompts for this interactively at install
  time, defaulting to the hostname (press Enter to keep it). Persisted alongside the
  transport in `~/.weft/weft.config.json` — reinstalling/rebuilding never resets it.
  Restart `weft start` / `/weft` for a changed name to reach an already-open session.
- **`weft set-permission` / `show-permission`** — choose the permission mode preselected
  when the phone opens Start or Resume for this laptop. `default` keeps normal Copilot
  confirmations; `allow-all` passes `--allow-all`. This is only the initial selection:
  the phone can override it for one launch. Existing installations safely default to
  `default`.
- **`weft devtunnel start`** — explicitly starts or reuses the shared relay before
  direct `/weft` pairing. Windows returns after authenticated background readiness;
  `--foreground` keeps terminal-owned operation. `weft start` can also arrange the
  relay for Station. Persistent pairing retains the cloud tunnel for endpoint reuse;
  ordinary reconnects need no new QR. A genuinely changed endpoint needs a refresh scan.
- **`weft devtunnel status`** — one-shot check: prints whether the shared relay is
  running, its pid, and its public URL, or "not running". **Always check status before
  assuming you need to start** — devtunnel provisioning is shared across sessions on a
  machine, so if any terminal is already running `weft devtunnel start` it's already up.
- **`weft devtunnel stop`** — disables background relay restart and stops the shared
  relay. Persistent mode preserves its cloud tunnel and endpoint record; ephemeral
  mode removes them. This disconnects dependent links, not native Copilot sessions.

## Shared terminal

The shared terminal backend requires Windows 10 build 18309 or newer (including
Windows 11) and an interactive desktop. Do not advertise this capability on macOS
or Linux merely because native runtime assets are packaged for those systems.

With Station running, choose **Open terminal** on the phone's device page. Station
creates one shell and a visible local attach window, or reconnects to the existing
terminal. A registered workspace is the initial directory, not a sandbox.

Tap **Keyboard** to type at the real prompt, with visible special keys and shell
history via Up/Down. **Write / paste** opens an optional draft editor; clipboard
paste into the terminal also goes there for review, never automatic execution.
While the phone owns input, the shared grid fits its available display, including
keyboard changes. **Details** contains the starting directory and **Reattach**.
Leaving the terminal page does not end the shell. Confirmed **Close
terminal**, closing the owned laptop window, or stopping Station ends it. Reconnect
restores bounded screen state; never automatically repeat an uncertain command.

Terminal input/output are not diagnostic event-log content. The shell's own history
and programs can still persist data. If native support is missing, use `weft update`
with the current CLI to install the complete runtime, then restart Station. Do not
copy only `weft.mjs`, ask users to compile native dependencies, or claim that merely
updating the source checkout updates the installed CLI.

`weft terminal attach` is Station's internal laptop frontend. It attaches through
authenticated local IPC; it is not a way to take over arbitrary existing terminals.
See [terminal operation and boundaries](https://aasis21.github.io/weft/#open-terminal).

## Picking a transport

| Transport | Setup | Best for |
|---|---|---|
| `supabase` | Installer seeds `~/.weft/supabase.json` with the hosted defaults. Point at your own project with `weft set-transport supabase --url <url> --anon-key <key>`, or just `weft set-transport supabase` (no flags) if the creds file is already there. | No local process to manage; works from anywhere |
| `devtunnel` | `weft set-transport devtunnel` (no flags). Station can arrange the relay; direct `/weft` requires `weft devtunnel start` first. Windows background operation survives closing the launch terminal; `--foreground` remains terminal-owned. | Self-hosted; requires the `devtunnel` CLI and a Microsoft or GitHub account |

Pairing is *mostly* symmetric across both transports: it just *uses* the "server" —
Supabase for `supabase`, the local relay + tunnel for `devtunnel`. `/weft` never tries to
spin the relay up for you; if it isn't running you get an actionable error pointing at
`weft devtunnel start` (see Troubleshooting).

### Self-provisioning (`weft start` on the `devtunnel` transport)

On Windows, `weft start` checks setup before starting supervised background workers:

1. **reuse** an already-healthy relay from `~/.weft/devtunnel.json`, otherwise
2. **check the `devtunnel` CLI and sign in** — including the sneaky case where
   `devtunnel user show` exits 0 but prints "Login token expired." It runs
   `devtunnel user login -g` (GitHub device-code flow) and re-verifies before continuing,
3. **clear a stale registry entry** (a record pointing at a relay that's gone) and
   provision a fresh relay — if a remembered tunnel can't be hosted by the current
   identity, it falls back to creating a brand-new one (URL changes → re-scan the QR),
4. **recover quietly** using local/public health checks and bounded retries, preferring
   the saved tunnel/port; endpoint changes require an explicit refreshed QR, and
5. **keep ownership separate** — stopping background Station leaves the shared relay
   available. Use `weft devtunnel stop` to stop that workload deliberately.

With persistent pairing on, teardown keeps the cloud tunnel, so the next start comes back
on the same URL and already-paired phones reconnect without re-scanning.

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
  `devtunnel`) → `/weft` never spawns the relay itself. Run `weft devtunnel start` in
  another terminal (blocks until healthy), then retry `/weft` (in-session, run `/weft
  devtunnel` to force a re-resolve). Use `weft devtunnel status` first to confirm whether
  one is already up (a single relay is shared across all sessions). `weft start` doesn't
  hit this — it provisions the relay itself.
- **"the devtunnel relay failed to start"** on `weft start` → the relay child exited
  early. Check the message beneath it; common causes are the `devtunnel` CLI not being
  installed, or a sign-in that didn't take. Run `devtunnel user show` — if it says
  "Login token expired." (even though it exits 0), run `devtunnel user login -g`, then
  retry.
- **devtunnel seems stuck / taking a long time on `weft devtunnel start`** → run `weft
  devtunnel status` in another terminal; if it reports "not running" after a couple
  minutes, `weft devtunnel stop` then retry.
- **After a fresh install/reinstall, previous transport choice is gone** → shouldn't
  happen (config is untouched by install/reinstall); run `weft show-transport` to
  confirm, and check `~/.weft/weft.config.json` exists.
- **`weft` command not found after install** → open a **new** terminal (PATH is updated
  per-user but existing shells don't pick it up).
- **A valid QR says the laptop could not be reached** → check Station/relay status.
  Only foreground mode requires its launch terminal to stay open.
  If the phone was refreshed/reinstalled, its cryptographic identity changed while
  persistent pairing still trusts the prior one. Stop the station and run
  `weft start --new-device`, then scan the new QR.
- **`/weft` seems to hang while the agent is working** → it isn't hung, it's queued. Unlike
  built-in TUI commands such as `/tasks` or `/session`, `/weft` is an *extension* command:
  the runtime round-trips it to the extension subprocess and serializes that dispatch behind
  the turn in flight, so the QR only appears once the agent goes idle. There is no bypass
  flag in the SDK. If you need to pair right now, don't wait — run `weft start` in a second
  terminal. The standalone Device Station pairs the same phone over the same transport
  without touching the busy session, and the phone can adopt the Copilot session afterwards.

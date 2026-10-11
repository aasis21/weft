# Advanced use

[Documentation handbook](https://aasis21.github.io/weft/#sessions) ·
[Projects](https://aasis21.github.io/weft/#projects) ·
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
or resume sessions across registered projects. These are separate connection scopes:
the device log shows Device Station traffic, while each session has its own log.
See [diagnostic scope and retention](https://aasis21.github.io/weft/#diagnostics).

## Use Weft in the GitHub Copilot app

Local Copilot app sessions use the same Weft extension and encrypted connection as CLI
sessions. Run **`/weft`** or ask Copilot to **open Weft pairing**: both open a side-panel
canvas with a graphical QR, a copy-code fallback, and live connection status. The canvas
is loaded only when requested. Closing it does not disconnect the phone; reopening it
does not replace an already-connected phone. **New pairing code** requires confirmation
before replacing that connection.

CLI users can continue to use `/weft`. Hosts without canvas support fall back to the
terminal QR. Repeated `/weft` focuses an existing Weft panel, including one opened
manually. On app versions that do not dispatch extension slash commands, ask Copilot
to open Weft pairing instead.
The panel identifies the current session, workspace, branch, selected model,
interaction mode, activity, laptop, and connected phone. Live metadata refreshes
while it is open; unavailable fields are marked explicitly rather than guessed.
These details are displayed only in the local panel, not added to relay diagnostics.
The panel tab is **Weft | Phone companion**, with a single introductory line:
**Weft lets you follow and control your Copilot session from your phone.**
The conversation name is shown as Session in the details, not used as the
product title. Session ID and Started remain directly visible.
Session details use compact label/value rows, with two columns where there is room
and a single column on narrow panels. Long paths and IDs wrap without hiding fields.
For Dev Tunnel, start the shared relay with `weft devtunnel start` first; the panel
reports setup errors and lets you retry with a different per-session transport without
changing the saved laptop configuration.

With Device Station running, the phone's **Resume** screen also lists local app
sessions. It refreshes when the device reconnects, when Resume is reopened, and when
the phone app returns to the foreground. A verified running session offers **Connect**,
which activates the existing runtime; stopped or older sessions retain **Resume**.
Select the correct device and folder, or use **All folders** and **Refresh** if needed.
This does not add support for discovering cloud or remote-host app sessions on the
local laptop.

## Register and maintain projects

The session menu's **Files** has two independent trees. **Current folder** expands
the session workspace one level at a time, fetching names only. **Agent-touched files**
groups files successfully read or written in this session, including exact permitted
paths outside the workspace. Its folders are virtual groupings, not permission to
browse external directories. Tapping a file in either tree or a Markdown file link fetches a
revision-labelled preview. Markdown, text/source, and self-contained HTML are supported;
HTML scripts, forms, and external assets are disabled. **Refresh** captures the latest
version; loaded content remains visible offline, but fetching more requires reconnection.
Changes compares session-touched workspace files against a pinned HEAD commit;
untracked files appear as New. No staging, reverting, or file editing is provided.

Workspace reads use Copilot's native approval pipeline, allowed-directory policy,
and content-exclusion checks. Older hosts without those checks do not advertise this
feature. A prior read/write is not permanent permission. Denied names and contents
are not sent. Each text file is capped at 2 MiB or
20,000 lines, HTML and patches at 1 MiB; transfers are bounded pages. Temporary
snapshots expire after five minutes and are not persisted by Weft. Preview requests,
contents, and patches are excluded from diagnostic logs.
Tracking is rebuilt from host history on reconnect/reload. Known file-tool successes
and committed native edits are tracked; arbitrary shell commands, MCP paths,
relative paths without authoritative working-directory metadata, and failed reads
are not inferred. Protected internal paths remain blocked. Outside-workspace files
have previews, not Git diffs. Lists are capped at 4,000 files, and Git checks only
policy-approved touched workspace paths. Workspace previews need not have been
touched; outside-workspace previews always require an exact session record.

A project is a named existing directory on the laptop, not a copy uploaded to the phone.
The device dashboard groups these registrations under **Copilot workspaces**; the CLI
continues to use `project` in its commands.
Use `weft add-project <name> <path> --default` to register it, quoting paths with spaces.
Run the same command with the same name to replace a moved folder's registration.

`weft list-projects` shows the saved choices; `weft set-default <name>` changes the
default. `weft remove-project <name>` removes only the registration, not its files.
In the device menu, **Refresh projects** reloads choices on the phone.

Registration is a launch convenience, not a security sandbox. See the
[project walkthrough](https://aasis21.github.io/weft/#projects) for platform-specific
examples.

## Open a shared terminal

Run `weft start` on a supported Windows laptop. Terminal access is enabled by default;
set `terminal.enabled` to `false` in `~/.weft/weft.config.json` and restart Station to
disable it. **Open terminal** on the device page creates
or reconnects to one shell, also displayed in a visible laptop attach window.
Leaving the phone page keeps it running; confirmed Close terminal ends it.
This is direct access under your local account, not a Copilot tool approval or a
workspace sandbox. See the [terminal guide](terminal.md) for controls, lifecycle,
privacy, and troubleshooting.

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
| Configured Supabase relay (hosted by default) | Fastest setup; use the URL/key already saved by the installer. | `weft set-transport supabase` |
| Visual Studio Dev Tunnel | You want to operate the relay under your own account. | `weft set-transport devtunnel` |

With the dev-tunnel transport, `weft start` can provision and manage the relay for its own
lifetime. To keep a shared relay running across station restarts, or to use `/weft`, run
`weft devtunnel start` in a separate terminal.

For a self-hosted Supabase project, RLS, and operator guidance, see
[`hosting.md`](hosting.md).
Changing the transport choice does not overwrite saved Supabase connection details.
Restart the station and scan its new QR when changing relay settings so the phone
uses the intended connection.

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
| `weft set-permission <default\|allow-all>` | Choose the permission mode initially selected for phone-launched Start/Resume. |
| `weft show-permission` | Show this laptop's configured launch permission default. |
| `weft show-transport` | Show the effective transport and source. |
| `weft set-transport <supabase\|devtunnel>` | Select the transport for subsequent starts. |
| `weft set-transport clear` | Remove the explicit transport selection. |
| `weft set-pairing <persistent\|ephemeral>` | Choose the Device Station pairing lifetime. |
| `weft rotate-pairing` | Replace a persistent pairing identity and invalidate the old QR. |
| `weft update --check` | Check for a newer hosted release or missing/corrupt mandatory files. |
| `weft version` | Show the installed version. |
| `weft update` | Verify and install the current hosted release without deleting local data. |
| `weft install [--from <dir>] [--skill <file>]` | Install local code bundles, optionally with a specified source and skill. |
| `weft clean-install [--yes]` | **Destructive:** delete installed code and `~/.weft/` data, then reinstall. `--yes` skips confirmation. Prefer update or pairing recovery. |
| `weft devtunnel <start\|status\|stop>` | Operate the shared dev-tunnel relay. |
| `weft help` | Show CLI usage. |

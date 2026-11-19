# Weft privacy notice

Weft connects a phone to GitHub Copilot CLI and local Copilot app sessions on a laptop. It is
designed so relay infrastructure does not receive plaintext session content.

## Data stored on your devices

The phone or installed PWA stores data locally so it can restore your workspace:

- paired devices and sessions;
- transcript history and session metadata;
- app and voice preferences;
- pairing public keys and private keys.

Device Details can explicitly transfer bounded plain text through the paired laptop's
clipboard. Clipboard contents are held only in runtime memory for the active operation:
they are not continuously synchronized, stored in Weft device records, or written to
Weft diagnostic event logs. Closing the Clipboard sheet clears its text from the app.
The laptop and phone operating systems may retain copied text according to their own
clipboard-history settings and policies.

The native app uses Capacitor Preferences. The PWA uses browser storage. Removing a
session deletes its locally cached transcript; clearing the app's site data removes
the PWA's local data.

The laptop stores installed code under `~/.copilot/extensions/weft/`. Configuration,
registered projects, logs, relay settings, and persistent Device Station pairing
material are stored under `~/.weft/`. The same user-private tree contains small runtime
presence records, local endpoint capabilities, lifecycle operations, and recovery
identity references. Completed operations and unclaimed recovery identities are removed
after three days unless a live runtime or unresolved operation still references them.
A `/weft` pairing inside one Copilot session uses an ephemeral identity that ends with
that session.

An activated session also keeps a local **session stream store** under
`~/.weft/session-streams/` (one file per shared session), so the phone can catch up
with the same detail it would have seen live. It contains user messages, completed
assistant messages, tool cards with their arguments and output (output is limited to
2,000 characters, as sent live), and warnings and errors. It excludes token deltas,
reasoning, workspace previews and terminal output. Each event is limited to 64 KiB.
This store is plaintext in the user-private laptop directory, not a diagnostic log;
catch-up travels only over the paired encrypted channel. Retention is three days, up
to 2,000 events or 10 MiB per session; older tool cards are removed before messages.
A store unused for three days is deleted, and the least recently active sessions are
removed first above a 100 MiB machine budget. Removing the folder deletes laptop
catch-up without resetting pairing. Current approvals and forms are obtained from live
session state, not replayed as historical actions.

Windows background Station and relay tasks, and manually bootstrapped macOS
launchd jobs, run with the signed-in user's existing permissions. They start only
when requested, have no boot/sign-in triggers, and restart failed workloads.
`weft stop` and `weft devtunnel stop` disable their respective restart paths
before stopping them.

Files and Changes transfer workspace or session-touched names only when requested, and selected file
contents or patches only when opened or refreshed. Weft's configured sharing roots
and exclusions, Copilot's native approval, and directory grants apply. Laptop preview snapshots are bounded,
held in memory, and expire after five minutes; Weft does not persist preview content
or include preview requests and responses in diagnostic logs. HTML previews are
isolated from Weft storage and disable scripts, forms, and external requests.
Files separates lazy current-folder browsing from an agent-touched tree rebuilt
from Copilot's successful file-tool events and committed edit metadata, without a
recursive crawl. Exact outside-workspace paths can be shown
only when current sharing rules and host directory permissions permit them. Shell commands,
failed reads, and path mentions do not grant external preview access; no separate file
history or file contents are persisted by Weft.
Sharing is disabled unless enabled in the existing central `weft.config.json`.
Named allowed roots bound both trees and previews; Git repository roots include
only verified registered worktrees of the same repository. Optional root-relative
exclusions apply across those checkouts and cannot be bypassed with overlapping
root grants. Configuration and worktree membership are rechecked for new requests.
Weft file sharing does not call Copilot's experimental content-exclusion API or
automatically synchronize repository/organization exclusion rules. Configure
`files.exclude` and grant only roots you are authorized to share; existing host
permission denials are still enforced.

A dormant extension publishes local presence and holds one idle local named pipe or
Unix-domain socket, but performs no remote/network access, cryptography, QR generation,
logging, diagnostics, polling, heartbeat, retry timer, or other timer. The
filesystem supports discovery and recovery; the endpoint carries temporary local
lifecycle commands. After pairing, phone session traffic bypasses Device Station and
the local endpoint and travels directly over the encrypted relay.

## Shared terminal

Shared terminal access is enabled by default on supported Windows laptops. Set
`terminal.enabled` to `false` in `~/.weft/weft.config.json` and restart Station to
disable it. Terminal commands and
output pass between the paired phone and laptop over the encrypted device channel.
The local attach frontend communicates with Station through authenticated local IPC.

Weft keeps bounded terminal screen state and phone command recall in memory, not in
diagnostic logs or persistent phone transcripts. The shell's own history, programs
you run, and operating-system monitoring can independently record commands or
output. Remote terminal access runs with the laptop account's permissions and is
not restricted to the initial workspace.

## Data handled by relay infrastructure

Session traffic is end-to-end encrypted between the paired phone and laptop. Relay
infrastructure forwards ciphertext and stores no session content, transcripts, or key
escrow. It cannot decrypt session traffic without an endpoint key.

The relay and its infrastructure providers may process ordinary service metadata such
as IP addresses, connection times, request logs, channel identifiers, traffic volume,
and error diagnostics. Self-hosted relay operators control their own logging and
retention.

The hosted web app loads font files from Google Fonts. Google may receive ordinary web
request metadata such as your IP address and browser headers when those assets load.

## Optional Explore video provider

Explore's live Copilot dock only projects activity already present in the active
end-to-end encrypted session. Its bundled shuffled Discover deck, reading progress,
Play activities, Unwind activities, and scores remain local to the phone. If a
deployment configures the optional Watch widget, Weft displays a disclosure and does
not contact that provider until you explicitly choose to load the video feed.

The provider runs in a sandboxed frame and receives no Weft prompts, transcripts,
repository names, filenames, tool arguments, agent activity, channel identifiers, or
session identifiers from Weft. Like any external website, the provider can receive
ordinary request metadata such as your IP address and browser headers and applies its
own content and privacy policies. Weft does not copy the provider's viewing history
into its local session data.

## Accounts, analytics, and notifications

- Weft pairing does not require a Weft account.
- The Weft app does not include advertising or behavioral analytics.
- Local approval notifications contain a tool name, not command arguments or transcript
  content. Browser and operating-system notification services remain subject to their
  own privacy terms.

## Your choices

- Use the hosted Supabase relay, self-host Supabase, or use a Microsoft Dev Tunnel.
- Remove individual sessions to delete their cached phone transcripts.
- Clear the app's browser/site data to delete PWA-local data.
- Remove `~/.weft/` to delete laptop-side configuration and persistent pairing material.
- Run `weft rotate-pairing` if a persistent QR or paired phone may be compromised.
- Expect `/clear` to disconnect the current phone attachment; activate the replacement
  Copilot session again through Device Station or `/weft`.
- Use Clipboard only when you intend the paired phone to read or replace the laptop's
  current plain-text clipboard value.
- Stop an active Keep Awake lease from Device Details, or let its displayed duration
  expire automatically. Keep Awake does not alter the persistent Windows power plan.

See [`docs/security.md`](docs/security.md) for the threat model and
[`SUPPORT.md`](SUPPORT.md) for cleanup and issue-reporting guidance.
## Local Control Center

The optional app-style window uses an installed Chromium browser with a separate
persistent profile under `~/.weft/control-center-profile`. Its cookies/cache/history
are distinct from your regular browser profile. `weft ui --browser` uses your
ordinary browser instead. Both use the same private loopback authorization; app
mode does not grant remote or native-shell access or disable browser protections.

Transport authentication reporting displays only sign-in status, provider and
account label from the Dev Tunnel CLI to the authorized local browser. It never
returns tokens, tenant/object identifiers or raw command output, never signs in
automatically, and is cached briefly in process memory rather than written to
diagnostic logs. Supabase displays configuration/project endpoint, not its key.
Saved pairing metadata is read without importing or generating a private key;
only the existence of saved phone trust is returned.

`weft ui` serves an optional laptop management interface on loopback only. Its
private bootstrap authorizes a same-origin browser session; configuration and
session-status requests require that authorization. A private host registry lives
under `~/.weft/control-center.json` and is removed when the host closes.

The dashboard displays local project paths, user-selected session names, connection
state and configuration to the authorized local browser. Pairing payloads are
requested only in explicit pairing flows, never general status or diagnostic logs.
The UI does not upload this data or load third-party scripts. Update checks contact
the configured Weft release origin. Browser history can retain the private initial
bootstrap address; treat it as sensitive while that host is running.

The shared management layer uses a local operation lock and existing authenticated
worker/session control. It adds no remote authority, transcript viewer, arbitrary
shell endpoint, boot trigger, or always-running tray process.

## Local diagnostics

`diagnostics.enabled` in `~/.weft/weft.config.json` is a per-laptop setting, on by
default for compatibility. Change it in Control Center Setup or with
`weft set-logging on|off`; `weft show-logging` reports it. Updated Station, relay,
Control Center management, and active Weft session writers check it on each write.
Older processes must be restarted/reloaded after updating. Dormant sessions still
do no diagnostic work. Turning it off stops new Weft diagnostic writes; it does
not delete existing files, affect Copilot's own history, or clear the phone's
separate event/transcript cache.

Station, relay and management diagnostics use `~/.weft/station.log`, with one
rotated backup at approximately 1 MB per file. Active Weft sessions use
`~/.weft/sessions/<sessionId>.log`, with the same rotation and retention of up to
100 recent base logs plus their backups. Old-file cleanup is best-effort. A failed
rotation skips the new write and reports a local access/settings warning instead
of silently growing the file.

Structured diagnostics retain only bounded operational metadata: timestamps,
event names, process/session/channel identifiers, versions, stages, durations,
counts, stable error codes and hashed operation correlation identifiers. They
exclude prompts, tool arguments/results, terminal output, project paths, device
names, credentials and pairing keys. `weft logs` and the explicitly loaded
Diagnostics view return at most 100 recent sanitized Station/management entries;
they do not expose raw legacy log lines or upload logs. Identifiers and timing
still describe your activity, so review output before sharing it.

**Phone traffic** in Control Center Diagnostics is held only in the memory of the
updated Station and active Weft sessions (latest 100 entries each) and is never
written to disk. Each entry keeps direction, a readable event name, encrypted size,
timing, and pass/fail or reply status. Message text, prompts, approvals, file and
terminal content, clipboard contents and keys are not recorded. Only the
authorized local dashboard can read it, and it stops recording while local
diagnostics are off. **Copy for bug report** omits session names.

**Background worker crash information** on Windows stays in `~/.weft`. After a
crash, the restart loop writes `background-<role>-restarts.json`: crash counts,
exit code, timestamps and run length. When local diagnostics are on, a worker
that exits on a fatal error first writes `background-<role>-failure.json`. It
holds only the latest error's name, code, first message line (addresses and
credential-like values redacted) and source file name and line, with no stack
trace or folder path. A fresh Start deletes both files. Weft never uploads them.

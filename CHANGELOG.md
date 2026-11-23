# Changelog

Notable user-facing changes are recorded here. Versions follow the release version shipped
with the Weft extension and mobile app.

## Unreleased

## 0.2.77

- **The phone shows the laptop's current Weft version.** About and Settings used the version Station
  ran when the phone first paired, so an updated laptop kept showing an old number (for example
  0.2.68 on a 0.2.76 laptop). Station now reports its version on every connect and heartbeat, and
  the phone keeps it current.
- Update output now reads "1 session needs…" instead of "1 session need…".

## 0.2.76

- **Updates reload open sessions without cutting a turn off.** After `weft update` restarts
  Station, every open Copilot session on Weft 0.2.76 or later reloads Weft by itself: an idle
  session right away, a busy one as soon as its current turn ends. Sessions already on the new
  version are left alone. Sessions still on 0.2.75 need one manual reload (Control Center's
  **Reload Weft in open sessions**, or `/extensions reload`); from then on it is automatic. The
  Control Center button uses the same wait-for-the-turn behaviour.
- **Leftover node-pty folders are cleaned up on `weft start`.** An update that could not remove the
  previous node-pty copy (Station still had it loaded) now removes it as soon as Station restarts,
  instead of waiting for the next update.
- **"Copy pairing code" copies the pairing link.** Control Center, the pairing panel and the
  terminal's "Can't scan?" fallback now give the same `/pair` link the QR opens, which works opened
  on the phone or pasted into the app, instead of raw JSON.
- **Legacy names removed.** Protocol v2 builders and the old `operationId` identity field are gone,
  and docs point at the current modules.

## 0.2.75

This release rebuilds how the laptop keeps sessions connected. Laptop and phone must both be on
0.2.75; older versions are told to update instead of failing silently.

- **Sessions reconnect on their own.** Station supervises every open session: a session whose phone
  link gets stuck (for example after an extension reload) is repaired in place, without a tap. Every
  connection attempt now has a deadline and is logged.
- **One way to recover.** A recovery bar above the composer replaces the offline banner. One button
  reconnects, asks Station to reopen the session, or explains exactly what is wrong (laptop asleep,
  another phone in control, session ended, update needed). Pull down in a session does the same.
  A session is only resumed in a new terminal after Station proves the old one has stopped.
- **`weft start` always ends with a working Station.** It says when Station is already running,
  restarts it after an update, and replaces a stuck or mismatched Station automatically. `weft update`
  restarts Station on the new code and cleans up leftover files. Control Center shows the same state
  (Running / Restart to update / Repair Station) and can reload Weft in open sessions.
- **Pair with the phone's camera.** The laptop QR is now a link: the phone camera opens the Weft
  Android app (or the web app), and in-app Scan and Paste still work.
- **Phone UI:** the Weft logo is the menu button on every screen; the ⋯ menu is reorganised with
  *Remove from this phone*; swipe up anywhere on the composer to open Session controls and drag down
  anywhere to close; offline sessions keep showing their last model.
- Behind the scenes: session state moved from six stores to two (`~/.weft/sessions-live/`,
  `~/.weft/requests/`), protocol version 3, and a shared health model used by phone, Station and
  Control Center. Design: `docs/design/0.2.74-hld.md`, `docs/design/0.2.74-lld.md`.
## 0.2.73

- Session controls add **Approvals**: Ask each time, AI review or Allow all, limited to what the
  session's policy allows. Allow all asks for confirmation; changes made at the laptop (for example
  `/allow-all`) show up on the phone.
- The panel has a fixed height: header, Mode and Approvals stay put while the model list scrolls.
  Swipe up on the pill to open it and drag the header down to close it.
- Mode descriptions are gone; Autopilot keeps its amber highlight.

## 0.2.72

- Choose effort inside the model: tap a model in Session controls to pick its effort level, with a
  short description of each. Models without effort levels switch on tap.
- Get the Android app straight from the landing page on Android, with a new *Get Weft on your
  phone* section and a QR on laptops. The download link always serves the newest signed APK.
- About Weft is now a compact screen with this phone's and your laptops' versions, an update
  notice inside the Android app, and links; the full product page is one tap away.

## 0.2.71

- Session controls show each model's effort levels again. Current Copilot CLIs report them under
  the model's capabilities; Weft now reads both the new and the old field.
- Picking a model scrolls to its effort levels and highlights them, so effort is the next step.

## 0.2.70

- Each release is now one GitHub release (`v0.2.70`) with the signed Android APK, laptop
  payloads and these notes. The APK keeps the same signing key, so it updates in place.

## 0.2.69

- One tap on the composer pill opens Session controls: Mode (Interactive, Plan, Autopilot),
  Effort, and Model in one bottom sheet. Effort levels rebuild for the chosen model, keeping
  yours when supported or switching to the model default; models without effort hide it.
- The pill reads like `Opus 5.5 · Med` and shows Plan or Auto in colour when not interactive.
- The session folder moved from the composer to the header status line.

## 0.2.68

- New first-run Connect screen on Android and mobile web: explains Weft Station
  (recommended) and `/weft` side by side, with **Scan laptop QR** and **Paste code**.
  The camera opens only when you ask, shows **Opening camera…** instead of an empty
  viewfinder, and pairing shows progress with **Try again** on failure. From a live chat,
  `/weft` instructions lead. **Send setup link** shares the laptop install page.
- Weft no longer asks for notification permission at launch; a one-time
  **Get approval alerts** card appears after the first real pairing.
- Woven Weft menu icon, a narrower mobile drawer, and its close button now sit in the
  WEFT header below the status bar. Drawer actions read **Start session** and **Scan QR**.
- Control Center no longer gets stuck on **Status unavailable** on a busy Windows laptop:
  slow Task Scheduler and session checks are time-limited and shared between refreshes,
  a Station record left by an exited worker shows as stopped, and the page shows
  **Refreshing…** while a slow check finishes.

## 0.2.67

- Keep the Android composer above the on-screen keyboard while typing multiline
  messages. Enter still inserts a newline.

## 0.2.66

- Recover session access on a full browser store by evicting only cached transcripts
  and diagnostic logs, without clearing pairing information or pending operations.
- Give Android's Supabase socket time to reconnect after an initial transport error.
  The connectivity test now checks the configured Supabase relay as well as a public echo server.

## 0.2.65

- On busy Windows machines, Weft batches its runtime discovery checks and gives
  PowerShell more time to verify process identity, so Android and web sessions
  do not get stuck waiting when Copilot has already started.
- Build an Android debug APK from source with `npm run build:android -w @aasis21/weft-mobile`.
  The Android app supports pasting a pairing code and falls back to its in-app
  camera when the Google Barcode Scanner module is unavailable. The hosted PWA
  remains the supported phone distribution.

## 0.2.51

- The composer's mode chip is now a **model dropdown**. It shows the current model and reasoning
  effort, lists the models your Copilot account can use (read from the laptop, so Claude Opus and
  GPT-6.1 Sol appear when available), and offers the effort levels the chosen model supports.
  Switching model keeps your effort level when the new model supports it.
- New slash commands: `/effort` sets the reasoning effort; `/interactive`, `/plan` and
  `/autopilot` switch mode. `/model` offers the same live list as the dropdown. A small tag shows
  Plan or Autopilot when you are not in Interactive mode.
- Mode, model and effort are applied by Weft through the session API, not run as Copilot CLI
  commands; the laptop accepts only models the session lists and efforts that model supports.

## 0.2.50

- Catch-up now shows what you would have seen live. Tool cards you missed keep their real
  arguments and output instead of a bare "Completed"/"Failed", and warnings are kept too.
- The "N new" badge on a session counts assistant replies you have not seen, not every tool event.
- When another session is waiting for an approval or an answer, the session menu button shows a
  small amber dot.
- The laptop keeps each shared session's catch-up in a **session stream store**
  (`~/.weft/session-streams/`). Each event is appended once instead of rewriting the whole file,
  and cleanup of idle sessions runs when a store opens rather than on every event. Over its limit,
  a session drops old tool cards before messages, without reporting them as lost activity.
- Protocol: catch-up messages are renamed `catch_up_request` / `catch_up_page`, with event
  positions `streamEpoch` / `streamSequence`. The phone sends its last viewed position with watch
  requests. Laptop and phone must both run this version; old `~/.weft/recovery` caches are removed,
  so the first catch-up after updating starts fresh.

## 0.2.49

- Report Station or relay workers that keep crashing. After 5 crashes in a row, each
  within a minute of starting, Control Center and `weft status` show **Crashing
  repeatedly** instead of retrying silently. The details show the exact last error
  (name, code, first message line, file and line), the exit code and its meaning, and
  the next retry time, with **Copy error details**. Restart becomes the main action.
- "Stopped unexpectedly" now explains the exit code and shows the last recorded error.
- Clearer background-task code: named restart and crash constants, descriptive
  variable names in the supervisor and task scripts, and a written overview.
- A worker started from an earlier version now asks you to run `weft stop` and
  start again.

## 0.2.48

- Summarize older sessions that cannot report phone traffic in one Diagnostics line
  instead of one note per session.

## 0.2.47

- Add **Diagnostics → Phone traffic** to Control Center: a live view of the latest 100
  encrypted messages between this laptop and the paired phone, from Station and active
  sessions. It shows direction, readable event names, size, request/reply timing and
  failures, with filters, grouping of heartbeats and streaming, pause, clear and copy.
  Only metadata is kept, in memory, and nothing is recorded when local logging is off.

## 0.2.46

- Keep waiting when Station or the relay is too busy to answer a 2-second status check
  during startup, instead of failing Start Station with an unexplained error.

## 0.2.45

- Stop reporting an installed but slow Dev Tunnel CLI as missing: allow 30 seconds for its
  version check and retry after a failure instead of remembering "not installed".
- Keep the Control Center usable when one Windows status check is slow or fails: show
  partial status, check Dev Tunnel sign-in in the background, and wait up to 30 seconds.
- Report Station or relay stopping unexpectedly with its Windows exit code in Control
  Center, `weft status`, and local diagnostics.

## 0.2.44

- Use one filtered Windows creation-time inventory for runtime identity verification,
  avoiding slow per-process handle inspection while preserving PID-reuse protection.
- Explain native Copilot startup prompts separately from Weft terminal and transport readiness.

## 0.2.43

- Open phone-launched Copilot sessions in a visible Windows console when background
  Station has no Windows Terminal context, preserving identity and working directory.
- Batch runtime process verification for session lists, launch coordination and
  recovery; bound phone-list discovery without activating sessions or losing saved history.
- Add per-laptop diagnostic logging controls in Setup and `weft set-logging on|off`,
  `weft show-logging`, and `weft logs`. Keep logs local, bounded, sanitized and
  correlated across startup, discovery, launch and management operations.
- Show the bundled Weft logo in the Control Center window and add an explicitly
  loaded, sanitized Diagnostics viewer.

## 0.2.23

- Resumed historical Copilot sessions created before Weft when no runtime ownership evidence
  exists, while preserving fail-closed handling for conflicting or unverifiable modern runtimes.
- Kept the phone at the reader's manual scroll position when new events, heartbeat-driven
  rerenders, large tool cards, or older history pages arrive.
- Stabilized live-runtime integration coverage by allowing the test assertion to outlive the
  production discovery timeout it exercises.

## 0.2.22

- Synced laptop `/rename` changes into the Weft session UI without letting unchanged
  heartbeats erase an intentional phone-local label.
- Added `weft set-permission <default|allow-all>` and `weft show-permission` so each
  laptop can choose the initial permission mode for phone-launched Start and Resume.
- Kept the permission selector as a per-launch override and failed safely to normal
  prompts when the configured value is missing or invalid.

## 0.2.21

- Added the source device name beside each session's project metadata in the session drawer.
- Kept Start and Resume together above Clipboard, Keep Awake, and Terminal in Quick actions.
- Made the mobile slash-command palette independently scrollable and bounded above the keyboard.

## 0.2.20

- Improved device fallback states when Windows cannot provide system metrics or an
  older Device Station does not advertise monitoring support.
- Replaced the cramped terminal capability warning with a readable, mobile-safe card
  that explains update and configuration options without overflowing.

## 0.2.19

- Repairs incomplete same-version installs by downloading every mandatory bundle declared
  by the hosted release manifest.
- Keeps phone control connected across full Copilot extension process replacements by
  restoring durable controller identity and re-authenticating after heartbeat loss.
- Removes dead runtime-presence records without collapsing independent live sessions, and
  fences stale lifecycle handles from deleting replacement state.
- Reconciles preserved Dev Tunnels to the active relay port and cleans up abandoned or
  partially provisioned cloud tunnels.

## 0.2.18

- Redesigned session activation so dormant Copilot sessions stay silent and lightweight,
  Device Station reuses already-running terminals without duplicate Resume processes, and
  lifecycle recovery, cancellation, and controller takeover remain single-writer safe.
- Simplified onboarding around `install` → `weft start` → scan.
- Added phone/laptop version mismatch and update guidance.
- Added expiring, single-use pairing grants, nonce-bound handshakes, and authenticated
  replay/order protection for encrypted session traffic.
- Stopped native builds from mirroring pairing keys and transcripts into WebView
  `localStorage`; legacy native mirrors are migrated and removed.
- Added strict browser security headers and content security policies.
- Added checksum-verified installers and updates, immutable GitHub release archives,
  provenance attestations, and optional APK metadata for a future signed Android pipeline.
- Expanded the launch gate to cover every workspace, mobile test types, the extension
  relay harness, Chromium/WebKit journeys, accessibility checks, builds, and dependency
  auditing.
- Clarified that the relay stores no session content while paired devices retain local
  session data for reconnect and restore.
- Added privacy, security reporting, support, contribution, and hosted-service policy
  surfaces.
- Moved `/weft`, alternate transports, pairing modes, and self-hosting into advanced
  documentation.
- Improved hosted-app metadata and icon declarations.

## 0.2.6

- Current public preview release.
- Added the standalone Device Station, multi-device/session management, persistent
  pairings, version reporting, voice controls, and hosted web installation.

Earlier development history is available in the
[Git commit log](https://github.com/aasis21/weft/commits/main/).

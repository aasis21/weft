# Weft resilience and attention-aware streaming

Status: implemented and locally validated; not installed or released.
Discussion captured: 2026-11-06.
Inspected baseline: `62ada12` on `main`.

This document captures the agreed direction for easier startup, recovery after
sleep and outages, attention-aware delivery, and useful mobile catch-up. It
distinguishes confirmed decisions from proposed implementation details. Existing
baseline notes below are historical; see the implementation record for the new behavior.

## Implementation record

Windows startup now uses manually launched, per-user Scheduled Tasks with limited
interactive-user permissions and no triggers. The task action supervises its worker
with bounded restart backoff. Native testing found that `RestartOnFailure` alone did
not restart a manually launched, triggerless task on this machine; the worker loop
addresses that without adding boot/sign-in or periodic startup. Intentional stop
disables the task and fences its internal restart loop before quiescing.

`weft start` and `weft devtunnel start` return after authenticated local readiness.
`--foreground` preserves terminal-owned operation. `weft stop` stops Station only;
`weft devtunnel stop` stops the shared relay. Endpoint changes are explicit and
retrieve an updated QR, never an automatic trust rotation or transport fallback.
Transient network/auth failures do not discard a saved tunnel, and a busy saved port
is retried before using a different endpoint.

Session and Station adapters share pairing lifecycle and attention leases without
embedding Station in `/weft`. Session capture, pending requests, recent turns, and
recovery survive transport detach/rebind. Only actual session shutdown ends them.
New native permission requests fall back to local Copilot when no phone watch is
available. Ordinary reconnect/retry messages no longer flood host chat.

`attention-v1` clients watch the visible chat in detail, other visible sessions in
compact mode, and stop hidden watches. Watches renew every 20 seconds, expire after
60 seconds by default, and have a five-second stop cooldown. Expiry is checked
before sending, including after sleep; retired watch IDs cannot renew a stopped
watch. Legacy clients retain their existing live delivery.

Missed-event journals are user-private local caches under `~/.weft/recovery`.
They retain meaningful messages, generic tool/failure summaries, and ordered
epoch/cursor metadata, not tokens, reasoning, raw tool arguments/results, or actions.
Retention is three days, 2,000 events/10 MiB per session, and oldest-cache eviction
against a 100 MiB machine budget. Large recovered messages are explicitly truncated
and report a gap; recovery pages are byte-bounded. Corrupt caches reset explicitly,
and unavailable storage degrades with a notice rather than disabling live pairing.
The phone persists catch-up/cursors together, deduplicates replay, and restores
current approvals from authoritative snapshots. A live sequence jump does not advance
the committed cursor past missing events before replay fills the gap.

Capture does not wait for network delivery. Pending live delivery is bounded to 64
frames; adjacent deltas for the same message coalesce up to 32 KiB. Dequeued frames
recheck the current channel and attention lease. Backpressure can discard queued
frames, but meaningful events remain in the journal and a cursor update requests
catch-up. Expired atomic-save leftovers from crashes are removed with cache retention;
fresh temporary saves are not interrupted. Delayed control replies are bound to their
original connection, so reconnect cannot deliver an old recovery page to a new peer.

WebSockets now enforce connect and pong deadlines, fence stale socket callbacks,
and recover half-open connections with backoff. The background relay manager checks
both local health and public forwarding; offline networks are distinguished from
repeated rejection before recovery. Hosting-failure classification waits for stderr
to drain; startup output is bounded, and a healthy host's output is drained without
retaining a growing diagnostic buffer.

### Validation environment and limits

Final repository test run passed: 130 shared tests, 471 extension tests, 680 mobile
tests across 87 files, and 28 root-script tests (1,309 passing, five opt-in skips).
The skipped Windows supervisor case was also run separately and passed natively.
Focused regressions additionally verified bounded delivery overflow, recovery of
trimmed frames, expired temporary-save cleanup, and connection-bound replies.

Builds for all workspaces, mobile production/test TypeScript checks, and version
consistency passed. The configured root lint command completed; it currently has
no workspace lint scripts to execute. A real temporary Windows Scheduled Task
survived a worker crash, restarted with a new PID, stayed stopped after intentional
stop, and was removed afterward.

Node 26 exposes native Web Storage globals that conflict with the existing JSDOM
test environment. Unchanged mobile tests fail independently with that environment;
disabling native Web Storage makes the full mobile suite pass. Use this process-local
setting for repository tests on this machine:

```powershell
$env:NODE_OPTIONS = '--no-experimental-webstorage'
npm test
```

Socket/watch tests simulate half-open connections and elapsed leases after sleep;
recovery tests cover missed events, paging, privacy, persistence failures, sequence
gaps, backpressure, and stale connection replies. Physical sleep/hibernate cycles,
an actual phone, production Dev Tunnel recovery, and installed CLI/app-host behavior
have not been certified by this run. No release, installed-client update, or production
Station/tunnel startup was performed.

## Confirmed decisions

| Area | Decision |
| --- | --- |
| Station startup | Manual start, background operation, automatic recovery. No automatic machine-boot or user-sign-in startup. |
| Direct session startup | Keep `weft devtunnel start` explicit. `/weft` only connects to an existing relay; it does not provision infrastructure or start Station. |
| Endpoint recovery | Make reasonable recovery attempts against the existing tunnel and endpoint first. If that endpoint genuinely cannot be recovered, ask for an endpoint-refresh QR scan. Do not add an independent rendezvous service or automatic transport fallback. |
| Pairing | Ordinary reconnects reuse the trusted device identities and require no user interaction. Retain automatic secure challenge-response. A connectivity failure alone must not rotate trust. |
| Watched chat | Send live messages, text streaming, tool activity, state, and pending approvals. |
| Other activated sessions | While mobile is visible, send compact status, unread progress, and needs-attention updates, not full transcript/tool chatter. |
| Mobile hidden or disconnected | Stop application updates after explicit stop/cooldown or watch-lease expiry. Retain necessary transport keepalive and local catch-up data. |
| Catch-up | Recover messages, tool summaries, failures, and current pending approvals. Do not persist every token delta or default to full tool arguments/results. |
| Host experience | Do not flood individual Copilot CLI terminals or Copilot app chats with send failures and retry messages. Keep local Copilot operation independent of Weft connectivity. |
| Architecture | Share reliability behavior without making Device Station a mandatory session-traffic router. Support direct session pairing without Station. |

## Existing behavior and relevant source

The inspected baseline had useful foundations but did not provide the complete
behavior above. This table records the original gaps.

| Existing pattern | Source | Change needed |
| --- | --- | --- |
| Station lifetime is tied to its launching terminal; it may provision and own the shared relay. | `extension/bin/weft.mjs` | Background lifecycle and consistent recovery ownership. |
| Station's owned-relay watchdog checks every 30 seconds, with repeated local probes before action. | `extension/bin/weft.mjs`, `startRelayHealthWatchdog`, `relayLooksWedged` | Include end-to-end forwarding checks and handle recovery regardless of the original launch path. |
| Public probes distinguish `ok`, `rejected`, and `unreachable`; public verification is optional in `healthyRegistryEntry`. | `extension/src/devtunnel.mjs` | Reuse that classification during ongoing recovery, not just startup/reuse. A rejected probe alone should not trigger immediate replacement. |
| The laptop socket reconnects with backoff and sends pings, but does not enforce a pong deadline. | `extension/src/reconnectingSocket.mjs` | Detect half-open sockets and connection attempts that never settle. |
| Station persists its identity and trusted phone key; mobile reconnects with saved material and a fresh challenge-response. | `extension/src/pairingIdentity.mjs`, `listener.mjs`, `mobile/src/lib/weftClient.ts`, `shared/pairing.mjs` | Preserve this security contract; improve availability rather than remove authentication. |
| Tunnel ID and relay port are remembered; missing tunnels, host failures, or occupied local ports can result in a replacement URL. | `extension/src/relayServerProcess.mjs` | Prefer repairing the existing endpoint and classify failures before replacing it. |
| Device telemetry already uses monitor start/renew/stop, bounded intervals, lease expiry, and monitor IDs. | `extension/src/listener.mjs`, `startMonitoring`, `stopMonitoring` | Extend the same lease pattern to session and Station application updates. |
| Activated sessions forward events independently of the phone's selected view. | `extension/src/relay.mjs` | Gate remote delivery by requested attention level. |
| Mobile foregrounding requests state and history for warm sessions. | `mobile/src/session/runtime/sessionRuntime.ts`, `handleResume` | Reacquire watches, prioritize the visible view, and distinguish received data from viewed data. |
| Host history primarily supplies completed-turn text; the recent-message buffer is in memory. | `extension/src/store.mjs`, `recentTurns.mjs` | Add bounded recovery for meaningful events that host history cannot supply. |
| Reconnect and subscribe attempts can write persistent host warnings. | `extension/src/activeRuntime.mjs`, `connectRelayWithRetry`, `requestReconnect` | Replace repeated user-visible warnings with quiet state transitions and sanitized diagnostics. |
| Dormant extensions expose local lifecycle discovery; activated phone traffic bypasses Station. | `README.md`, `extension/src/extensionBootstrap.mjs`, `runtimeLifecycle.mjs` | Preserve dormant inactivity and direct session operation. |

## Architecture: shared behavior, optional Station

The two entry points intentionally expose different product scopes:

| Entry point | Phone access |
| --- | --- |
| `/weft` inside CLI or Copilot app | That explicitly activated session: chat, tools, prompts, approvals, and supported session-scoped controls. |
| `weft start` | Device-level access: registered projects, discovery/connect/resume of multiple sessions, remote session launch, and supported Station-owned device/terminal features. |

The shared layer is not a requirement to run `weft start`. Both modes reuse the
same reliability mechanisms; a direct session can use those mechanisms without
Device Station. Sharing a relay or code does not implicitly authorize session
discovery, expose other sessions, or grant remote launch/device capabilities.
Mobile must distinguish a session-only pairing from a Station/device pairing and
show only the capabilities actually advertised by that endpoint.

Use three logical responsibilities, not one mandatory Station data path:

1. **Session reliability code:** secure connection lifecycle, attention leases,
   meaningful-event capture, catch-up, and quiet host status. Reused by Station
   where appropriate and by both CLI/app session extensions.
2. **Machine-wide Dev Tunnel manager:** one shared relay endpoint, serialized
   provisioning, health checks, and recovery. It is not a transcript aggregator.
3. **Device Station:** device administration, projects, session discovery and
   activation/launch, and the Station-owned shared terminal.

```text
CLI/app session -> shared reliability behavior -> encrypted relay -> phone
Device Station  -> shared reliability behavior -> encrypted relay -> phone
                                                      ^
                                          Dev Tunnel manager
```

Each session retains its own channel, pairing authority, watch state, and recovery
cursor. The relay forwards ciphertext; it does not decrypt session content.
Shared libraries avoid duplicated policy, while the manager coordinates only
machine-wide infrastructure. Keep shared protocol code host-neutral and place
process/OS supervision in the extension layer. Reuse existing modules rather than
creating a separate service or file for every policy.

### Operation without Station

| Mode | Behavior |
| --- | --- |
| Direct `/weft` with Supabase | Uses configured transport directly; no Station or local tunnel manager is required. |
| Direct `/weft` with Dev Tunnel | Requires an explicitly started relay via `weft devtunnel start`. It connects, but never provisions the relay. |
| Direct session already paired | Messages, watch leases, catch-up, prompts, and approval handling work without Station. |
| Station absent | Station-based device administration, discovery, activation/launch, and shared terminal features are unavailable. |
| Station crashes but relay survives | Direct session channels continue. Do not incorrectly mark every session disconnected. |
| Shared relay fails | Affected channels recover quietly; local Copilot work continues. |

Multiple independently activated `/weft` sessions can share relay infrastructure
without becoming a Device Station. The phone may retain those individually paired
sessions, but discovering or launching additional sessions still requires the
explicit Station path. Do not start Station implicitly to make direct pairing work.

Dormant, never-activated extensions must remain local-only: no remote connection,
heartbeat, watch timer, recovery loop, or event journal introduced by this work.
Ending or clearing a session is not an instruction to resurrect it.

## Background startup and ownership

Preserve the command entry points, with the following proposed lifecycle:

- `weft start` manually launches or attaches to one background Station. It keeps
  today's ability to obtain a relay for its selected Dev Tunnel transport.
- `weft devtunnel start` explicitly launches or attaches to the shared background
  relay manager without requiring Station.
- `/weft` remains an explicit session activation/connection operation only.
- Closing the command's launch terminal does not stop its background workload.
- Explicitly stopping a workload prevents its supervisor from immediately
  restarting it. Existing force-stop behavior remains deliberate, not a crash.

The manager needs a singleton lock, authenticated local control, durable desired
state, and verified ownership. A PID alone is not sufficient proof of ownership.
Reuse existing registry/process-identity mechanisms where suitable.

Station-started infrastructure and independently started infrastructure need
distinct ownership semantics. Track activated dependents so normal Station shutdown
does not remove a relay still serving direct sessions. Explicit force-stop may
disconnect dependents, but must not be undone by a stale recovery timer.

Process recovery must have an owner outside the workload that crashed. For Windows,
evaluate an on-demand, per-user scheduled task with restart-on-failure and **no
boot or sign-in trigger**. Verify that the execution context preserves interactive
desktop access for the shared terminal. A minimal helper supervisor is another
implementation option, but cannot promise recovery if the helper itself dies.
Select and verify this mechanism before implementation; do not register startup
tasks or install services solely because this document suggests them.

## Same-endpoint recovery

Recovery order:

1. Establish whether the machine has usable connectivity. Offline/DNS/timeout
   failures enter waiting/backoff; do not repeatedly recreate the cloud tunnel.
2. Verify the local relay and public forwarding separately. Require repeated,
   classified failures before taking destructive action.
3. Repair a half-open socket or restart hosting of the existing tunnel as needed.
4. Repair/restart the local relay when it is actually unhealthy.
5. Reuse the remembered tunnel identity and exposed port whenever possible.
6. If the tunnel is confirmed deleted/expired/unusable, report that preserving the
   endpoint failed. A replacement endpoint requires an explicit user-visible QR
   refresh, not an undisclosed address change or automatic transport fallback.

Use bounded retry cycles with exponential backoff and jitter, with a cooldown
between cycles. Do not use aggressive endless provisioning attempts. Authentication
failures enter `sign-in required`; ordinary network failures do not.

An occupied local port is not automatically evidence that the public endpoint must
change. Check whether Dev Tunnel can preserve its exposed port with a different
local mapping before relying on that approach. If unsupported, report the conflict
rather than immediately falling back to a random port and claiming seamless recovery.
Never terminate an unrelated port owner.

Manager endpoint changes must invalidate stale descriptors for activated sessions
and pending connection operations, not just Station's listener. Coordinate through
local control without activating dormant sessions. A phone holding a dead URL cannot
learn an arbitrary new URL through that dead URL; user-assisted refresh is the
chosen recovery limit.

### Pair once is not "authenticate never again"

Keep the stored laptop and phone identities. Existing challenge-response runs
automatically on reconnect and establishes a fresh authenticated encryption key.
It requires no new QR scan in ordinary recovery.

An endpoint-refresh scan updates connection information while retaining trusted
identity where supported. Replacing the trusted phone, clearing its storage, or
explicitly rotating pairing is different and requires fresh trust establishment.
Do not reset secure sequence/replay state and reuse an old encryption key to
simulate reconnect. Application recovery cursors are separate from encrypted
transport stream sequence numbers.

## Sleep, hibernate, and wake

During sleep/hibernate, normal execution and networking are unavailable. Mobile
eventually reports the laptop unreachable and retains cached conversations.
Background operation does not keep the laptop awake.

On wake, detect an elapsed-time discontinuity and/or an available OS resume signal,
then run a coalesced recovery check. Do not rely only on a periodic timer, and do
not let multiple wake/network signals start parallel recovery operations.

- Treat old watch leases as expired before attempting any application send.
- Wait for networking, then verify local and public health.
- Reconnect with saved trust and reacquire phone watches.
- Restore current state and missed meaningful activity without duplicates.
- Never automatically resend prompts, repeat terminal input, respawn Copilot, or
  answer approvals as part of connectivity recovery.

Wake differs from reboot. With the agreed manual-start model, reboot requires the
user to start Station and/or the relay again. Lost pairing storage, expired hosting
authentication, deleted tunnels, and external service outages remain explicit limits.

## Attention-aware delivery

Extend the existing monitoring lease pattern with capability-negotiated,
encrypted watch control messages. Proposed semantics:

| Request | Purpose |
| --- | --- |
| Start watch | Supply a watch ID/generation, requested level, and last-received recovery cursor. |
| Renew watch | Extend that same watch while the relevant view remains visible. |
| Stop watch | Release that watch; ignore a stale stop targeting a replaced watch. |
| Watch acknowledgement | Return the effective level, lease expiry/duration, and sync boundary. |

Proposed initial timing defaults, not confirmed product requirements:
**60-second lease, 20-second renewal, 5-second leave cooldown**. Enforce
laptop-side bounds and expiry; do not rely on the phone's clock for authority.
Cooldown prevents rapid navigation from repeatedly tearing down/reopening streams.
Expiry is the fallback when the phone cannot send stop. Stop issuing fresh live
updates before expiry checks, including after wake.

| Mobile attention | Laptop delivery |
| --- | --- |
| Watched chat visible | Detailed live events plus current state and incremental catch-up. |
| Other activated sessions while mobile visible | Compact working/finished/failed status, unread progress, and needs-attention changes. |
| Device/session list visible | Leased compact state for the displayed scope; detailed device telemetry only when requested. |
| App hidden, disconnected, or lease expired | No application heartbeat, transcript, tool chatter, or compact status pushes after the applicable stop/cooldown/expiry. |
| Mobile returns | Acquire fresh watches, reconcile state, and catch up the visible chat first. |

Derive attention from actual visible navigation, not merely the last selected
session ID. Device pages, Explore, and overlays must not accidentally renew a full
chat-detail stream that is no longer visible. Detail and compact watches remain
independent of local Copilot busy/idle state.

Application heartbeat suppression does not imply disabling necessary transport
keepalive. Minimal socket maintenance remains distinct from content-bearing updates.
Mobile must represent `not watching` separately from `connection failed`, rather
than treating intentional heartbeat silence as an outage.

Pending approvals remain authoritative local state. A visible compact watch can
report that attention is needed; detailed current requests are fetched when needed.
No automatic approval, background push-service addition, or guaranteed delivery to a
closed/suspended PWA is implied.

## Meaningful catch-up

Separate **capture** from **remote delivery** for activated sessions. Recovery or a
watch expiring must not remove the observer needed to retain missed activity.
Capture is tied to activation/session lifecycle, not network availability.

Reuse host history wherever it supplies authoritative messages. Retain a bounded
local journal for meaningful events that cannot reliably be recovered from host
history: missing messages, completed tool summaries, and failures. Do not persist
token deltas, default full tool payloads, terminal I/O, or diagnostic copies of
private conversation content.

The journal needs stable event IDs, per-session ordering, a recovery epoch, and
atomic writes. Define age, byte, event-count, and machine-wide storage caps before
implementation; provide explicit truncation/gap information when caps discard data.
Use device-local protection and a deliberate access policy, not the diagnostic log
as a transcript store.

Maintain separate cursors for **received**, **successfully stored**, and **viewed**
activity. Compact status or a heartbeat must not mark unseen content read.

On reconnect:

1. Acquire an authorized watch and establish a recovery boundary.
2. Fetch missed events in bounded pages, deduplicated by stable identity.
3. Reconcile current working state and pending approvals/forms from an authoritative
   snapshot. Historical approval events must not recreate obsolete actionable cards.
4. Merge events arriving during catch-up without gaps, duplicates, or stale state
   replacing newer state.
5. Continue live delivery and acknowledge successfully retained progress.

Mobile presentation: an unread divider, concise "since you last viewed" counts,
visible needs-attention state, and progressively loaded details. Synchronization
should happen automatically, not require a confirmation prompt. Use deterministic
counts/status summaries; an LLM-generated recap is not required.

Host support is not assumed identical: if an app session lacks a particular
history source, use retained supported events and report gaps instead of inventing
history or claiming complete recovery.

## Quiet CLI and Copilot app experience

Use one connection-state policy and host-specific presentation:

- Expected disconnects and retries do not create repeated chat messages.
- Collapse repeated transport errors into sanitized, rate-limited diagnostics.
- Copilot app shows status in the existing Weft panel; do not require it to be open.
- CLI exposes status on demand through `/weft` or a deliberate status command.
  Do not assume a permanent host status badge or transient notification API exists.
- A genuinely actionable failure produces one deduplicated notice with a remedy,
  such as sign-in required, relay not started, or endpoint-refresh scan required.
- Do not auto-open a pairing canvas, print fresh QRs repeatedly, or report each
  failed send as a separate warning.
- User-initiated commands still return explicit errors; quiet recovery is not
  success-shaped failure handling.

Station health, relay health, and individual session reachability are separate.
Keep local prompts, tools, and native approvals working during Weft outages.
Connectivity recovery must not grant permissions or consume an uncertain action twice.

## Code-grounded consolidation recommendation

Follow-up investigation: 2026-11-07. This section is a proposed implementation
boundary, not a new decision to expose device-wide features through `/weft`.

### A session-scoped runtime already exists

`extensionBootstrap.mjs` registers the session hooks, canvas, and local lifecycle
endpoint, then lazily loads `createActiveRuntime` after explicit activation.
`activeRuntime.mjs` is already the session-scoped counterpart to Station: it owns
that session's identity, pairing gate, transport connection, controller, and
shutdown. Same-session reload transfers identity; `/clear` withdraws the old
runtime and starts the replacement dormant.

Calling this a "session Station" is reasonable conceptually, but starting the
existing `createListener` inside every session is not the recommended implementation.
The listener is a device controller, not a generic connection engine.

### Why not embed the complete Station listener?

`createListener` initializes device identity and device utility/terminal adapters.
Its `start` constructs a cross-session coordinator, starts pending-session and launch
watchers, prunes/reconciles launch operations, and binds device-level control
handlers. Its successful pairing sends project lists, session offers, and launch
replays. Injecting a one-session list would not remove those responsibilities.

`createStationSessionCoordinator` integrates global runtime discovery, projects,
launch journals, and process start/resume. The existing `SessionCoordinator` ports
are useful for Station orchestration, but its mandatory launcher/project/directory
dependencies are not a suitable foundation for a single live session's stream.

Mobile also deliberately distinguishes pairing kinds: `addByQr` routes a
`PAIR_KIND.LISTENER` QR into device registration; an ordinary session QR opens a
session. Rebranding a session as a listener would therefore require unnecessary
protocol, storage, and UI changes and could misrepresent its authority.

### What to consolidate

Extract one reusable **paired-endpoint lifecycle** within the extension layer.
It may justify one new module with that stable responsibility, rather than many
small service files or a large Station-with-flags constructor.

Both `createActiveRuntime` and `createListener` compose it with explicit adapters:

| Shared endpoint lifecycle | Session adapter | Station adapter |
| --- | --- | --- |
| Transport creation/replacement, serialized reconnect, and quiet connection state | Existing `session` SDK instance and session identity | Existing device identity and persistent pairing store |
| Pairing gate, grant refresh, handshake deduplication, and stale-generation fencing | Session QR/reload/handoff policies | Device QR/persistent-peer policies |
| Authorized channel attach/detach and lifecycle cleanup | Session stream/control/permission handlers | Device/project/launch/utility handlers |
| Attention lease rules and connection-health presentation hooks | Detail/compact session watches | Device/list/telemetry watches |

Do not merge identity policy: persistent Station identity and session identity have
different lifetimes. Keep the common secure primitives already present in
`shared/pairing.mjs`, `shared/channel.mjs`, and `transportFactory.mjs`; do not replace
them with another encryption or routing layer. Host UI stays in adapters: CLI log/QR
presentation and the app pairing canvas remain distinct.

The endpoint core runs in the existing session extension process for `/weft`, and
in the Station process for `weft start`. It is not another per-session daemon and
does not require Station. Associate resources with the verified session/runtime
identity rather than relying on a PID as the sole scope.

### Separate session lifetime from connection lifetime first

Current code couples these lifetimes:

- `attachRelay` creates `recentTurns`, prompt-origin tracking, activity state, and
  pending permission/elicitation relays when the phone pairs.
- `activeRuntime.teardownRelay` invokes `relay.stop` during reconnect.
- `relay.stop` removes the session event observer and closes pending relays.
- `createPermissionRelay.close` resolves outstanding requests as rejected.
- The next `attachRelay` creates a new in-memory recent-turn buffer. Host history
  cannot necessarily reconstruct the full activity that the old buffer captured.

Therefore connection consolidation alone is insufficient. Preserve three distinct
lifetimes:

1. **Activated session state:** event capture, meaningful history, pending native
   requests, and relevant session state survive a transient connection replacement.
2. **Paired connection:** transport, secure key/stream, subscriptions, and authorized
   controller binding may be replaced on reconnect.
3. **Phone attention:** detail/compact leases can expire without ending either the
   session or its connection.

A transient disconnect or watch expiry must not execute the permanent-session
shutdown path. Pending native requests remain host-authoritative; rebind phone
response handlers where supported, or explicitly return authority to the host
through its supported contract. Do not silently deny or approve merely because
the socket changed. Actual session shutdown, `/clear`, confirmed takeover, and
explicit quiesce still require deliberate cleanup.

### Effect on the agreed command model

No command-scope change is needed:

- `/weft`: one session endpoint using the common core; no global discovery, remote
  launch, device utility initialization, or implicit tunnel provisioning.
- `weft start`: one device endpoint using the common core plus Station features.
- `weft devtunnel start`: explicit machine-wide infrastructure owner/recovery path.

Session-only mode gets the same reconnect, watch, catch-up, and quiet-error policy
without pretending to be a device endpoint. Machine-wide tunnel repair stays with
its explicit owner, so individual session processes cannot compete to reprovision
or stop the shared endpoint.

## Compatibility and implementation sequence

1. **Shared connection state and quiet reporting:** separate Station, relay,
   session, and attention states; remove repeated persistent retry warnings.
   Decouple activated-session capture/pending state from transport teardown, then
   extract the common paired-endpoint lifecycle behind the existing session/device
   entry points.
2. **Background ownership and supervision:** preserve manual entry points and
   explicit direct-session relay startup; serialize manager operations and stops.
3. **End-to-end recovery:** public/local classification, pong/connect deadlines,
   wake handling, same-endpoint hosting, and explicit unrecoverable-endpoint state.
4. **Watch protocol:** additive capabilities, lease controls, mobile visible-scope
   integration, and intentional-silence handling.
5. **Catch-up:** activation-scoped capture, bounded retention, cursor semantics,
   ordered merge, current-state reconciliation, and mobile unread presentation.
6. **Cross-host rollout:** verify both Copilot CLI and app paths, update user
   documentation, and follow the repository's normal release process.

Keep protocol messages, declarations, extension/mobile handlers, and tests aligned.
Negotiate new capabilities explicitly. New laptop/old phone and old laptop/new
phone retain clearly identified legacy behavior; do not silence an older client
that cannot request watches. Preserve existing configuration and pairing storage.

These are implementation phases, not authorization to edit product code, install
background tasks, commit, push, deploy, or create OpenSpec artifacts. No implementation
or release was performed as part of writing this design document.

## Validation plan for implementation

Focused tests should cover:

- Singleton background starts, launch-terminal closure, crash recovery, intentional
  stop, and races between Station and direct-session relay owners.
- Local relay healthy/public forwarding broken, offline timeout, repeated rejected
  probes, authentication expiry, occupied port, and persistent endpoint reuse.
- Half-open sockets, missing pongs, unsettled connects, backoff, and coalesced wake
  recovery without timer-driven restart storms.
- Existing trusted phone reconnecting without a QR, fresh challenge-scoped keys,
  replay rejection, and endpoint refresh without unintended trust rotation.
- Watch start/renew/stop, stale generations, expiry without stop, rapid navigation,
  compact unselected updates, hidden-app silence, and wake past lease expiry.
- Catch-up beyond one page, live/replay races, storage failure, bounded retention
  gaps, session-extension restart, unread correctness, and obsolete approvals.
- Quiet host output during long outages, one actionable notice, both CLI/app
  presentations, and unchanged local Copilot/native-approval behavior.
- Direct operation without Station, Station failure with a healthy relay, and
  compatibility across older phone/laptop versions.

Use injected clocks/transports/process boundaries for deterministic tests, plus
real Windows sleep/hibernate/network-change and launch-terminal-close checks.
Run the repository's required full checks before landing a cross-workspace change.

## External research and limits

- [Microsoft Dev Tunnel FAQ](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/faq):
  recommends reusing tunnels for stable URLs; unused tunnels expire after 30 days
  of inactivity by default.
- [Dev Tunnel CLI reference](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/cli-commands):
  supports hosting an existing persistent tunnel; hosting authentication can expire.
- [Dev Tunnel overview](https://learn.microsoft.com/en-us/azure/developer/dev-tunnels/overview):
  service is preview, without an SLA, and is not recommended for production workloads.
- [Weft pairing contract](pairing.md): saved trust, challenge-response, endpoint
  recovery, explicit replacement, and replay-protected encrypted messages.

The target is automatic recovery from ordinary failures, not guaranteed reachability
while a laptop sleeps or guaranteed availability of an external tunnel service.

## Follow-up: whole-laptop Control Center (design only)

Discussion: 2026-11-07. Implemented and locally validated; not installed or released.

The user's direction is a laptop-level view of everything Weft-related, including
Station/relay management and which local Copilot sessions are connected. Opening
through `weft ui` is acceptable, with a Windows icon providing the same entry point.
The command and icon are proposed additions, not existing installed features.

Recommend a loopback browser UI first, reusing the existing Node/web toolchain and
local pairing-panel security pattern rather than adding a native desktop framework.
A per-user desktop/Start menu shortcut can open the same control center without a
resident tray process. A thin native window or tray integration can be added later
if OS integration warrants it. The finalized implementation plan below selects
loopback browser UI and per-user Windows shortcuts for the first version.

The management backend must be independent of Station so the panel works when
Station is stopped or broken. Reuse authenticated local lifecycle/task-management
functions and verified session discovery, not a second supervisor or remote route.
Bind only to loopback and protect actions with private authorization and Host/Origin
checks. Viewing the dashboard must not activate dormant sessions or start Station.

Show Station and relay health separately, registered projects, pairing status,
actionable recovery errors, and discoverable local CLI/app sessions. Distinguish
session-process liveness, Weft activation, phone connectivity, and attention level;
unknown or stale status is not proof of connectivity. Do not promise arbitrary
unregistered, remote, or cloud-session discovery.

Recommended flow: Windows shortcut or `weft ui` opens/focuses one dashboard;
explicit Start/Stop actions manage Station and the relay. Closing the dashboard
does not stop them. Stopping the shared relay or replacing phone trust requires a
clear impact warning and confirmation. Keep all existing CLI commands and direct
session-only `/weft` operation available; the dashboard is optional.

The user confirmed that this is a decoupled presentation layer for laptop-wide
Weft management, not a new owner of Station, relay, or session lifetimes. Its scope
includes command-backed features beyond service controls, such as registering and
removing project folders, selecting the default project, transport/device settings,
pairing management, and other supported CLI operations.

Use one shared management API/domain implementation behind both CLI and UI.
Keep validation, configuration persistence, authorization, and lifecycle policy
there; do not duplicate command logic in React or parse CLI stdout as an API.
The optional UI host exposes that API locally, while the CLI remains directly usable
without a browser. Additional features should enter the shared layer first and gain
UI controls without changing ownership or `/weft` authority. Destructive commands
must retain explicit confirmation and clearly describe their effects.

Code-grounded refactoring recommendation: `extension/bin/weft.mjs` currently mixes
argument dispatch, terminal output/prompts, and management orchestration. Project
registration, configuration, pairing identity, and background lifecycle operations
already have reusable modules. Reuse those modules and extract only the remaining
management orchestration into a cohesive, import-safe shared API; do not import the
CLI entry point into the UI host.

Keep terminal formatting/readline/process-exit behavior in the CLI adapter. Shared
actions should expose structured results, progress, and explicit setup/confirmation
requirements so a browser never waits on terminal input. The local HTTP adapter
must expose validated, allowlisted operations, not arbitrary shell commands. Both
adapters must use the same ownership/concurrency safeguards. Preserve existing
commands, foreground/background behavior, pairing, and session recovery while adding
focused CLI/API parity tests; this is not a rewrite of the runtime or secure protocol.

Proposed UI interaction: the browser calls an authenticated, same-origin HTTP API
on the loopback UI host. That adapter validates requests and invokes shared Node
management functions; CLI commands invoke those same functions directly without
requiring the UI host. The shared layer uses existing configuration stores, task
management, and authenticated worker/session IPC. This is not a new cloud control
plane or a requirement for an always-running management daemon.

For example, a Start Station action requests a specific allowlisted operation,
reports starting/progress, and reports ready only after authenticated worker
readiness. The initial UI can poll read-only status; push updates can follow if
needed. Worker state and persisted configuration remain authoritative, not browser
state or a separate UI database. Closing or refreshing the browser must not cancel
accepted lifecycle work or replay uncertain destructive actions.

## Final implementation plan: Weft Control Center

Finalized: 2026-11-07. Status: implemented and locally validated.
Installation, commit/push, and release have not been performed.

Implementation record: management orchestration is shared through
`extension/src/management.mjs`; the independent loopback host lives in
`controlCenter.mjs`, presentation in `controlCenterPage.mjs`, and Windows shortcut
integration in `controlCenterShortcut.mjs`. They bundle into the existing CLI,
without a new workspace or mandatory companion service. The shipped Weft icon is
embedded in the bundle and generates the installed shortcut icon locally.

Both CLI and UI use serialized management mutations. Settings edits are validated
before an atomic merged write, and browser edits carry the revision they started
from so a newer CLI change produces an explicit conflict rather than being lost.
Interrupted management locks are reported for deliberate inspection, not
automatically deleted in a race with another process.

Native Control Center testing uncovered an existing worker-lifetime coupling:
the background IPC server was unreferenced, so a Station with no live network
handles could exit despite being ready. Background control now keeps its endpoint
referenced; dormant session lifecycle endpoints retain their unreferenced behavior.
The isolated local-transport Windows Station successfully started and stopped
through the HTTP control API after this correction.

Connectivity is conservative: recent authenticated peer traffic proves contact;
without fresh evidence, a paired session reports unknown link health. Dashboard
inspection never activates a dormant session. Native session launch uses Station's
existing coordinator via authenticated IPC rather than spawning from the UI host.

Control Center validation: the repository-wide run passed 1,320 tests with eight
opt-in skips. The complete Chromium presentation suite passed 22 tests separately,
including real management-API project/settings writes, stale-settings conflict
handling, safe malicious-label rendering, accessibility, and responsive layouts.
Focused final backend checks passed after revision support was added.
Real isolated Windows tests verified HTTP start/stop of a background Station,
shortcut creation/ownership, and packaged installation of the branded icon.
All-workspace builds, mobile type tests, version checks and the configured lint
command passed; the final extension build includes the latest UI.

No installed-client update, production tunnel/phone pairing, commit, push, or
deployment was performed. New-session launch is wired through the existing tested
coordinator; a real user Copilot session was not spawned as a side effect of validation.

### Product and ownership decisions

- Build an optional whole-laptop Control Center, opened with `weft ui` or a
  per-user Windows Start menu/desktop shortcut. Use the default browser, not
  Electron, Tauri, a Windows service, or an always-running tray application.
- Use the existing Node toolchain and local pairing-panel precedent: packaged
  HTML/CSS/JavaScript served locally, with no new application workspace or
  frontend framework required. Reuse visual conventions, not the phone's
  transcript/session application or its remote protocol.
- Keep the UI host independent of Station, relay, and Copilot. Opening the UI
  starts only its local host. Station/relay remain manually started supervised
  workers; no boot/sign-in triggers are added.
- Closing the page does not stop workers or Copilot. Run one verified UI host
  per Weft home, reuse it on repeated opens, and reclaim it after a bounded
  no-client grace period once accepted operations finish. Provide
  `weft ui status` and `weft ui stop`; stopping the UI must not stop workloads.
- Keep existing CLI entry points available with unchanged output and semantics.
  The CLI invokes shared functions directly; it does not depend on HTTP or a
  resident control-plane daemon. Direct `/weft` stays session-only.

### First-version scope

| Area | Included |
| --- | --- |
| Overview | Separate Station, relay, phone, and local-session status; version; actionable setup/recovery errors; last checked time and unknown/stale states. |
| Workloads | Explicit Station and relay start/stop/restart, authenticated readiness, impact warnings, and persistent desired-stop behavior. Report foreground-owned workloads without silently killing or taking ownership of them. |
| Projects | List, register by folder path/name, remove registration, and set default. A browser path field is sufficient initially; removing registration never deletes the folder or terminates its sessions. |
| Settings | Display/change device name, transport, default launch permission mode, pairing mode, terminal access, and existing Files sharing settings. Preserve unrelated configuration. Explain when existing workers need restart; do not silently rotate trust or migrate running connections. |
| Pairing | Current Station QR/status and explicit endpoint refresh/phone replacement. Sensitive payloads are fetched only when that view is opened, not included in general status snapshots. |
| Sessions | Discover/probe local Weft CLI/app runtimes, show verified metadata and supported connection/attention state, explicitly activate/show pairing for a chosen session, and reuse existing Station launch/resume coordination when Station is running. No dashboard chat or terminal emulator. |
| Maintenance | Version/update check and sanitized diagnostics. Keep installation-source overrides, clean-install, internal terminal attach, and automated release commands in the CLI for the initial UI; do not expose an arbitrary command console. |

Launch/resume controls must use the existing session coordinator rather than
introducing a second process-launch implementation. If Station is stopped, show
that prerequisite for Station-owned actions. Read-only local runtime discovery
remains available without Station. Do not advertise remote/cloud discovery.

### Shared contracts and refactoring boundary

Create a cohesive, import-safe management module that composes existing project,
configuration, pairing, lifecycle, and discovery helpers. Move command-independent
orchestration out of `extension/bin/weft.mjs`; leave argument parsing, terminal
formatting, interactive prompts, foreground process ownership, and process exit
handling in the CLI adapter. UI hosting/rendering has a separate stable responsibility.
Do not split every operation into its own module or test file.

Return structured state/results, stable error codes with remedies, and progress.
Report prerequisites such as missing project, sign-in, unsupported host, or explicit
confirmation instead of silently defaulting or awaiting terminal input in the browser.
Sign-in is an explicit setup operation using supported Dev Tunnel authentication;
never put tokens in API responses or alter security policy to make it succeed.

Use existing worker/session identity and IPC authentication. Add minimal read-only,
additive runtime status fields where needed: Weft activation, current transport
connectivity, peer/trust state, watch level, and last verified observation. Current
`activeRuntime.status()` exposes pairing/runtime state but is not sufficient to
claim detailed attention or link health. Status inspection must not activate dormant
extensions, create recovery journals, reveal private keys, or re-pair a phone.

Shared actions need cross-process serialization for conflicting lifecycle/config
mutations, not just a UI button disable. Reuse existing locks where sufficient;
extend safeguards only where code proves a gap. Serialize shared read-modify-write
configuration changes so CLI/UI cannot overwrite unrelated settings.

### Local API and operation behavior

```text
Windows shortcut / weft ui
             |
       Local browser UI
             |
    Authenticated loopback HTTP adapter
             |
       Shared management functions <----- CLI
             |
    Config + verified task/process control + authenticated local IPC
             |
         Station / relay / session runtimes
```

- Bind to loopback on an available port. Verify Host and Origin, use a private
  capability/bootstrap and same-origin authenticated session, and prohibit
  permissive CORS. Reuse the pairing panel's security principles rather than
  copying its session-specific behavior.
- Serve all assets locally. Add bounded JSON requests, strict allowlisted
  operations, validated inputs, safe text rendering, and no third-party scripts
  or arbitrary shell/file-access endpoint. Do not log capabilities, pairing
  payloads, credentials, transcripts, or raw tool data.
- Start with bounded status polling while the page is visible. Suspend routine
  polling when hidden; reconnect and refresh on return. No WebSocket/SSE dependency
  is needed for the first version.
- Long actions return operation identity and progress, not an HTTP request that
  remains open through a multi-minute startup. Readiness comes from authenticated
  worker proof. Duplicate submissions reuse the same accepted request or are
  rejected explicitly; stale stop/config confirmations are revalidated.
- Refresh/close must not replay actions or cancel accepted work. If the UI host
  crashes, reconnect reconciles actual worker/config state; an uncertain result
  remains uncertain until verified, rather than automatically resubmitting.
- Confirmation is enforced server-side and bound to the intended action/target.
  Explain effects: Stop Station leaves relay available but ends Station-owned
  utilities; Stop Relay interrupts dependent links; replacing trust needs a new
  pairing; unregistering a project does not remove source.

### Implementation sequence and gates

1. **Shared management layer and CLI parity.** Extract reusable orchestration,
   structured prerequisites/results, config/lifecycle concurrency safeguards,
   and read-only status aggregation. Route applicable CLI commands through it.
   Gate: focused parity and existing CLI/lifecycle/config tests pass; importing
   it starts no workers, adds no global CLI handlers, and performs no UI work.
2. **Independent UI host and local API.** Add authenticated HTTP adapter,
   verified singleton discovery, operation tracking, bounded idle cleanup,
   browser launch, and `weft ui`/status/stop. Gate: works with Station stopped;
   repeated opens create no duplicate host/workload; unauthorized/cross-origin
   actions fail; accepted actions survive page close and reconcile after failure.
3. **Control Center presentation.** Add Overview, Projects, Settings, Pairing,
   Sessions, and diagnostics/update-check views over the shared API. Include
   setup/error/confirmation flows and additive runtime status where needed.
   Gate: actual folder registration/default/config changes and workload actions
   work through both CLI and UI; viewing sessions never activates them;
   selected-session activation/Station launch uses existing authority checks.
4. **Packaging and Windows entry point.** Package the UI and all assets with
   the centralized release/install layout, embedding assets where practical.
   Keep source installation, published installation, update verification, and
   uninstall consistent. Install one Start menu shortcut; offer a desktop
   shortcut. Both launch the installed command, never a stale port, checkout
   path, or capability-bearing URL. Gate: isolated installation works without
   repository files; shortcuts reopen/reuse UI after host expiry; uninstall
   removes only Weft-owned shortcuts and UI state.
5. **End-to-end validation and handoff.** Run targeted API/CLI/browser tests,
   real scoped Windows shortcut/background checks, then repository-required
   full tests/build/types/version checks and configured lint. Update help,
   setup/privacy docs, and shipped how-to-use guidance together. Report local
   implementation versus installed/published status separately; do not deploy
   or update real pairing/configuration as a side effect of tests.

### Acceptance tests

- From no running Station, open Control Center and register a synthetic folder;
  set its default, change settings, and observe the same results through CLI.
- Start relay and Station through UI; wait for real readiness; close the page
  and launch terminal; reopen and see the same worker identities. Stop Station
  without stopping relay or native Copilot sessions; stop relay with explicit
  impact confirmation and verify it does not resurrect.
- Concurrent CLI/UI starts produce one workload; conflicting stop/start and
  configuration writes preserve intended ownership and unrelated settings.
- Existing foreground workers and stale/mismatched process registries are not
  silently adopted or terminated. Network/auth/setup errors remain actionable.
- Discover dormant, activated, paired-but-disconnected, and watched session
  fixtures without conflating states; old runtimes report unknown unsupported
  fields. Test direct-session operation without Station and existing-session
  activation without a duplicate Copilot process.
- Duplicate clicks, reload during startup, UI-host crash, expired authorization,
  and stale confirmation do not repeat uncertain/destructive operations.
- Cross-origin/Host-forged requests, oversized or malformed payloads, arbitrary
  command names, and HTML/script-bearing labels are rejected or safely rendered;
  private management state is not available to unauthenticated browsers.
- Packaged UI opens from a Windows shortcut without a checkout; UI shutdown/
  idle cleanup does not affect workloads; native/tray dependencies and boot
  triggers are not introduced.

Use existing component/contract test files where appropriate, with consolidated
management and UI-host suites rather than per-action fragmentation. Browser tests
must exercise user flows, not just mocked success screens. Keep native tests scoped
to temporary Weft homes/tasks/projects and clean up their exact owned resources.

# Multi-agent Weft Station: high-level design

Status: draft for discussion; not implemented, installed, or released.
Created: 2026-11-07.
Scope: optional Copilot, Codex, and Claude integrations, centered on Device Station.

This document records confirmed requirements, proposed architecture, user flows,
and compatibility gates. It does not authorize product-code changes, installation,
provider upgrades, background processes, or release. Commands, protocol capability
names, and new screens described as proposed do not exist yet.

## 1. Requirements and decisions

| Status | Requirement or decision |
| --- | --- |
| Confirmed | Users choose which integrations to enable during installation, independently. Do not run unnecessary things on the laptop. |
| Confirmed | Preserve existing Copilot behavior. Multi-agent work must not become a Copilot rewrite. |
| Confirmed | Plan the architecture and user experience before implementation. |
| Confirmed: 2026-11-07 follow-up | Prioritize Station-managed Codex and Claude before native session-by-session integration. Prove the approach locally before recommending the implementation. |
| Confirmed: 2026-11-07 follow-up | Aim for one session with multiple participants, including laptop and phone. Investigate a common abstraction without forcing Copilot through a new runtime. |
| Existing contract | Station starts manually; no boot/sign-in startup. Direct Copilot `/weft` remains usable without Station. |
| Proposed | Keep Copilot as the default for legacy installs and fresh unattended installs; Codex and Claude require explicit opt-in. |
| Proposed | Enabled means permitted to integrate, not a running agent. Load adapters and start processes only for requested work. |
| Proposed | Deliver incrementally: compatibility boundary, optional installation, Codex, then the selected Claude experience. |
| Resolved | Station-managed operation is the initial priority. A laptop participant may be a Weft surface; native Codex/Claude terminal attachment is a separate capability to prove, not a prerequisite to start. |

Do not interpret enabling one provider as enabling another. Do not silently switch
provider, authentication method, model, permission policy, or execution environment
to make a failed operation succeed.

## 2. Current pattern and proposed deviations

The initial inspection found uncommitted resilience work. Treat that work as part
of the integration baseline, not something to reset to an older commit.
The [resilience and Control Center design](resilience-design.md) records reliability
behavior and the separate laptop Control Center plan. Other work progressed in
the checkout during this POC; those unrelated implementation files were untouched.

| Current evidence | Proposed extension; preservation boundary |
| --- | --- |
| `extension/src/extensionBootstrap.mjs`, `startExtensionBootstrap`: Copilot joins its native session, publishes local lifecycle presence, and lazily imports its active runtime. | Keep this bootstrap and its native tools/commands. Do not add Codex/Claude imports, discovery, or startup to it. An explicit Copilot opt-out will need a narrow registration/bootstrap gate, separately validated. |
| `extension/src/stationSessionCoordinator.mjs`, `createStationSessionCoordinator`: existing orchestration composes discovery, runtime control, journals, and a Copilot launcher/store. | Add provider selection at the Station orchestration boundary; retain the current Copilot implementation behind its existing path. |
| `extension/src/spawn.mjs`, `spawnCopilotSession`: native Copilot launch/resume arguments and terminal handoff. | Leave those arguments and identity handoff intact. New providers get their own launch implementations, not executable-name substitution. |
| `extension/src/store.mjs`: Copilot session/history access through its read-only SQLite store. | Do not redirect or reinterpret that store. Other providers own their discovery/history implementations. |
| `extension/src/relay.mjs`, `attachRelay` and `createPermissionRelay`: Copilot events, RPCs, approvals, and history are host-specific. | New adapters emit Weft events and translate their own decisions. Do not fake a Copilot SDK object or reuse its permission-result conversion. |
| `shared/messages.d.ts`: common event envelopes and additive capability fields, but Copilot-specific session/mode assumptions. | Extend negotiated metadata and operations without changing existing Copilot message meanings. |
| `mobile/src/ui/screens/StartSessionScreen.tsx`: device, project/history, permissions, and start/resume; several lookups use bare `sessionId`. | Add a conditional Agent step and provider-aware identity for new clients. Keep the Copilot-only path familiar and prevent cross-provider/device merges. |
| `extension/src/sessionRecovery.mjs`: recovery filenames currently hash `sessionId`. | Namespace new-provider recovery identities before enabling them. Retain existing Copilot caches and cursors rather than rewriting them. |
| `extension/src/transportConfig.mjs`: shared central configuration, with settings-preserving writes. | Add provider selection there using strict validation and serialized mutations. No new environment-variable configuration authority. |
| `scripts/release-layout.mjs`: manifest install schema v1 requires `extension.mjs` and `weft.mjs`; current installers place code under Copilot's autodiscovery directory. | Optional payloads and non-Copilot installs need a deliberate packaging extension. Do not drop optional bundles into the legacy mandatory list or unintentionally register a Copilot extension. |

## 3. Scope

Include one paired Station, shared project registrations, provider-specific Start,
Connect, Resume, chat, supported controls, and native approvals. Reuse existing
encryption, transport, attention leases, and bounded catch-up where applicable.

Exclude arbitrary terminal scraping, keystroke injection, cloud/remote-host session
discovery, provider CLI installation without separate consent, an always-running
service per enabled provider, and a new relay/control-plane service.

The optional laptop Control Center may expose the same configuration and status
later. It is a presentation layer, not a prerequisite for this design or a new
owner of session lifetimes.

## 4. Architecture and ownership

```text
Laptop installer / configuration command
                 |
       Central integration settings
                 |
Phone <== encrypted device channel ==> Device Station
                                         |
                              Requested provider operation
                                         |
                  +----------------------+--------------------+
                  |                      |                    |
          Copilot coordinator     Codex adapter       Claude adapter
          (existing path)         (App Server)        (managed SDK first)
                  |                      |                    |
          Native extension       Session worker      SDK worker
                  |                      |                    |
Phone <========== existing encrypted session channels =========+
```

Station coordinates discovery and lifecycle; it is not a compulsory hop for
session content. Each activated session has its own pairing/controller authority,
watch state, event ordering, and recovery identity.

Copilot remains in its existing extension process. New providers may need a Weft
worker to own their native protocol connection and encrypted session endpoint.
Create such a worker for actual requested work, not for every installed provider.
Workers must have verified ownership and authenticated local lifecycle control.

A Station crash or `weft stop` must not automatically kill native agent sessions or
healthy direct session links. For Station-launched workers, process lifetime must
be independent of the launching Station connection. Losing the native runtime is
not a transport retry: report it, and require explicit resume/restart. Never
automatically repeat a prompt or reopen a terminated agent.

Use a small provider contract with these responsibilities:

| Responsibility | Contract requirement |
| --- | --- |
| Availability | Report installed/configured/version/policy prerequisites separately from liveness. No eager CLI spawning during module import. |
| Discovery | List verified live endpoints and requested saved conversations. Declare when a metadata subprocess is required. |
| Lifecycle | Start, connect, resume, inspect, and close the Weft attachment with structured outcomes and ownership checks. |
| Interaction | Normalize messages, tools, activity, supported controls, and pending native approvals/questions. |
| Capabilities | Advertise only features the selected backend/version actually supports. |

Reuse existing coordinator policy and ports where they fit. Do not force session
streaming through a coordinator requiring global projects and launch ports. Do not
extract/rewrite every Copilot helper just to achieve structural symmetry.

## 5. Installation and resource model

### Selection and persistence

Interactive fresh installation adds one integration-selection step:

```text
Enable Weft integrations on this laptop

[x] GitHub Copilot
[ ] Codex
[ ] Claude

Selected integrations do not launch agents.
Provider tools and sign-in are separate prerequisites.
```

Proposed central configuration shape:

```json
{
  "integrations": {
    "copilot": { "enabled": true },
    "codex": { "enabled": false },
    "claude": { "enabled": false }
  }
}
```

This is an addition to existing configuration, not a replacement file. Preserve
projects, transport, pairing, device name, permissions, terminal, and Files settings.
Missing integration settings retain legacy Copilot behavior and do not opt in new
providers. An invalid explicit selection must produce an error, never "enable all."

Plain reinstall/update preserves selections. Fresh unattended installation defaults
to Copilot only, with explicit installer arguments for other choices. Interactive
selection must not depend on stdin when the installer is piped. The existing
PowerShell/Bash wrappers should delegate validation and code placement to the
shared installer implementation, rather than duplicating provider policy.

Proposed command group: `weft integrations list|enable|disable`. Enabling installs
only the selected Weft adapter and required adapter dependencies. It does not
install/upgrade Codex or Claude, sign in, start Station, or run an agent turn.
The laptop Control Center can call the same management functions when available;
the phone reports local enablement but cannot enable a disabled provider remotely.

### Packaging compatibility

- Keep the legacy Copilot install descriptor, code location, shim, native PTY
  payload, and skill behavior intact for the first Copilot-compatible rollout.
- Publish optional provider payload groups with hashes, compatibility requirements,
  and an installer capability/version gate. Old installers must not accidentally
  download/register all providers through their legacy file-list fallback.
- New installs excluding Copilot require a host-neutral code location. Do not
  place `extension.mjs` in Copilot autodiscovery or install Copilot skills there.
  Final directory/layout details are an installer-design gate, not an implicit
  migration of current users.
- Stage and verify a complete selected payload before changing installed code or
  recording enablement. A failed optional enable must not damage a working Copilot
  installation. Concurrent update/enable operations share install/config safeguards.
- Do not bundle an SDK/native binary for a disabled provider into the mandatory
  Station payload. Selection also controls registration, not just menu visibility.

### What runs locally

| User state/action | Allowed additional work |
| --- | --- |
| Provider disabled | No provider registration, adapter import, store scans, watchers, timers, or Weft-started provider process. User-launched unrelated agents are outside Weft's ownership. |
| Provider enabled; Station stopped | No Station-owned provider daemon. Copilot keeps its current dormant-extension behavior; any future Claude native registration must document its actual idle footprint. |
| Station running, no provider action | Shared Station/relay behavior only; no prewarmed Codex/Claude engine and no provider-wide periodic history scan. |
| Session list requested | Bounded discovery for the requested enabled provider. Reuse a known live worker where possible. |
| Codex saved history requested without a worker | Explicitly show that loading history needs a temporary metadata app-server process; start it only on request, send no model turn, and reclaim it after the operation. Do not invent a stable raw-log parser to hide this cost. |
| Start/Resume selected | Launch only the chosen provider/session, verify readiness, and expose its actual identity. |
| Phone hidden/disconnected | Existing attention policy stops unnecessary application delivery; local agent work may continue. Do not confuse not-watching with agent shutdown. |
| Reboot | No new startup triggers; existing manual-start contract remains. |

Distinguish configured, installed, available, running, Weft-activated, and
phone-connected. "Enabled" is not a green "running" indicator. SDK import helpers
that only inspect local history must be verified not to spawn an engine.

## 6. User flows

### A. Existing Copilot user upgrades

1. Run the existing updater/install entry point.
2. Existing selections, pairing, projects, and direct `/weft` operation remain.
3. No Codex/Claude payload, plugin, engine, or scan is enabled by the upgrade.
4. Phone retains **Start Copilot** and **Resume Copilot** when Copilot is the only
   integration. No extra Agent step, new permission default, or QR requirement.

### B. Fresh multi-agent installation

1. Choose integrations, transport, and device name; review what will be installed.
2. Installer reports each selected integration's prerequisites without starting it.
   Missing CLI, unsupported version, or sign-in is an actionable setup state.
3. Register project folders once; they are shared choices, not copied per provider.
4. Run `weft start`, pair the phone once with Station, and select the laptop.
5. Station reports enabled integrations and capabilities; opening Devices does not
   launch their engines. Provider sign-in remains a laptop/provider-owned operation.

### C. Start from the phone

```text
Laptop -> Agent (when needed) -> Project -> Native permissions -> Start -> Chat

+-----------------------------------+
| Start session                     |
| Laptop: Work laptop               |
| Agent:  Copilot | Codex | Claude   |
| Project: registered folder        |
| Permissions: supported choices    |
|                                   |
| Start Codex                       |
+-----------------------------------+
```

One enabled provider can be preselected without an extra step. Changing provider
invalidates provider-specific permission/model choices; never carry Copilot
`allow-all` into a different provider as an automatic bypass.

After Start, show accepted/launching/connecting progress. A timeout shows
"Checking launch outcome," not a second Start. Reopen the operation by its ID
after phone reconnect. Enter Chat only after an authenticated ready/paired result.
If setup fails, return the concrete remedy without switching to Copilot.

### D. Connect to existing work or resume saved history

```text
Laptop -> Agent/filter -> Active or Saved -> Select conversation

Active, verified Weft endpoint:    Connect/Open, not Resume
Saved, writer verified stopped:   Resume
Native process without adapter:   Setup required / unsupported live attach
Ownership unknown/conflicting:    Explain conflict; no second writer
```

Cards show provider, project, title, and separate agent/phone state. A conversation
already on the phone opens its existing card. A responsive endpoint may be
activated without restarting its agent. Controller replacement retains the
current explicit, revalidated confirmation flow.

Resume means continuing history after the old writer has stopped. A saved
conversation ID alone never proves that an arbitrary running terminal can be
controlled. Where stopped-writer proof is unavailable, block resume with an
actionable local step rather than spawning a competing process.

### E. Chat, approvals, and outages

Keep one chat UI with a provider badge. Stream normalized text/tool/activity events;
show Stop, steering, models, commands, images, and Files only when supported.
Keep Weft's existing shared terminal separate from the agent's native terminal.

The provider creates approval options; Weft relays the decision to the exact
pending request. Do not add "allow for session" where a backend supports only
allow-once/deny. Show argument truncation and never substitute a friendly summary
for the actual action preview.

On reconnect, reconcile current pending requests and ordered catch-up. Historical
approval events cannot become actionable again. No connectivity retry resends
prompts, terminal input, approvals, or native permission changes. PWA suspension
does not guarantee background notification delivery.

### F. Change integrations later

Enable/disable from the laptop using the shared management command/API. An explicit
disable blocks new discovery/start/resume/remote-control operations and removes
future host registration. Preserve native histories, project folders, pairing,
and unrelated integrations.

Disabling is not permission to kill an active native agent. Report any active
Weft attachments or required host reload and use an explicit, provider-supported
detach procedure. Pending native approval ownership must be resolved through its
supported host contract. Do not promise immediate zero footprint while a previously
loaded host integration is still awaiting orderly unload.

Keep cached conversations readable, labeled as integration disabled, without
functional remote-action controls. Disable is not Delete History. Adapter removal
and stopping a Station-owned native engine are separate, explicit actions.

## 7. Provider strategy and research limits

| Provider | Proposed first backend | Important gate |
| --- | --- | --- |
| Copilot | Current native extension and Station implementation. | No event/RPC/approval rewrite required to add another provider. |
| Codex | Weft worker owning the official App Server JSON-RPC connection, preferably stdio for its initial phone-controlled path. | Validate installed-version schemas, approval decisions, history, cancellation, worker lifetime, and writer ownership. |
| Claude | Station-managed persistent Agent SDK runtime first; native mod/channel integration later if justified. | Prove multiple participant input, streaming, approvals, idle overhead, and authentication/distribution terms. |

Codex offers `thread/start`, `thread/resume`, `thread/list`, `turn/start`,
`turn/steer`, `turn/interrupt`, item events, and server-request approvals. Its
documented remote TUI can connect to an app-server, but WebSocket transport is
experimental and unsupported. A native terminal plus phone on the same server
must be proven, including who receives/resolves approvals and how concurrent
controllers reconcile. Independent terminal attachment is not assumed.

Claude mods expose native session, prompt, turn, and tool hooks. Current terminal
documentation requires Claude Code 2.1.287 or later; the installation inspected
during research was 2.1.220. No upgrade has been performed. A mod's own hook wait
budget is 10 seconds and failed/timed-out hooks can be skipped: a long arbitrary
promise awaiting phone approval is not a safe native permission relay.

Claude channels document native approval relay but remain research preview with
custom-channel and organization restrictions. Channel inputs queue rather than
proving mid-turn steering; channel replies are not full native transcript streaming.
Neither mods nor channels should be presented as feature-complete until prototyped.

The Agent SDK supports persistent streaming input, native approval callbacks,
images, explicit session resume, and interruption. It starts/owns its runtime,
not an arbitrary existing terminal. Use explicit saved IDs for multi-session
Station work, not "continue the latest in this folder." Anthropic's SDK guidance
restricts third-party use of claude.ai login/usage without prior approval; confirm
the intended distribution/authentication model before promising subscription use.
Claude's first-party Remote Control is not a documented Weft client API.

## 8. Identity, permissions, and protocol compatibility

The new internal conversation key must include verified device scope, provider,
store authority, and native conversation ID. Runtime instance/generation/process
start identity identifies the live writer separately. Never deduplicate across
providers or laptops by bare session UUID, folder, title, or PID.

For Codex, use `thread.id` as the conversation ID: `thread.sessionId` can identify
a shared root across forked threads. For Copilot, retain its native session ID and
current authority conventions. Preserve legacy phone cards, recovery filenames,
and cursors; namespace new entries and migrate old metadata only when association
is unambiguous. No deletion/re-pairing as a migration shortcut.

Propose a `providers-v1` discovery/open capability with provider descriptors and
explicit provider/authority in new requests. New providers also need separate
native permission choices and opaque history cursors where applicable; do not
reinterpret numeric Copilot turn indices. Keep old operations Copilot-scoped.

Non-Copilot discovery/operations require an explicit authenticated provider-aware
client request after pairing. Do not infer client support or authorization from
the QR's advertised version, a pre-key field, or successful connection alone.
Unknown provider IDs are errors, not legacy Copilot defaults. Revalidate local
enablement and ownership at execution, not just when the phone renders a button.

| Laptop/phone combination | Required behavior |
| --- | --- |
| Old Station + new phone | Existing Copilot controls; no speculative provider selector. |
| New Station + old phone | Legacy Copilot lists/commands only; never advertise or reinterpret another provider through those messages. |
| New Station + new phone; Copilot only | Same Copilot UX/defaults and no new-provider initialization. |
| New Station + new phone; several providers | Negotiated descriptors, provider-aware identities, and supported controls. |
| Copilot disabled + old phone | Explicit unavailable/update guidance; never start Copilot or substitute another provider. |
| Adapter missing, unsupported, or failed | That provider unavailable with a remedy; healthy Copilot and Station operations continue. |

Reuse ECDH/AES-GCM pairing and secure channels unchanged. Native authentication
stays local. No provider tokens, pairing credentials, raw reasoning, or private
transcript/tool copies in diagnostics or release/config artifacts.

Files/Changes need both central Weft sharing authorization and the provider's
supported native access boundary. Copilot's existing path checks and native
workspace-approval tool remain unchanged. If another backend cannot enforce the
necessary boundary, omit Files/Changes instead of reading directly around it.

## 9. Copilot protection and rollout gates

No design can guarantee zero regressions before implementation. Make these
invariants release gates, not just a claim that common interfaces are compatible:

- Copilot-only users retain install/update, native registration, `/weft`, CLI QR,
  app canvas, Start/Resume, permissions, commands, images, history, and Files.
- Dormant Copilot sessions gain no new-provider import/process/scan/timer/journal.
- Direct Copilot pairing works without Station; Dev Tunnel remains explicitly
  started for that path. No implicit Station/tunnel provisioning in `/weft`.
- Local Copilot prompts/tools/approvals continue when Station or transport fails.
- Copilot clear/reload, controller confirmation, launch recovery, and resume
  writer checks preserve existing authority. No duplicate native process.
- Old phones and existing local pairing/history/configuration remain supported.
- Optional adapter failure, disabled provider, and invalid provider-specific
  setup cannot crash or change a working Copilot session.

### Incremental sequence

1. **Freeze the actual baseline and compatibility fixtures.** Preserve current
   resilience changes; establish real CLI/app and mixed-version expected behavior.
2. **Add optional selection/packaging.** Retain legacy defaults, gated registration,
   install integrity/rollback, and no-start enablement. Test provider-only installs
   without Copilot registration before claiming that choice is supported.
3. **Add negotiated identities and Station dispatch.** Exercise Copilot through
   unchanged behavior and mock optional adapters. Gate all new-provider lists/actions
   behind explicit client support and namespace every cache/reservation/card key.
4. **Prove Codex end to end.** Start, prompt, approval, stop, reconnect, saved resume,
   unknown-writer blocking, temporary history-process cleanup, and isolated failure.
   Treat shared native TUI control as a separate experimental gate.
5. **Implement Station-managed Claude.** Native mod/channel and SDK-hosted
   operation are not interchangeable. Prove one persistent runtime shared by
   laptop and phone participants before promising native terminal parity.
6. **Validate and release deliberately.** Run focused suites, repository-required
   full checks, mixed versions, isolated installation/update, and actual phone +
   Copilot CLI/app smoke journeys. Follow the existing release process; no automatic
   workstation install/update, push, or hosted release from this planning task.

Concentrate focused cases in existing stable contract/component suites rather
than adding a test file per provider action. Relevant existing suites include
bootstrap, spawn, store, relay, lifecycle/coordinator, workspace, CLI update,
release/install transactions, and mobile start/resume/deduplication/scenarios.

Specific regression cases: Copilot only with optional binaries absent; a failing
optional adapter; identical native IDs on two providers/laptops; legacy-message
attempts against disabled Copilot; phone refresh during launch; stale approval
after reconnect; config change during launch; failed optional payload install;
and disabled-provider startup with zero provider imports/processes/watchers.

Use temporary Weft homes, fixture projects, scoped processes/tasks, and disposable
install paths. Tests must not modify the user's installed providers, pairing, or
active sessions. Measure actual idle process/import/timer footprint rather than
treating hidden UI controls as proof that nothing runs.

## 10. Remaining decisions

Discuss one major decision at a time:

1. Provider readiness failures at install: retain the explicit selection as
   "setup required," or require prerequisites before completing enablement?

The first-release priority is now resolved: Station-managed Codex and Claude, with
a common session/participant boundary explored by a local proof of concept.
Do not ask the user to select a backend already resolved by that direction.

### Follow-up: common session and participants

Propose one provider runtime per managed conversation, with a Weft session owner
normalizing events and coordinating authorized participant actions. Station launches
and discovers that owner; the owner survives a transient Station or participant
disconnect. A laptop Weft UI and the phone attach to the same conversation rather
than starting or resuming separate provider processes.

Separate three interfaces: provider runtime (prompt/events/interrupt/native
requests), session owner (ordered events, input arbitration, request resolution,
snapshots), and participant transport (local laptop connection or paired encrypted
phone connection). Share those interfaces between Codex and Claude. Leave Copilot's
native extension and existing participant authority untouched initially.

The proof of concept must distinguish actual provider execution from mocked
transport/participants and report missing authentication or unsupported capabilities.
Use a disposable synthetic workspace, not a registered/private repository, for
model prompts. Do not change installed provider configuration or production pairing.

#### Proposed common abstraction

| Layer | Owns | Must not own |
| --- | --- | --- |
| Provider runtime | Native conversation/turn IDs, provider process or connection, native streaming, permission/question translation, supported cancellation. | Phone pairing, participant identity, UI routing, or starting a separate conversation for each participant. |
| Managed session owner | One logical conversation, ordered normalized events, participant input arbitration, native-request correlation, snapshots/catch-up, and verified lifecycle. | A second agent loop, model reasoning, or universal permission policy. |
| Participant transport | Authorized laptop or phone attachment, participant-scoped action IDs, event delivery/cursors, and disconnect/reconnect. | Provider process ownership or independent resume of the same native conversation. |
| Station | Enablement, registered projects, requested discovery/launch, and locating the existing session owner. | Recreating the conversation when a participant or Station connection disappears. |

The managed-session interface should support attach/snapshot/events, submit input,
resolve a current native request, interrupt a specific turn, detach a participant,
and explicitly end the managed runtime. Attachment closure and runtime termination
are different operations. Capability negotiation determines which controls exist.

Start with serial, participant-attributed queued prompts on both providers. Multiple
participants may submit, but only one normal provider turn runs at a time. A
duplicate action from a reconnecting participant is deduplicated by its stable
action ID and payload; an ID reused with changed content is a conflict. Distinguish
queued, accepted by the provider, running, completed, and uncertain outcomes.
Provider-specific in-flight steering is optional, not equated with queueing.

Pending approvals/questions have native correlation, allowed decisions, and a
single atomic claim. An authorized laptop or phone can answer; a competing or late
answer receives an explicit already-resolved/stale result. Claiming an action is
not proof of native completion: confirm resolution with the provider and expose
uncertain delivery without automatically sending a second answer.

Disconnecting a participant does not decide a permission request. Native
cancellation/turn end invalidates the action on every surface. The initial trusted
scope should be the owner's laptop and paired phone, not invitations to arbitrary
people; multi-user enrollment/roles require a separate authorization design.
Observer, prompt-submission, approval, and disruptive control permissions should
be explicit even if the first release grants them to the same owner.

Use a small laptop Weft participant UI over authenticated loopback control and the
phone over its existing encrypted transport. Both render the same session stream.
This gives laptop/phone participation without depending on native TUI attachment
or Claude mods. Native provider terminals can be an additional advertised
participant only after their concurrent connection/approval behavior is proven.

One logical runtime per conversation does not require one OS process universally:
Codex may multiplex threads in an app-server, whereas Claude's SDK typically owns
a subprocess per persistent query. The abstraction must not force unnecessary
daemons or identical process topology. No engine is prewarmed for every historical
session card; capacity and idle-resource policy follow measured provider behavior.

Recommended minor choices recorded in this draft: shared project registrations,
Copilot-only compatibility defaults, explicit provider-aware protocol, no eager
prewarming, provider-local authentication, and preservation of cached history on
disable. These are recommendations, not newly confirmed user decisions.

## 11. Local proof of concept and recommendation

Executed: 2026-11-07 on Windows. Sources and JSON results are retained as session
artifacts in `weft-managed-poc`, not added to Weft product code.

The POC uses real Codex CLI 0.166.0 App Server and Claude Agent SDK 0.3.316 with
its isolated Claude Code 2.1.316 binary. The workstation's existing Claude
installation was not upgraded. Provider homes and working directories were
disposable; the model endpoint was a deterministic HTTP/SSE fixture bound to
loopback. No real LLM, private repository, provider account, or paired phone was
used. This is an engine/protocol POC, not a deployed product demonstration.

| Check | Evidence and boundary |
| --- | --- |
| Shared conversation | Both real engines accepted laptop-attributed input, then phone-attributed input in the same native conversation and provider launch. The second model request contained the earlier marker/context. Responses came from the fixture, not LLM reasoning. |
| Live text | Both engines produced normalized text deltas and final assistant messages. Both local participant handles read the same session owner and history. |
| Reattachment | A simulated phone detached/rejoined without starting another engine or changing the native conversation ID. No actual network/pairing reconnect was exercised. |
| Native approvals | The fixture requested a synthetic write. The real engines raised native permission requests; the laptop participant answered and a competing phone answer was rejected as stale. The target file was not created. |
| Native decision semantics | This Codex request offered Accept, an exec-policy amendment, and Cancel; it did not offer Decline. Cancel denied the write and ended the turn. Claude's callback supported Deny. A shared abstraction must retain these differences. |
| Stop | Phone-attributed interruption stopped laptop-started streaming work through both native control interfaces. Claude returned `error_during_execution` with an execution diagnostic after interruption; do not assume Stop yields a normal successful result or match an English error string to classify it. |
| Concurrent input and duplicate actions | Contract-fixture tests proved serialized overlapping participant submissions, exact retry deduplication, conflicting retry rejection, and observer restrictions. The real-provider context probes used sequential input; native multi-client simultaneous TUI behavior is not certified. |
| Pending request lifecycle | Contract-fixture tests preserved a pending request across participant detach/rejoin and allowed only one decision. Permanent session close rejected queued input instead of launching a new runtime. |
| Resource ownership | No provider launch before the first session input; one launch per tested managed session, not one per participant. An initial Codex launcher-wrapper cleanup race was corrected by owning the native child directly and awaiting shutdown. Final provider process checks found no POC engine left running. |

Final POC suite: five passing cases. Synthetic provider homes/workspaces, temporary
schema generation, and dependency payloads are cleaned up; reproducible sources,
dependency lockfile, and result records remain. No Weft product code, installed
configuration, real pairing, or production worker was modified by this POC.

### Recommendation

Proceed with **Station-managed conversations plus a shared session owner**, using
Codex App Server and a persistent Claude SDK streaming query behind separate
provider adapters. Make the laptop's initial participant a lightweight Weft UI,
not an independent native process resuming the same history. Add native TUI
participation later behind a proven provider-specific capability.

```text
Station: choose provider/project and create or locate a managed session
                              |
                     One session owner
                      /             \
             Laptop Weft UI     Paired phone
                              |
                   One provider conversation
```

The common abstraction is the conversation and participant contract, not the
provider's SDK, process topology, approval vocabulary, or full feature set. Keep
Copilot's current path outside this new managed runtime until a separately scoped
compatibility migration is actually justified.

Next implementation gate: a thin laptop participant plus the real encrypted phone
transport attached to this owner, with durable action/native-request reconciliation
and authenticated participant roles. Then test real authenticated models, process
restart/resume, install selection, and Copilot CLI/app compatibility. The local POC
does not establish those outcomes or remove the SDK authentication/terms gate.

## Official research references

Read on 2026-11-07; documentation can be newer than installed tools. These sources
establish candidate APIs, not an end-to-end Weft integration result.

- [Codex App Server](https://developers.openai.com/codex/app-server):
  lifecycle, streaming, approvals, history, remote TUI, and transport limitations.
- [Codex TypeScript SDK](https://github.com/openai/codex/tree/main/sdk/typescript):
  streaming and saved-thread resume; not a substitute for native live attachment.
- [Claude mods reference](https://code.claude.com/docs/en/plugins/mods/reference)
  and [mods overview](https://code.claude.com/docs/en/plugins/mods/overview):
  native extension surface, versions, and hook limits.
- [Claude channels reference](https://code.claude.com/docs/en/channels-reference):
  inbound events, native approval relay, and preview/allowlist requirements.
- [Claude Agent SDK streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode),
  [permissions/user input](https://code.claude.com/docs/en/agent-sdk/user-input),
  and [sessions](https://code.claude.com/docs/en/agent-sdk/sessions).
- [Claude Agent SDK overview](https://code.claude.com/docs/en/agent-sdk/overview):
  authentication/distribution constraints and branding guidance.
- [Claude Remote Control](https://code.claude.com/docs/en/remote-control):
  first-party continuation, not a documented third-party Weft interface.

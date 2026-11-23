# Station-managed Codex and Claude: low-level design

Status: implementation proposal; no multi-agent product implementation is claimed.
Date: 2026-11-07.
Parent: [Multi-agent Station HLD](multi-agent-station-hld.md).
Source checkout: `C:\Users\kumarashish\weft`.
Committed baseline: `305b0d3e8ad0451b009fe3efa08c3ad6e181e30c` plus inspected working-tree changes.

This design incorporates the current Control Center, management API, background
lifecycle, pairing, attention, and recovery code, including files that were
uncommitted during inspection. Thirty-two relevant source files were initially
fingerprinted. A later check detected concurrent management/discovery improvements;
those changes and their batch process-verification helper were reread and incorporated.
The final source snapshot covers thirty-three files. This is a local-checkout
baseline, not a statement about installed or hosted releases.

All new APIs, modules, paths, limits, and capabilities below are proposed unless
explicitly labeled current. The earlier POC exercised real provider binaries with
a loopback model fixture and simulated participants. It did not certify real
phone transport, authentication, native TUI attachment, or restart/resume.

## 1. Implementation decisions and scope

Implement Station-managed Codex and Claude first. One managed conversation has one
session owner; laptop and phone are participants in that conversation, not separate
SDK sessions. A laptop Weft chat surface is the first local participant. Native
Codex/Claude terminal attachment is a later provider-specific capability.

Copilot remains on its native extension path. Its bootstrap, relay, store,
permission decisions, launch arguments, direct `/weft`, and legacy protocol are
not replaced by this owner. A generic agent-selector UI is not permission to merge
the three runtime implementations.

First managed slice: text prompts, attributed chat, streamed text/tool status,
queued input, current native permissions/questions, Stop, participant reconnect,
explicit saved-conversation Resume, and bounded catch-up. Images, Files/Changes,
native TUI attachment, multi-human invitations, and arbitrary non-Weft
native-session adoption are not advertised until their own boundaries are
implemented and verified. Existing Copilot features remain available.

V1 follow-up (2026-11-07): saved-work Resume is explicitly required. UI actions
must distinguish Open/Connect (same live writer), Resume (reopen stopped history),
and Open in Terminal (only a proven native attachment capability). A session ID
alone never authorizes launching a competing writer.

The native laptop experience is an important product expectation raised in this
follow-up, not fulfilled by labeling SDK-hosted chat "Claude Code terminal."
Codex's native remote-TUI path should be evaluated for v1. Claude's documented
`claude attach` applies to native supervisor-managed background sessions; the
current SDK `query` backend has not been proven attachable that way. A native
background-session/Weft bridge prototype is required before promising parity.
The SDK package's alpha `/bridge` export inspected at 0.3.316 connects to
claude.ai/CCR cloud sessions using ingress credentials; it is not evidence of a
local supervisor attach API suitable for replacing Weft's encrypted transport.
This follow-up records the gap; it does not silently select an unvalidated backend.
References: [native Claude attachment](https://code.claude.com/docs/en/agent-view#attach-to-a-session)
and [SDK 0.3.316 bridge declarations](https://unpkg.com/@anthropic-ai/claude-agent-sdk@0.3.316/bridge.d.ts).

Recommended defaults: Copilot-only legacy/unattended installation; opt-in optional
adapters; shared project registrations; no prewarming; native provider settings
and authentication; same-owner laptop and paired phone. These are implementation
recommendations, not additional confirmed user requirements.

## 2. Current-code integration constraints

| Current source | Observed contract | Consequence for this implementation |
| --- | --- | --- |
| `extension/src/management.mjs:27`, `:62`, `:194`, `:273` | Strict action allowlist; global management lock; settings revisions; Copilot launch via Station; coalesced in-flight state reads. | Extend management for integration configuration, but never send participant prompts or wait for approvals while holding this lock. Preserve state coalescing rather than adding overlapping discovery. |
| `extension/src/controlCenter.mjs:102`, `:158`, `:175` | Authenticated loopback HTTP; 64 KiB JSON body limit; memory-only operation map capped at 128; five-minute idle host. | Reuse authentication/hosting, not the volatile operation map as the managed action journal. Add separate managed routes and explicit stream teardown. |
| `extension/src/controlCenterPage.mjs:149`, `:583` | Plain packaged HTML/JS; one management operation UI; polling the same operation ID after uncertain delivery. | Add a local participant panel with a separate chat action/outbox model. Do not turn chat into management polling or introduce another frontend workspace. |
| `extension/src/backgroundLifecycle.mjs:18`, `:219` | Background roles are specifically Station and relay; control uses existing lifecycle commands. | Do not add a Scheduled Task per session or register managed owners as a new legacy role. Add explicitly routed managed launch control. |
| `extension/src/sessionRegistry.mjs:32`, `:416` | Session record schema/`sessions-live` directory v1 and link states; discovery scans that directory. | Managed owners need a separate registry namespace. Capability tagging alone cannot keep old Station/Control Center readers from discovering them. |
| `extension/src/management.mjs:170`, `extension/src/processIdentity.mjs` | Current dashboard/target discovery requests batch process verification with `cleanup: false`. | Managed status follows the same read-only, batched verification pattern; do not spawn a Windows shell per session or delete registries while rendering a dashboard. |
| `extension/src/sessionControl.mjs:17`, `:21`, `:125` | Fixed protocol v1, fixed command allowlist, one request per connection, 64 KiB frame limit. | This endpoint is not a session-event bus. Keep its defaults untouched; managed IPC gets an explicit separate protocol/endpoint. |
| `extension/src/openSession.mjs:41`, `:291` | Default authority derives from Copilot SQLite; both launch paths call `launchCopilotSession` (`terminalLauncher.mjs`) through the injected launcher. | Dispatch before entering this coordinator. Do not substitute an executable or a provider field inside it. |
| `shared/messages.mjs:266`, `:276` (`normalizeOpenRequest`) | Normalization constructs Copilot new/existing targets, strips other fields, and normalizes to `default`/`allow-all`. | New managed intents and fingerprints must not pass through this normalizer. Reuse policy concepts, not incompatible serialized records. |
| `extension/src/openRequests.mjs:82`, `:90` | Open-request records are stored through the same normalizer and a per-session reservation lock. | Managed launch/action receipts need their own schema and reservations. Do not decorate legacy receipts and assume provider identity survives. |
| `extension/src/pairedEndpoint.mjs:4`, `:29` | Serialized pairing callback and one attention lease instance. | Reuse per phone attachment. Do not treat one lease/channel/key as a multi-peer hub. |
| `shared/channel.mjs:9`, `:87` | One send stream and one accepted receive stream per SecureChannel instance. | One SecureChannel per authorized phone attachment; laptop traffic enters through authenticated local IPC, not another sender on that channel. |
| `extension/src/relay.mjs:120`, `:550`, `:768` | Native Copilot permissions, workspace-policy RPC gating, detach/rebind distinct from session shutdown. | Preserve the Copilot path. New adapters own native translation and keep provider lifetime separate from participant lifetime. |
| `extension/src/sessionStreamStore.mjs:39`, `:113` | Filename hashes bare session ID; capture filters existing stream envelopes; three-day/10 MiB/2,000-event retention. | Namespace managed recovery and add an explicit managed-event projection. New control events would otherwise not be retained. |
| `mobile/src/lib/sessions.ts:185`, `mobile/src/session/runtime/sessionRuntime.ts:1403` | Bare native `sessionId` deduplication can remove a second card and its stored transcript. | Do not place managed native IDs into this legacy reconciliation path. Add managed identity and explicitly scoped reconciliation. |
| `mobile/src/session/access/sessionAccess.ts:107`, `mobile/src/ui/screens/StartSessionScreen.tsx:163` | Legacy intent/default handling and lookup by native session ID. | Add managed access methods/selection branches; preserve the existing Copilot branch and permission defaults. |
| `scripts/release-layout.mjs:19`, `extension/esbuild.config.mjs:69` | Legacy install v1 requires Copilot extension and CLI bundles; sibling entrypoints derive from the mandatory list. | Optional workers cannot simply be added to that list. Separate optional component build/install metadata from legacy mandatory bundles. |
| `extension/test/bundleEntrypoints.test.mjs:38` | Sibling spawn checks currently equate spawnable code with mandatory release bundles. | Extend coverage to selected optional components without weakening existing mandatory-bundle assertions. |

Source line anchors describe this inspection, not stable API versions. The HLD
research references remain the authority for candidate external APIs; use schemas
generated by the actual Codex binary and installed Claude SDK types at implementation.

## 3. Components and dependency boundary

```text
                    CLI / existing Control Center
                                 |
                    Management: configuration/launch
                                 |
Station device channel -> managed launch/discovery coordinator
                                 |
                    Managed session worker/owner
                     /           |            \
             local IPC       provider adapter   phone attachment
                 |               |                    |
       Control Center chat   Codex App Server      SecureChannel
       authenticated HTTP    or Claude SDK         encrypted relay
                 |                                    |
       Laptop participant                        Phone participant

Copilot extension -> existing relay -> existing encrypted phone session
```

Logical responsibilities justify these proposed modules; do not create a separate
file per operation:

| Proposed module | Responsibility and dependencies |
| --- | --- |
| `shared/managedMessages.mjs` and `.d.ts` | Browser/Node DTOs, validators, normalization, feature constants, and identity helpers. Export through existing shared indexes with matching runtime/type exports. No SDK/process dependencies. |
| `extension/src/managedSessions.mjs` | Provider descriptor metadata, enablement-aware discovery, managed create/open/resume orchestration, and on-demand worker launch. No top-level provider SDK imports. |
| `extension/src/managedSession.mjs` | Owner state, participants, queue, native-request arbitration, normalized event delivery, and recovery projection. Provider injected through a typed/JSDoc contract. |
| `extension/src/managedSessionStore.mjs` | Private managed catalog, launch/action receipts, reservation/owner claims, revisions, and atomic persistence. Separate from Copilot launch and recovery identities. |
| `extension/src/managedSessionHost.mjs` | Worker entrypoint, authenticated IPC server/client, managed presence, native process ownership, and phone endpoint composition. No Copilot SDK object. |
| `extension/src/codexProvider.mjs` | Versioned executable resolution, App Server JSON-RPC, thread/turn events, native request/decision mapping, and shutdown. |
| `extension/src/claudeProvider.mjs` | Lazy SDK load, persistent streaming input query, SDK events/callbacks, explicit resume, interruption, and shutdown. |

Keep provider-specific code outside the Copilot bootstrap/active-runtime bundles.
Static metadata may be common; lazy SDK and executable loading happens only for a
requested enabled provider. The built CLI may retain its current small Copilot
management helpers; that is not permission to include optional SDK/native payloads.

Control Center uses the same managed coordinator as CLI/Station. It does not own
an agent or resume a conversation on every browser refresh. It proxies authenticated
participant requests/events to an existing owner. Its five-minute host shutdown
must detach the laptop participant, not stop the agent.

## 4. Core data contracts

These definitions specify the proposed shape, not existing exports:

```typescript
type ManagedProviderId = "codex" | "claude";
type ManagedSessionState =
  | "starting" | "idle" | "running" | "waiting-input"
  | "interrupting" | "stopped" | "failed" | "ownership-unknown";

interface ManagedSessionRef {
  deviceId: string;
  providerId: ManagedProviderId;
  storeAuthority: string;
  weftSessionId: string;
}

interface OwnerRef {
  runtimeInstanceId: string;
  generation: number;
}

interface ManagedSessionDescriptor {
  ref: ManagedSessionRef;
  owner: OwnerRef | null;
  nativeConversationId: string | null;
  state: ManagedSessionState;
  title: string | null;
  cwd: string;
  capabilities: string[];
  revision: number;
}

interface ParticipantAction {
  session: ManagedSessionRef;
  expectedOwner: OwnerRef;
  actionStreamId: string;
  clientSequence: number;
  actionId: string;
  command:
    | { kind: "prompt"; text: string; delivery: "enqueue" }
    | { kind: "interrupt"; nativeTurnId: string; expectedTurnRevision: number }
    | { kind: "decision"; requestId: string; requestRevision: number; optionId: string };
}
```

Use strict discriminated validators: finite safe integer counters, canonical UUID
IDs where appropriate, recognized provider/command IDs, bounded strings, and no
unrecognized command fields. Never coerce an unknown provider to Copilot or a
permission mode to an auto-approval policy.

Conversation key is a canonical encoding of the full `ManagedSessionRef`.
`weftSessionId` is assigned before native startup and remains stable across explicit
owner restart/resume. `nativeConversationId` is metadata, not a mobile card key.
Codex uses `thread.id`, not the shared fork/root `thread.sessionId`.

Derive store authority from the canonical provider history/configuration root plus
provider ID, with Windows path normalization equivalent to `deriveStoreAuthority`.
Do not derive it from a title, current directory alone, login email, or secret.
Version changes do not change conversation identity.

Generate owner instance identity and increment a durable generation under the
session reservation. Do not rely on `nextRuntimeGeneration`'s process-local map
for cross-process restarts. Presence also records PID and process start time;
authenticate and verify both, not PID liveness alone.

## 5. Private stores and ownership

Proposed data placement under the existing Weft home:

```text
~\.weft\
  weft.config.json                  existing central settings
  managed\v1\
    catalog.json                    descriptors, no transcripts or tokens
    launches\<operationId>.json      launch/resume receipt
    sessions\<sessionHash>\
      state.json                    ref, native ID, owner/code revision
      actions.json                  receipts and action-stream high watermarks
      reservation                   owner claim, not an approval credential
    runtimes\<runtimeInstanceId>\
      presence.json                 metadata and endpoint
      capability                    private IPC capability
  recovery\managed-v1\              managed meaningful-event caches
```

IDs used as filenames must be validated or hashed; caller-provided paths never
select a registry directory. Private capabilities/pairing handoffs remain in
private files/handles, never catalog entries, `/api/state`, events, URLs other than
the existing deliberate Control Center bootstrap, or diagnostics.

Managed runtimes do not publish in `runtimes\v1`, `pending-sessions.json`, or
Copilot attached-session registries. Old discovery would otherwise select them
without understanding their provider. Reuse process-verification and atomic-write
patterns; do not copy the entire legacy coordinator and relabel its records.

Reservations serialize create/resume for a conversation across Station, CLI, and
Control Center. Re-read claims inside the lock. An old claim with an unverifiable
owner is `ownership-unknown`, not permission to unlink it or spawn another writer.
Proven stopped claims may be retired through a revision-checked operation.

Keep status discovery read-only (`cleanup: false`) and batch process birth checks
using the current `verifyProcessIdentities` helper. One coalesced state request
does not launch a shell for each session. Registry retirement happens in explicit
ownership/lifecycle reconciliation, not routine dashboard refresh.

Write receipt/high-watermark changes atomically before acknowledging an accepted
action and before native side effects. Use supported file sync where durability
requires it. Atomic rename is not a transactional guarantee with the provider or
an unconditional power-loss guarantee.

Action records retain command kind/fingerprint, actor/stream identity, sequence,
owner generation, state, native correlation, and sanitized outcome. Queued prompt
text and image/tool payloads are not placed in the receipt journal. Keep queued
text in bounded memory; after an owner crash, undispatched text must be explicitly
resubmitted from the participant, not replayed automatically.

Current native approval payloads/callbacks are memory-only owner state. Persisting
a receipt does not make an old callback executable after restart.

## 6. Provider enablement, setup, and installation

Add strict `loadIntegrationConfig` / `saveIntegrationConfig` helpers to the current
configuration module. Shape remains the HLD's `integrations.<provider>.enabled`.
Missing whole section means Copilot on, Codex/Claude off. An explicit malformed
section is a configuration error; never treat it as opt-in.

Extend the management settings revision to include integration choices, and
preserve all unrelated keys. Add allowlisted configuration actions using
`withManagementLock`; do not expose executable path/authentication selection to
phone requests. CLI configuration and Control Center call the same functions.

Provider descriptor distinguishes:

```text
configuredEnabled
adapterInstalled
prerequisiteState: unchecked | ready | setup-required | unsupported | error
supportedCapabilities
activeManagedSessions
```

Reading descriptors/state does not spawn an engine, import an optional SDK, log in,
scan native history, create a recovery cache, or contact a model. A selected provider
can remain explicitly `setup-required` without enabling another as fallback.
Version/authentication checks occur during an explicit local setup operation or
requested launch; cached readiness carries observation time and is revalidated.

### Installation transaction

Retain current legacy `manifest.install` schema v1, mandatory bundles, and default
Copilot directory/shim. Propose separate top-level `componentInstallV1` metadata for
common managed worker and optional Codex/Claude payload groups, including hashes,
minimum installer capability, platform, and compatible component versions.

Old installers consume the legacy descriptor only. Never publish a managed release
without that explicit descriptor: `releaseInstallFiles` otherwise enumerates
top-level `.mjs` files. Optional components must not be silently pulled into its
legacy fallback.

For fresh installs excluding Copilot, modern placement uses a host-neutral code
root: `%LOCALAPPDATA%\Weft\app` on Windows; corresponding user-local application
data roots on macOS/Linux. Do not put a discoverable `extension.mjs` or Copilot skill
in `.copilot` for those selections. Keep the existing Weft data home separate.
Existing Copilot users are not automatically relocated.

Use versioned optional code directories and an active install descriptor. A running
owner pins its code/component version; an update changes the next-launch pointer,
not that process's SDK files. Cleanup cannot remove an active owner's payload.

Enable flow: validate selection -> stage/download only selected payloads outside
the management lock -> verify complete checksums/layout/platform -> acquire install
lock then short management lock -> compare original settings revision -> commit
code pointer/enablement -> report setup/readiness. No engine or sign-in starts.
Document/repair interrupted commit state; do not roll back another operation's
newer configuration. Existing update paths must share the same lock order where
they touch optional install state.

The SDK's bundled native binary is a selected adapter dependency, not a global
provider upgrade. Codex's executable comes from a supported, explicitly configured
local installation. No downloaded script/CLI location is accepted from the phone.
Never copy provider credentials into Weft configuration, installer manifests,
Scheduled Task arguments, or pairing. Background tasks do not reliably inherit
the caller terminal's transient environment; require provider-supported setup and
report absent credentials rather than harvesting another process's environment.

### Disable with active sessions

Inactive disable removes future registration/loading and blocks launch/attach.
An active owner is not silently killed or denied a pending request.
Proposed active-session policy requires explicit local confirmation between
**disable future sessions only** and **end managed sessions and disable**; until
chosen, return `active-sessions-require-decision` without changing the setting.
Future-only preserves existing grants until those sessions end and clearly reports
that resources still run. End-and-disable performs the verified termination flow.
This active-disable UX is a product confirmation gate, not a promise of immediate
zero footprint or an implicit override of the HLD's access-withdrawal intent.

## 7. Create, open, and resume

Managed launch intent is separate from `OpenIntentMsg`:

```typescript
interface ManagedLaunchIntent {
  operationId: string;
  providerId: ManagedProviderId;
  target:
    | { kind: "new"; projectName: string }
    | { kind: "managed"; session: ManagedSessionRef };
  nativePermissionProfileId: string | null;
  name: string | null;
}
```

The coordinator derives requester identity from authenticated local/phone context,
not a caller's `requesterId`. Canonical fingerprint includes provider, full target,
permission profile and name. New reservations use operation ID; existing
reservations use the composite session key. Same ID/changed fingerprint fails.

```text
accepted -> validating -> reserved -> worker-starting -> provider-starting -> ready
                    \                \                     \
                     failed           outcome-unknown        setup-required/failed
```

Detailed sequence:

1. Check negotiated managed support and local enablement; validate intent.
2. Resolve registered project on the laptop and revalidate directory. Never trust
   the phone's informational path as the launch directory.
3. Persist launch receipt; claim reservation and allocate Weft session identity.
4. On demand spawn one worker with a private launch handoff. Verify native startup
   separately from Node/process spawn success.
5. Install native observers before accepting input. Persist native conversation ID
   and owner generation; publish authenticated managed presence.
6. Mark ready only after worker identity, provider initialization, and required
   native policy/configuration have been verified.
7. Attach laptop or deliver the requested phone pairing handoff through authorized
   control. Pairing failure does not launch another provider.

HTTP/local IPC timeout changes the caller to inspect/reconcile the same operation.
It does not reissue startup. If startup was reserved but native acceptance cannot
be established, retain `outcome-unknown`; do not claim rollback or retry success.

Open first finds an exact live owner and adds/reconnects a participant. It does not
call native resume. Explicit Resume is allowed only after the previous worker and
native writer are proven stopped, with no conflicting reservation. Increment
owner generation, reopen the saved native conversation, rebuild state/history,
and invalidate old actionable requests.

Initial resume catalog contains Weft-managed conversations, not every native CLI
history item. A separate explicit history-load operation may start a temporary
metadata-only Codex App Server, with no model turn and verified teardown. Unowned
native history cannot be resumed merely because its ID appears on disk; writer
proof/adoption is a later capability. Copilot keeps its current native history flow.

## 8. Provider runtime interface

Contract vocabulary used below:

```typescript
type ProviderAcceptance =
  | { status: "accepted"; nativeTurnId: string | null }
  | { status: "unknown"; reasonCode: string };

interface ProviderObservedState {
  nativeConversationId: string;
  nativeTurnId: string | null;
  state: ManagedSessionState;
  pendingNativeRequestIds: string[];
  failureCode: string | null;
}

interface NativePendingRequest {
  nativeRequestId: string;
  nativeTurnId: string | null;
  kind: "tool-permission" | "permission-grant" | "question" | "elicitation";
  preview: { title: string; text: string; truncated: boolean };
  options: Array<{
    id: string;
    label: string;
    effect: "allow" | "deny" | "cancel-turn" | "grant-subset" | "answer";
  }>;
}

interface NativeDecision {
  optionId: string;
  answer: ValidatedQuestionAnswer | null;
}

type ValidatedQuestionAnswer =
  | { kind: "form"; action: "accept" | "decline" | "cancel";
      values: Record<string, string | number | boolean | string[]> }
  | { kind: "choices";
      answers: Array<{ questionId: string; optionIds: string[]; freeText: string | null }> };

type NormalizedProviderEvent =
  | { kind: "text-delta"; nativeMessageId: string; text: string }
  | { kind: "message-final"; nativeMessageId: string; text: string }
  | { kind: "tool-state"; nativeToolId: string; name: string;
      state: "running" | "completed" | "failed" | "declined"; preview: string | null }
  | { kind: "turn-state"; nativeTurnId: string; state: ManagedSessionState;
      failureCode: string | null }
  | { kind: "request-resolved"; nativeRequestId: string }
  | { kind: "runtime-ended"; reasonCode: string };
```

`ValidatedQuestionAnswer` is validated against the current native question schema,
including allowed options, cardinality and free-text policy, not arbitrary `raw`
JSON. Forms beyond the initial scalar/array field vocabulary are an explicit
unsupported capability until their renderer/validator is added. Option-only
permissions use `answer: null`. Numeric/string native IDs are normalized consistently
inside each adapter without losing native response correlation. The owner assigns
canonical event IDs and participant attribution after normalization.

```typescript
interface ProviderOpenOptions {
  cwd: string;
  nativeConversationId: string | null;
  nativePermissionProfileId: string | null;
  onEvent(event: NormalizedProviderEvent): void;
  onRequest(request: NativePendingRequest): Promise<NativeDecision>;
}

interface ProviderRuntime {
  nativeConversationId: string;
  capabilities: string[];
  submit(text: string): Promise<ProviderAcceptance>;
  interrupt(nativeTurnId: string): Promise<ProviderAcceptance>;
  inspect(): Promise<ProviderObservedState>;
  close(): Promise<void>;
}
```

`ProviderAcceptance` distinguishes confirmed acceptance from an unknown delivery
outcome; rejection is an explicit structured failure. Accepted interrupt does not
mean the turn has already stopped. Owner readiness/turn completion comes from
observed native state, not elapsed time or HTTP success.

Native request/decision payloads are private adapter handles with a known
provider-specific schema. Participant DTOs contain bounded display data and opaque
option IDs, not arbitrary native response objects. Do not use `unknown` casts or a
fake Copilot session to make adapters fit.

### Codex

Start the native executable with App Server stdio; resolve the actual supported
native binary instead of depending on an npm launcher wrapper's process lifetime.
Generate/validate protocol bindings against the selected binary version.
Perform `initialize` then `initialized`; create/resume the requested thread once.

Map `turn/start` to queued submission; `turn/started`, item lifecycle/text deltas,
and `turn/completed` to observed owner events. Retain actual item/turn IDs.
`turn/interrupt` is an owner-authorized, turn-specific request. `turn/steer` stays
unadvertised until its participant ordering semantics are separately verified.

Map shell/file permission requests, permission grants, user-input questions, and
MCP elicitations separately. Preserve each request's available decisions, including
parameterized policy amendments as server-side option handles. The POC's shell
request offered Cancel but not Decline; never manufacture Decline or session-wide
acceptance. Permission subset grants cannot exceed the native requested subset.

Unknown required server requests produce an explicit unsupported response and
visible actionable failure, not auto-approval or indefinite silent waiting. Native
`serverRequest/resolved` / turn end retires the current ticket across participants.
Avoid exposing raw reasoning text in event normalization or caches.

### Claude

Lazy-load the selected Agent SDK, start one `query` with a persistent async input
queue, and continuously drain its output. Feed both participants into that queue.
Do not create another query/session per participant or use "continue latest folder."
Explicit resume supplies the exact native ID.

Production options must preserve native project behavior: selected working
directory, appropriate Claude Code system-prompt preset, provider-native
user/project/local settings and applicable managed policy. The POC's empty settings,
synthetic system prompt, and loopback credentials are isolation fixtures, not
production defaults. Explain any intentionally narrowed tool/MCP configuration.

Correlate user input acknowledgements, result session IDs, text/tool events,
permission callbacks, and question callbacks. Advertise capabilities only after
the selected SDK version's actual event/input support is proven.

`canUseTool` is invoked only after native rules/modes have not already decided.
Weft does not turn it into universal tool interception. An allow decision passes
the original typed input and only a specifically selected native permission update.
Do not show Cancel as a normal callback decision if the native callback supports
Allow/Deny only. Callback abort signals cancel the current ticket; they must not
leave its promise or UI card live forever.

Track requested interrupts separately from observed terminal results. The POC
received `error_during_execution` with a diagnostic after interrupt. Preserve that
native result and correlation; do not classify every error during a stop as
successful cancellation, and do not match English diagnostic text. Auth, tool,
policy, or transport failures remain failures.

The SDK authentication/distribution terms gate still applies. Neither the POC nor
existing user CLI login establishes permission to distribute subscription-backed
SDK access. Provider sign-in is a local setup concern.

## 9. Session owner, participants, and action arbitration

Participant identity comes from the authenticated attachment:

- Phone: exact trusted peer binding established by pairing plus server-side grant.
  A claimed `senderId`, device name, or participant ID in the envelope is not proof.
- Laptop: authenticated Control Center session plus owner-local grant. Tabs have
  separate connection/action streams even when the browser cookie/user is shared.
- Same user may have multiple surfaces. New human enrollment/invitations are not
  implemented by accepting another display name or channel sender.

Rights are explicit: `observe`, `submit`, `decide`, `interrupt`, `configure`.
Initial owner laptop/phone may receive the first four; provider setup/permission
profile changes remain explicit local management actions. Observer clients cannot
gain mutation rights by changing a JSON field.

```text
Provider: starting -> idle -> running -> waiting-input -> running -> idle
                           \-> interrupting -> observed idle/stopped
Any state -> failed/stopped/ownership-unknown on verified native/lifecycle events

Participant: authorized -> attached -> watching(detail/compact/off)
                        -> disconnected -> reauthorized/rebound
Participant loss does not transition Provider to stopped.
```

`waiting-input` may contain several concurrent native tickets; resolving one does
not make the owner idle if the native turn remains active. Queue depth, native turn,
pending tickets, provider state, transport state, and attention are separate fields.

### Prompt/action algorithm

1. Authenticate, validate full identity/generation/rights and encoded size.
2. Validate registered `actionStreamId`, positive `clientSequence`, and action UUID.
   Look up existing receipt before checking whether its owner generation is now
   stale; completed old receipts are readable, never redispatched.
3. Same stream/sequence/action ID/fingerprint returns its current receipt.
   Changed payload is `action-conflict`.
4. Maintain a persisted highest admitted sequence per registered action stream.
   If a sequence is already below that watermark and its detailed receipt has been
   pruned, return `receipt-expired`, not "new action." Reject gaps/out-of-order
   submissions and require reconciliation. Do not evict this proof to make room for
   a stale retry within an active owner generation.
5. Persist admission/high watermark before acknowledging or enqueueing. Enforce a
   per-conversation queue bound before acceptance. Keep prompt payload in memory.
6. Serialize normal turns through one queue. Persist `dispatching` before calling
   the adapter. Bind its native acceptance/turn ID to the receipt when available.
7. Native events update running/completed/interrupted/failed states. Return
   `delivery-unknown` if transmission occurred but native acceptance is unproven.

Do not hold a filesystem/config lock throughout a model turn. A small per-owner
mutation gate serializes journal updates and claims, not network waits. Participants
can read state and answer requests while a turn is running.

Receipt state:

```text
admitted -> queued -> dispatching -> native-accepted -> running -> completed
          \cancelled-before-send          \interrupted/failed
                     \delivery-unknown
```

Exactly-once provider execution is not promised: a crash between native send and
receipt update is a distributed uncertainty. On restart, reconcile known native
IDs/history where supported; otherwise require user review. Never automatically
resubmit the same prompt or approval after that boundary.

### Native request algorithm

Create a ticket containing owner generation, native turn/callback correlation,
request revision, display preview, and allowed option IDs. Keep each exact native
decision mapping inside the adapter. Snapshot only current authoritative tickets.

```text
pending -> claimed -> native-response-sending -> native-resolved
             \                         \resolution-unknown
Any nonterminal ticket -> cancelled-by-native / invalidated-with-owner
```

An authorized decision must match current owner, ticket revision, allowed option,
and active native correlation. Atomically claim and persist its receipt before
native submission. A competing client gets `already-claimed`/`already-resolved`
and the latest snapshot. "Claimed" is not shown as successfully approved until
the provider confirms its response or equivalent native completion.

Cancellation may race claiming; the serialized owner transition checks native
cancellation before sending and fences stale callbacks. A timeout returns pending/
unknown status, never an automatic allow/deny. Participant disconnect does not
close a native permission promise. Owner termination uses supported native
interrupt/close and invalidates tickets; old receipts cannot resurrect them.

## 10. Local IPC, phone protocol, and laptop routes

### Managed IPC

New endpoint prefix: `weft-managed-<runtimeHash>` on Windows named pipes; private
managed sockets under the Weft run directory elsewhere. Managed protocol is
explicitly versioned independently of lifecycle v1.

Authenticated frames carry capability, full session/owner identity, request ID,
command, and validated payload. Compare private capabilities safely and verify
process birth/owner generation before contacting/controlling an endpoint.

Commands: `probe`, `describe`, `attach`, `watch`, `snapshot`, `action`, `receipt`,
`detach`, and confirmed `end`. A command connection remains bounded and returns
an operation/receipt; it does not wait through the agent turn. Event subscriptions
use a separate explicitly subscribed persistent connection with cancellation,
backpressure, and liveness handling. Do not extend the legacy one-frame socket
into an implicitly persistent connection.

### Phone capability and operations

Keep SecureChannel cryptography/protocol version unchanged. Add authenticated
post-pair negotiation for `providers-v1` discovery and `managed-session-v1`
participant behavior. Server advertisements do not prove client support.

Proposed control subtypes:

| Subtype | Direction and shape |
| --- | --- |
| `provider_request` / `provider_result` | Phone/Station; request ID plus allowlisted discovery or managed launch/open operation and structured result. |
| `managed_hello` / `managed_ready` | Participant/owner; supported version, action stream, authorized rights and descriptor. |
| `managed_action` / `managed_receipt` | Participant/owner; typed action and durable receipt/status, not legacy prompt/decision reinterpretation. |
| `managed_snapshot_request` / `managed_snapshot` | Participant/owner; current state/tickets, meaningful recovery boundary, and per-client checkpoint. |
| `managed_event` | Owner/participant; validated normalized event with IDs/actor/native correlation and meaningful recovery position when applicable. |

Managed endpoints send no transcript/actionable state until the authenticated client
negotiates support. An old phone accidentally scanning such a QR receives explicit
upgrade/unsupported guidance and no control rights. Legacy Station lists/offers and
`spawn_session`, `resume_session`, `open_session` remain Copilot-only. Unknown managed
operations never fall through to `handleLegacyOpen`.

Phone attach requests are routed through Station's managed coordinator. Device
pairing and session pairing are distinct; handing off a session endpoint does not
reuse Station's encryption key or global controller identity for chat.

### Existing Control Center host

Add separate authenticated managed routes, for example:

```text
GET  /api/providers
POST /api/managed/launch
GET  /api/managed/launches/<operationId>
GET  /api/managed/sessions
POST /api/managed/sessions/<sessionKey>/attach
GET  /api/managed/sessions/<sessionKey>/snapshot
GET  /api/managed/sessions/<sessionKey>/events
POST /api/managed/sessions/<sessionKey>/actions
GET  /api/managed/sessions/<sessionKey>/receipts/<actionId>
POST /api/managed/sessions/<sessionKey>/watch
POST /api/managed/sessions/<sessionKey>/detach
```

Reuse current Host/Origin checks, HttpOnly same-origin cookie, no permissive CORS,
private bootstrap, no-store headers, safe text rendering, and allowlisted JSON.
Route keys are validated composite-key encodings/hashes, not filesystem paths.
Management state contains summaries only; transcript access requires a session
attachment and observe rights. Do not feed raw chat/tool data into management
diagnostics or the page's general error-message sanitization path.

Use same-origin SSE for local events with bounded frames and HTTP POST for actions.
Do not put authorization in EventSource query strings. Reconnection requests a
snapshot/checkpoint; SSE byte delivery is not proof of durable application receipt.
Long chat actions return receipts promptly, outside `/api/operations`' memory map.

Track active local stream responses and participant leases. Visible chat renews its
lease; hidden tabs stop detail watches. Explicit UI-host shutdown closes those
responses/IPC attachments before `server.close`, otherwise a persistent SSE stream
could prevent shutdown. UI idle cleanup never waits for or cancels an agent turn.
Reopening the UI reauthorizes/reattaches to the owner without native resume.

## 11. Event normalization, catch-up, and storage

Normalized events have canonical event/message/tool IDs, optional native IDs,
participant attribution, owner generation, and observed state. Preserve native
message finalization: a final assistant message replaces its accumulated deltas,
not an additional duplicate message. Text is rendered safely.

Assign meaningful-event positions separately from transient delta positions:
token deltas, heartbeat, and ephemeral thinking indicators do not create holes in
the durable journal. A persisted user message references its accepted action ID
and actor so optimistic phone/local echoes reconcile by identity, not by text.
Tool summaries are retained without raw argument/result copies.

Current `createSessionRecovery` does not accept the proposed managed control
events and contains Copilot-specific sanitization. Add a narrowly injected
projection/directory namespace with unchanged Copilot defaults, or implement the
managed projection in the new store using existing persistence primitives.
Do not claim that simply passing a managed envelope retains it.

Recommended managed limits mirror current recovery: three days, 2,000 meaningful
events/10 MiB per conversation. An initial separate managed aggregate budget must
be explicit; it must not silently double an advertised machine-wide budget or
evict Copilot caches to admit managed work. Combined quota policy is a release gate.
Active action receipts/ticket state cannot be pruned by transcript-cache eviction.

Snapshot/catch-up sequence:

1. Serialize an observed state snapshot with revision, current tickets and a
   meaningful-journal boundary.
2. Read bounded pages from the participant's committed epoch/cursor.
3. Buffer live meaningful events beyond that boundary and merge by canonical ID.
4. Persist transcript/cursor together on the participant; only then advance its
   committed checkpoint. Track viewed progress separately.
5. If epoch changed or retention creates a gap, expose it and restore current
   authoritative state. Historical permission events are never actionable.

A snapshot with lower state revision cannot replace newer live state; retained
events are scoped to session identity and recovery epoch. Participant disconnect
or watch expiry leaves capture and the native runtime intact.

Storage failure for new action receipts prevents native mutation and returns
`journal-unavailable`. Recovery-cache failure may keep the current native turn/live
stream available with an explicit gap/notice, but cannot masquerade as durable
action acceptance. Diagnostics remain sanitized and content-free.

## 12. Mobile and laptop state/UI changes

Add optional discriminated managed metadata to current session records:

```typescript
interface ManagedSessionMeta {
  kind: "managed";
  ref: ManagedSessionRef;
  owner: OwnerRef;
  nativeConversationId: string | null;
  participantId: string;
  capabilities: string[];
}
```

Keep current `SessionMeta.kind` (`live`/`demo`/`spawning`) semantics; managed metadata
is an additional field, not a replacement enum. Do not populate legacy
`SessionMeta.sessionId` with a Codex/Claude native ID. Add managed reconciliation
by full managed reference and explicit channel history; legacy
`reconcileBySessionId` must exclude managed cards. Update stored-record guards and
reducers together before any new managed channel can be persisted.

Introduce managed access methods alongside `RuntimeSessionAccess`, not a native
provider field that its current normalizer drops. Store managed launch receipts
and participant outboxes separately from legacy `weft.sessionAccess.v1` operations.
Outbox commands bind action stream/sequence/action ID and expected owner; replay
means receipt inspection, not automatic execution after an unknown native result.

Managed envelopes are validated and routed before legacy `applyEnvelope` handling.
New ready/snapshot events establish the existing host-confirmation gate through an
explicit branch; they must not call bare-session-ID reconciliation. Render common
timeline components from normalized events and adapt approval/question cards to
native option handles/claimed/resolved states.

Start flow: Laptop -> Agent (only if needed) -> shared registered project -> native
supported permission profile -> Start. Copilot-only users keep current labels and
defaults. Switching agent clears incompatible permission/model selections.
Resume/open maps use managed keys for managed cards and the current Copilot branch
for Copilot. No cross-device/provider merge by title, folder, or UUID.

Laptop Control Center adds a managed-session chat panel, not another global
management modal or a standalone browser daemon per conversation. It shows the
same queue, actor attribution, current requests, Stop state, and unread/checkpoint
semantics as mobile. A user may start from either surface and join the same owner
from the other without a new agent process.

Initial images/Files controls are absent for managed sessions. To add Files later,
both central sharing policy and the backend's native read/approval boundary must
be enforceable. Direct Node reads are not an acceptable shortcut around the missing
Copilot-style RPC. Existing Copilot Files/Changes remain untouched.

## 13. Resource, failure, and concurrency rules

Suggested initial protocol safeguards, subject to actual payload tests:

| Boundary | Proposed safeguard |
| --- | --- |
| Local action JSON | Existing 64 KiB encoded-body bound; text-only prompts additionally bounded to 32 KiB UTF-8. Encoded-size rejection is explicit. |
| Managed IPC | Separate explicit maximum, e.g. 256 KiB, so a bounded snapshot/recovery page fits; legacy IPC stays 64 KiB. |
| Native inbound frames | A documented finite parser bound; oversize is an actionable provider protocol failure, not unbounded buffering. |
| Queued input | Bounded per conversation; reject before receipt acceptance rather than silently dropping the oldest prompt. |
| Participant live delivery | Bounded per-connection queues; coalesce same-message deltas. Slow client triggers resync/gap, not provider restart. |
| Attention | Reuse 60-second lease, 20-second renew, five-second leave cooldown and laptop-side bounds from current code. |
| Metadata discovery | Requested provider/scope only; temporary native process has an explicit owner and verified teardown. |
| Provider startup | One coalesced launch per reservation; no retry that creates another native writer after uncertain acceptance. |

Do not force identical native process topology. One Codex App Server may support
several threads later, while a Claude streaming query owns its subprocess. The
initial correctness slice may use one worker per active managed conversation; no
worker exists merely for an enabled provider or a historical card. Memory/idle
capacity policy requires measured real-engine behavior before setting product caps.

Lock order: optional install lock -> short management configuration lock where
needed; managed session reservation/journal locks are separate. Never acquire an
install lock while holding management lock, or keep either across native turns.
Input/decision/interrupt state mutations serialize in the owner. No process launch
or destructive confirmation is protected only by a disabled UI button.

| Failure/race | Required outcome |
| --- | --- |
| Two surfaces create with same operation ID | Same fingerprint returns same receipt; changed request conflicts. |
| Two surfaces open one live conversation | Two authorized attachments to one owner; no native resume. |
| Station dies, worker/relay healthy | Managed work/participant traffic continues. Later Station discovers the exact owner. |
| UI host dies | Local attachment drops; phone/native runtime continue. UI reauthorization reconnects to the owner. |
| Native writer dies | Stop accepting mutation, mark verified failure/stopped, retain receipt/history; explicit resume only. |
| Owner dies while native process survives | Mark ownership unknown, fence old capabilities and block resume until writer is proven stopped. |
| Configuration disables provider during validation | Revalidate before launch/attach. Apply the explicit active-session disable policy, not a silent native kill. |
| Decision and native cancellation race | Serialized current-ticket check; stale decision rejected; no resurrected callback. |
| HTTP/relay acknowledgement lost after submission | Inspect receipt; do not blindly repeat native call. |
| Old frame arrives after reconnect | Reject retired owner/connection generation or old SecureChannel stream; snapshot newer state. |
| Process PID is reused | Process birth/owner identity mismatch; never terminate the unrelated process. |
| Model/credential/policy error | Provider-specific setup/failure; no fallback model/provider or permission escalation. |
| Old phone/Station | Legacy Copilot-only path; managed capability not inferred from successful pairing. |

Windows owner/native-child cleanup is a real implementation gate. The POC found an
npm wrapper lifetime race; owning the native child directly fixed that test, but it
did not certify every descendant/tool process. Prove supported process-group/job
ownership and terminate only verified owned processes. An orphan/unverifiable tree
blocks restart rather than triggering name-based kills or duplicate execution.
Do not add boot triggers or automatic owner/native resurrection to solve this.

## 14. Implementation sequence and tests

| Slice | Task-owned changes and gate |
| --- | --- |
| Contracts/selection | Shared managed DTOs/validators; integration helpers and revision-aware management configuration. Gate: malformed/disabled providers fail explicitly; importing descriptors starts nothing; Copilot defaults unchanged. |
| Managed store/IPC/owner | Private namespace, reservations, durable action streams/receipts, typed IPC and participant state. Gate: races, crash boundaries, pruned receipt replay, stale generations, observer denial, and no second writer. |
| Codex adapter | Version/executable/protocol binding and native decision maps. Gate: real authenticated synthetic workspace, streaming, approvals including Cancel-only requests, interruption, clean process tree, explicit resume. |
| Claude adapter | Optional SDK packaging, persistent queue, native callbacks/result correlation. Gate: real authenticated synthetic workspace, project settings, permissions/questions, abort signals, error-after-interrupt, clean process tree, explicit resume. |
| Laptop participant | Existing Control Center auth/routes/page, separate managed action UI and SSE. Gate: page close/host expiry never ends agent; unauthorized scope/Origin fails; attachment resumes without native query creation. |
| Phone participant | New negotiation/access/envelope branches, managed identity/storage/timeline/requests. Gate: real encrypted laptop+phone journey plus replay/order/cursor persistence and old-peer compatibility. |
| Optional release placement | Component manifest/build/payload verification, neutral non-Copilot install, selected dependency registration/update. Gate: clean disposable install without checkout; optional failure leaves Copilot intact. |
| Release certification | Full repository checks and actual Copilot CLI/app smoke journeys against the installed build, plus version combinations. A successful source POC is not certification. |

Extend existing stable suites for management settings, Control Center auth/lifetime,
session identity/reducers, build/install layout, and Copilot parity. Add consolidated
managed-owner/store/IPC and provider-adapter contract suites, not a file per action.
Keep native/provider tests opt-in and scoped to disposable homes/projects/processes.

Required managed-specific cases:

- Two simultaneous queued prompts, independent participants/action streams, exact
  duplicate, payload conflict, sequence gap, and retry after receipt pruning.
- Receipt persisted before native send; crash before send, after send/before ack,
  after native completion/before response; no exactly-once fiction.
- Multiple pending native requests, duplicate decision, native cancellation during
  claim, resolution acknowledgement loss, callback abort, and old snapshot replay.
- Owner/participant/control-center/Station shutdown independently; orphan child
  detection; PID reuse; reconnect with an old owner generation.
- Snapshot/live ordering, final-versus-delta merge, journal retention gaps, storage
  failure, hidden attention leases, and unread versus committed cursors.
- Identical native IDs on two providers/devices and managed/Copilot collisions;
  no removal of another card, transcript, pairing, or timer.
- Disabled provider, absent SDK/binary, invalid selection, setup-required install,
  failed optional payload, update while owner pins its old component, and no eager
  engine on installer, descriptor read, Control Center open, or Station start.
- All existing Copilot behaviors with optional SDKs/binaries absent; direct `/weft`
  without Station; CLI QR/app canvas; native approvals, mode/commands/images/Files;
  clear/reload, launch recovery, and old phone/new Station compatibility.

Required implementation checks remain `npm test`, `npm run build`, `npm run lint`,
`npm run check-version`, and mobile type-test coverage for cross-workspace changes.
Documentation checks alone do not prove Copilot runtime compatibility. No installed
provider, pairing, private repository, real user task, or hosted release is changed
as a side effect of design validation.

## 15. Remaining gates, not hidden assumptions

Before shipping: confirm the active-disable UX, combined recovery quota, measured
idle process/capacity policy, provider authentication/distribution model, and
cross-platform native-child ownership. Resolve substantive user-facing choices
one at a time; do not reopen the confirmed Station-managed-first decision.

Before native TUI support: prove multi-client native subscriptions, approval
ownership, control arbitration, and reconnect on the actual supported provider
versions. Until then, "laptop and phone share one session" means the laptop Weft
participant and paired phone, not two independent native CLI writers.

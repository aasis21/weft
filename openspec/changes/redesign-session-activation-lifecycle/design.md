## Context

Weft has two intentional remote-control paths:

1. Device Station is a machine-wide bridge that allows the phone to discover projects and sessions and to start or open them.
2. `/weft` explicitly activates one Copilot session and displays a QR that can be paired without Device Station.

There is no requirement for the phone to control the laptop when neither path is running.

The current extension nevertheless loads substantial pairing infrastructure in every Copilot session. It imports the full bundled runtime, generates a key pair, resolves the configured transport, opens a durable session log, and prints startup messages before the user asks for Weft. Device Station also cannot identify an ordinary live terminal until `/weft` has been invoked or a phone has paired. If the phone selects that session from persisted history, Station may launch another `copilot --resume` process.

The redesign must make inactive sessions quiet while allowing a running Device Station to activate the exact existing terminal process selected by the phone.

## Goals / Non-Goals

**Goals:**

- Make dormant Weft extensions silent, offline, and inexpensive.
- Keep Device Station as the only machine-wide remote bridge.
- Preserve direct `/weft` QR pairing.
- Let Station discover every compatible live Copilot session.
- Activate an existing terminal session in place instead of duplicating it.
- Preserve phone-started session launch and recovery.
- Enforce one writer or launch reservation per logical session.
- Centralize lifecycle decisions and expose structured outcomes.
- Recover safely after Station, extension, phone, transport, or terminal failures.
- Support additive mixed-version rollout.

**Non-Goals:**

- Run a permanent daemon.
- Give dormant extensions remote subscriptions.
- Allow phone operations without Station or direct QR pairing.
- Add remote-machine migration or multiple simultaneous phone controllers.
- Preserve the phone connection across `/clear`.
- Prevent manual duplicate raw Copilot commands outside Weft.

## Decisions

### Device Station owns machine-wide lifecycle coordination

Device Station already owns the encrypted machine channel used for phone Start and Resume. A `SessionCoordinator` module inside Station becomes the sole authority for:

- operation IDs and request fingerprints;
- target reservations;
- deciding reconnect, activate existing, Resume, or Start;
- runtime discovery and validation;
- takeover challenges;
- launch recovery;
- structured status and failures.

The module has injected filesystem, runtime-directory, process, launcher, project-catalog, session-catalog, identity, clock, and diagnostic adapters so policy is testable without a running Station.

```ts
interface SessionCoordinator {
  open(intent: OpenIntent): Promise<OperationSnapshot>;
  confirmTakeover(challengeId: string): Promise<OperationSnapshot>;
  cancel(operationId: string): Promise<OperationSnapshot>;
  inspect(operationId: string): Promise<OperationSnapshot | null>;
}
```

The mobile runtime exposes the same product concept through `SessionAccess`. Screens request “open this project/session/QR” and render lifecycle state; they do not choose spawn versus Resume or parse error text.

### Split the extension into bootstrap and active runtime

The installed `extension.mjs` is a bootstrap containing only:

- Copilot SDK session join;
- `/weft` command registration;
- runtime/process identity;
- presence-file management;
- one local lifecycle endpoint;
- explicit handoff detection;
- lazy import of the active runtime.

The separate active-runtime bundle contains QR, cryptography, transport resolution, Supabase, Dev Tunnel, relay, pairing, permission forwarding, history, reconnect, and active diagnostics.

The bootstrap loads the active runtime only for:

- `/weft`;
- a Station activation command;
- a phone Start/Resume handoff;
- recovery of an already-active extension after a normal extension reload.

While dormant it emits no output and performs no transport, crypto, QR, diagnostic, network, heartbeat, or retry work.

### Use filesystem for persistence and a local pipe for live communication

Filesystem state and live IPC solve different problems and are both retained.

Each runtime owns:

```text
~/.weft/runtimes/v1/<runtime-id>/
  presence.json
  capability
```

`presence.json` contains only non-secret discovery and ownership metadata:

```ts
interface RuntimePresence {
  schemaVersion: 1;
  storeAuthority: string;
  sessionId: string;
  terminalInstanceId: string;
  runtimeInstanceId: string;
  generation: number;
  pid: number;
  processStartedAt: number;
  endpoint: string;
  state: "dormant" | "activating" | "active" | "degraded";
  capabilities: string[];
  updatedAt: number;
}
```

The sibling `capability` file contains a random local authorization value and is readable only by the current user. Private session pairing identity is stored separately and is never present in discovery metadata.

The endpoint is:

- Windows: `\\.\pipe\weft-runtime-<runtime-id>`
- macOS/Linux: a Unix-domain socket in `~/.weft/run/`

Both use Node's `net.createServer` and `net.connect`. Messages are bounded, versioned JSON frames. The first request proves the capability token, runtime ID, generation, and session ID.

The dormant extension does not watch or poll files. Device Station scans presence on startup, session-list refresh, and Open. It uses the pipe for:

- `probe`;
- `activate`;
- `status`;
- `replace-controller`;
- `quiesce`.

Station connections are temporary. After activation or a query completes, Station disconnects; the extension retains only its idle listener.

### Define and enforce the idle budget

For each dormant extension:

- one presence directory with bounded small files;
- one local endpoint handle;
- no active pipe client;
- no timers or polling;
- no remote sockets;
- no active diagnostics;
- no heavy runtime imports.

Validation launches 20 and 100 dormant harnesses. For 20 sessions, incremental presence and endpoint overhead excluding the already-required Node processes must remain below 5 MB, idle CPU must remain statistically indistinguishable from baseline, and remote connection count must remain zero.

### Resolve existing sessions in a fixed order

When the phone opens Session A, Station executes:

1. If the phone already has a healthy live card for A, open it.
2. If the phone has stored pairing for A, reconnect and obtain host confirmation.
3. Scan local runtime presence for A.
4. If exactly one compatible runtime is proven live, activate or query that exact runtime through its pipe.
5. If multiple live runtimes claim A, return a conflict and do not choose one automatically.
6. If no live runtime exists and the session store plus working directory are valid, reserve A and launch `copilot --resume=<id>`.
7. If ownership is uncertain, fail closed.

An operation never changes from reconnect or activate to Resume merely because of a timeout. A new decision requires reconciliation proving the prior writer absent.

### Preserve the current Start handoff and add pipe status

For phone Start:

1. Station validates the project and journals the operation.
2. Station creates a private activation identity.
3. Station launches Copilot with identity and operation references.
4. The child bootstrap publishes presence and its local endpoint.
5. The explicit handoff causes immediate active-runtime loading.
6. The child claims the operation and reports activation/pairing state through its pipe.
7. Station sends public pairing material to the phone.
8. The phone pairs directly with the session.

The environment/file handoff remains the bootstrap mechanism. The pipe provides immediate live status and later recovery. The filesystem journal ensures Station can recover after crashing between steps.

### Keep the phone data path independent

After pairing, prompts, events, approvals, streaming, and terminal data flow directly between the phone and session over the selected encrypted relay. They never pass through the local pipe or Device Station.

The pipe remains available only as a local lifecycle control endpoint. It has no active Station connection while idle.

### Separate writer ownership from phone attachment

Every live Copilot runtime represents a writer whether or not a phone is connected. Relay disconnect, deleted phone card, expired pairing grant, or Station exit does not make the session stopped.

Only the current runtime generation may report lifecycle state. Generation plus PID, OS process-start time, capability proof, and session/store identity prevent stale entries and PID reuse from authorizing takeover.

### Use durable, monotonic operations

Station persists each operation before external effects:

```ts
interface LifecycleOperation {
  operationId: string;
  fingerprint: string;
  target:
    | { kind: "new"; projectName: string }
    | { kind: "existing"; storeAuthority: string; sessionId: string };
  action: "undecided" | "reconnect" | "activate" | "resume" | "start" | "takeover";
  state:
    | "accepted"
    | "reserved"
    | "activating"
    | "launching"
    | "pairing-ready"
    | "pairing"
    | "open"
    | "failed"
    | "cancelled";
  revision: number;
  runtimeId?: string;
  identityRef?: string;
  failure?: StructuredFailure;
}
```

Identical operation retries replay or continue. Conflicting reuse fails. State and revision never regress. Completed operations and unclaimed recovery identities expire after three days unless referenced by a live runtime or unresolved operation.

### Make takeover explicit

If another phone controls a responsive session, Station returns a challenge. After confirmation, the existing runtime immediately revokes the prior controller and rotates pairing for the requesting phone without restarting Copilot.

If the runtime is unresponsive, confirmed takeover:

1. revalidates the challenge against current presence;
2. requests quiescence;
3. revalidates PID and process-start time;
4. terminates the exact process;
5. confirms exit;
6. releases ownership;
7. reserves and resumes the logical session.

Any changed proof or unconfirmed exit fails without replacement.

### Treat extension reload and `/clear` differently

A normal extension reload may reclaim active identity because the logical Copilot session remains the same. The replacement receives a higher generation and fences the old one.

`/clear` abandons the logical conversation. The active phone session disconnects, the old identity is not transferred, and the new Copilot session starts dormant with fresh presence and endpoint state.

### Roll out through compatibility adapters

New Station and extension versions advertise `session-activation-v1`. Legacy spawn, Resume, offer, pairing, result, and launch-status messages remain supported during migration.

New Station checks both new presence and positive legacy attached/pending evidence. An old extension's lack of new presence is never treated as proof that a live session is safe to Resume.

Legacy files are retired only after mixed-version tests pass and the supported client population advertises the new capability.

The removal gate is a future release criterion, not part of this change: remove the compatibility
adapters only after the old/new phone, Station, and extension matrix passes without legacy fallback
for every supported version and release evidence confirms that all supported peers advertise
`session-activation-v1`. Until then, core lifecycle policy remains coordinator-owned while adapters
alone translate legacy messages and maintain the minimum downgrade-readable registries.

## Risks / Trade-offs

- **One endpoint per live Copilot session** → It costs one idle OS handle but avoids polling; measure 20- and 100-session scale before release.
- **Platform-specific endpoint adapters** → Keep framing and contracts shared; isolate Windows named-pipe and Unix socket path/permission differences.
- **Presence exposes local metadata** → Store only required fields under a current-user directory; keep capability and pairing identity separate.
- **Station is required for phone automation** → This is an explicit product constraint, not a failure; direct `/weft` remains available.
- **Fail-closed ownership can block Resume** → Prefer preserving session-store integrity and provide structured recovery guidance.
- **Responsive takeover disconnects another phone immediately** → Require explicit confirmation and report the consequence before acting.
- **Compatibility temporarily duplicates state** → Keep dual-read/write logic isolated and delete it after the migration window.

## Migration Plan

1. Add lifecycle capability, structured states, failures, and compatibility messages.
2. Introduce the Station `SessionCoordinator` behind existing Start and Resume handlers.
3. Add mobile `SessionAccess` and move decision logic out of screens.
4. Add presence files and local endpoint adapters while retaining current eager activation.
5. Split bootstrap and active-runtime bundles and enforce the dormant budget.
6. Prefer live runtime activation over Resume.
7. Move writer ownership out of attachment registries.
8. Add responsive controller replacement and strict forced takeover.
9. Enable the generic Open protocol for new clients while preserving legacy projections.
10. Remove legacy offer/attachment policy and stale shallow tests after compatibility validation.

Rollback remains possible until step 10 because new versions continue reading and writing required legacy state. No persisted user session history is migrated or deleted.

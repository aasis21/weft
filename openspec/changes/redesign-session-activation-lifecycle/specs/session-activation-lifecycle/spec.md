## ADDED Requirements

### Requirement: Explicit remote bridge
Phone-initiated machine operations SHALL use a running Device Station, while direct `/weft` QR pairing SHALL remain available for one explicitly activated session.

#### Scenario: Phone starts or opens a session
- **WHEN** the phone requests project discovery, Start, or Open/Resume
- **THEN** the request is delivered through the paired Device Station

#### Scenario: Direct QR pairing
- **WHEN** the user invokes `/weft` and scans its QR
- **THEN** the phone connects directly to that session without requiring Device Station

#### Scenario: No bridge exists
- **WHEN** Device Station is not running and no session is directly paired
- **THEN** filesystem state remains local-only
- **AND** the phone cannot discover, start, resume, or activate sessions

### Requirement: Dormant extension footprint
An extension that has not been activated SHALL remain silent and SHALL load only the functionality required for Copilot registration, runtime presence, and local lifecycle control.

#### Scenario: Ordinary inactive session
- **WHEN** a Copilot session starts without a Station handoff and `/weft` is not invoked
- **THEN** the extension creates one small presence record and one idle local control endpoint
- **AND** it performs no transport lookup, cryptography, QR generation, remote network access, active diagnostics, heartbeat, retry timer, stderr output, or timeline output

#### Scenario: Twenty inactive sessions
- **WHEN** twenty Copilot sessions have dormant Weft extensions
- **THEN** each session owns at most one local endpoint and one bounded presence record
- **AND** aggregate incremental presence/control overhead remains below the documented performance budget

### Requirement: Runtime presence
Every running compatible Copilot session SHALL publish sufficient local presence for Device Station to distinguish it from stopped history without considering phone attachment.

#### Scenario: Station starts after Session A
- **WHEN** Session A is already running and Device Station starts later
- **THEN** Station discovers Session A from its presence record

#### Scenario: Presence is stale
- **WHEN** a presence record references a dead or replaced process generation
- **THEN** Station rejects it using PID, process-start time, generation, and endpoint proof

#### Scenario: Multiple live writers are detected
- **WHEN** more than one live runtime claims the same session-store authority and logical session ID
- **THEN** Station reports a conflict and does not activate, resume, or terminate either process automatically

### Requirement: Open existing session in place
Opening a saved session SHALL prefer the already-running Copilot process over launching `copilot --resume`.

#### Scenario: Session A is running and dormant
- **WHEN** the phone asks Device Station to open Session A
- **THEN** Station connects to Session A's local endpoint and requests activation
- **AND** Session A loads its active Weft runtime and returns pairing readiness
- **AND** no new terminal is opened

#### Scenario: Session A is already connected to the requesting phone
- **WHEN** the phone opens Session A
- **THEN** the existing session card or stored pairing reconnects
- **AND** Station does not launch or activate another runtime

#### Scenario: Session A has no live runtime
- **WHEN** presence and process checks prove Session A is stopped
- **THEN** Station durably reserves it and launches exactly one `copilot --resume=<sessionId>`

#### Scenario: Session A ownership is uncertain
- **WHEN** Station cannot prove Session A live or stopped
- **THEN** Open fails closed with a structured ownership-unknown result
- **AND** no new terminal is opened

### Requirement: Start new session
Starting a new session from the phone SHALL remain a durable, idempotent Device Station operation.

#### Scenario: Successful Start
- **WHEN** the phone requests Start for a valid project
- **THEN** Station journals the operation, creates a private activation identity, launches Copilot once, and supplies the handoff references
- **AND** the child bootstrap opens its local endpoint, claims the operation, activates immediately, and returns pairing readiness

#### Scenario: Duplicate Start
- **WHEN** the same operation is delivered more than once
- **THEN** Station replays or continues the original operation
- **AND** no second terminal is launched

#### Scenario: Station restarts after launch
- **WHEN** Station restarts before the phone pairs
- **THEN** it reloads the operation journal, discovers the child presence, queries its endpoint, and continues the original operation

#### Scenario: Pairing fails after launch
- **WHEN** the child process exists but pairing fails
- **THEN** retry reuses the same operation, process, and activation identity
- **AND** Station does not launch another child

### Requirement: Local control endpoint
Each live extension SHALL expose one user-local lifecycle endpoint that is separate from phone-session traffic.

#### Scenario: Dormant endpoint
- **WHEN** no Station command is in progress
- **THEN** the endpoint waits without polling, timers, network traffic, or active client connections

#### Scenario: Activation command
- **WHEN** Station connects and sends an operation-bound activation command
- **THEN** the extension validates the runtime identity, session identity, generation, and private capability token before activating

#### Scenario: Activation completes
- **WHEN** pairing readiness is reported
- **THEN** Station closes its temporary endpoint connection
- **AND** the extension retains only the listening endpoint for later status, takeover, or quiesce commands

#### Scenario: Session exits
- **WHEN** the Copilot session or extension ends
- **THEN** the endpoint closes and its presence becomes removable

### Requirement: Single-writer safety
Weft SHALL allow at most one launchable reservation or proven live writer for a logical session.

#### Scenario: Concurrent Open requests
- **WHEN** multiple requests target the same stopped logical session
- **THEN** one reservation wins and at most one Resume process is launched

#### Scenario: Transport fails
- **WHEN** a running session loses Supabase or Dev Tunnel connectivity
- **THEN** writer ownership remains intact
- **AND** the failure does not authorize another Resume

#### Scenario: Runtime reload overlaps
- **WHEN** old and replacement extension generations overlap
- **THEN** only the accepted generation can report health or mutate lifecycle state

#### Scenario: Operation storage is unavailable
- **WHEN** Station cannot persist the reservation and operation before an external effect
- **THEN** it performs no activation, termination, or launch

### Requirement: Controller takeover
Changing the phone controlling a live session SHALL be explicit and SHALL preserve the existing Copilot process whenever it responds.

#### Scenario: Different phone requests a responsive session
- **WHEN** another phone controls the session
- **THEN** Open returns a structured takeover challenge without changing the session

#### Scenario: Responsive takeover is confirmed
- **WHEN** the requesting user confirms takeover
- **THEN** the active runtime immediately revokes the previous controller, rotates pairing as needed, and pairs the new phone without restarting Copilot

#### Scenario: Unresponsive takeover is confirmed
- **WHEN** the exact owner cannot quiesce
- **THEN** Station revalidates ownership, terminates that exact process, confirms exit, and only then launches Resume

#### Scenario: Ownership changes during takeover
- **WHEN** runtime generation or process identity differs from the challenge
- **THEN** takeover fails and no process is terminated or launched

### Requirement: Lifecycle recovery and retention
Lifecycle operations and activation identities SHALL support crash recovery without indefinite retention.

#### Scenario: Duplicate operation
- **WHEN** an operation ID is repeated with the same normalized request
- **THEN** the prior state and result are replayed

#### Scenario: Conflicting operation
- **WHEN** an operation ID is reused with different material fields
- **THEN** the request fails with an operation-conflict result

#### Scenario: Recovery record expires
- **WHEN** an unclaimed identity or completed operation becomes older than three days
- **THEN** it is safely removed unless referenced by a currently live runtime or unresolved operation

#### Scenario: Extension reload while active
- **WHEN** the extension reloads without clearing the Copilot conversation
- **THEN** the replacement generation may reclaim the active identity and phone channel while fencing the prior generation

#### Scenario: Clear active session
- **WHEN** `/clear` abandons the current Copilot conversation
- **THEN** Weft disconnects that phone session
- **AND** the replacement Copilot session starts dormant and requires fresh activation

### Requirement: Structured lifecycle interface
Mobile UI and Station protocol handlers SHALL consume stable lifecycle states and failure codes rather than infer policy from English messages.

#### Scenario: Open request progresses
- **WHEN** an Open operation is accepted
- **THEN** callers can observe locating, activating, launching, pairing, open, failed, or cancelled states

#### Scenario: Open is blocked
- **WHEN** a writer, controller, capability, missing session, missing directory, or uncertain ownership blocks Open
- **THEN** the result contains a stable code and allowed next action

#### Scenario: Legacy client participates
- **WHEN** one peer lacks the new lifecycle capability
- **THEN** a compatibility adapter preserves existing supported behavior
- **AND** missing new presence is never treated as proof that an old live writer is safe to replace

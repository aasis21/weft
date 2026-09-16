## 1. Lifecycle Contracts

- [x] 1.1 Add `session-activation-v1`, structured lifecycle states, failures, takeover challenges, and three-day retention constants
- [x] 1.2 Add generic Open, status, takeover-confirm, and cancel messages with legacy compatibility projections
- [x] 1.3 Add shared protocol tests for compatibility, bounded payloads, operation fingerprints, and monotonic revisions

## 2. Station Session Coordinator

- [x] 2.1 Define `SessionCoordinator` and dependency-port interfaces
- [x] 2.2 Implement the pure resolution order for open-existing, reconnect, activate-live, Resume, Start, conflict, and fail-closed outcomes
- [x] 2.3 Refactor launch operations into a monotonic journal with request fingerprints, per-target reservations, and terminal tombstones
- [x] 2.4 Add three-day cleanup that preserves live-runtime and unresolved-operation references
- [x] 2.5 Reconcile unresolved operations after Station restart without repeating launch
- [x] 2.6 Add coordinator tests for duplicate delivery, concurrent requests, storage failure, crash boundaries, and single-writer invariants

## 3. Runtime Presence

- [x] 3.1 Implement stable store-authority, terminal-instance, runtime-instance, and generation identities
- [x] 3.2 Implement one atomic user-private presence directory per runtime
- [x] 3.3 Add process-start-time verification and stale/PID-reuse detection
- [x] 3.4 Detect multiple live runtimes for one logical session and fail closed
- [x] 3.5 Add presence tests for startup, reload, stale cleanup, corruption, duplicate writers, and permissions

## 4. Local Lifecycle Endpoint

- [x] 4.1 Implement bounded versioned JSON framing over Windows named pipes and Unix-domain sockets
- [x] 4.2 Authenticate requests with the private runtime capability plus session/runtime generation
- [x] 4.3 Implement probe, activate, status, replace-controller, and quiesce handlers
- [x] 4.4 Close temporary Station connections after each command while retaining the idle listener
- [x] 4.5 Add endpoint contract tests for malformed frames, stale capabilities, changed generations, reconnect, shutdown, and concurrent commands

## 5. Lazy Extension Runtime

- [x] 5.1 Extract QR, crypto, transport, relay, permission, history, reconnect, and active diagnostics into a separately loadable runtime
- [x] 5.2 Replace `extension.mjs` with a bootstrap that joins Copilot, registers `/weft`, publishes presence, opens the local endpoint, and detects explicit handoff
- [x] 5.3 Activate only for `/weft`, Station command, Start/Resume handoff, or same-session extension reload recovery
- [x] 5.4 Split build, release manifest, installer, updater, and bundle tests for bootstrap plus active runtime
- [x] 5.5 Preserve direct `/weft` QR pairing without Device Station
- [x] 5.6 Add negative dormant tests proving no heavy imports, transport reads, crypto, QR, remote sockets, timers, logs, stderr, or timeline output

## 6. Open Existing Session

- [x] 6.1 Merge saved-session catalog data with verified live runtime presence
- [x] 6.2 Route phone Open/Resume through existing-card, reconnect, activate-live, conflict, and stopped-Resume resolution
- [x] 6.3 Activate a live dormant runtime through its endpoint and return pairing readiness without spawning
- [x] 6.4 Prevent activation or pairing timeout from falling through to Resume
- [x] 6.5 Add end-to-end tests proving an already-open Session A is reused and no second terminal is launched

## 7. Start and Recovery

- [x] 7.1 Preserve environment/file identity handoff for phone Start and stopped-session Resume
- [x] 7.2 Have the child bootstrap claim the journaled operation and report state through its endpoint
- [x] 7.3 Recover after Station restart by reading the journal, locating child presence, and querying endpoint status
- [x] 7.4 Reuse the same process and identity after pairing or transport failure
- [x] 7.5 Add Start/Resume crash tests before spawn, after spawn, before readiness, during pairing, and after response loss

## 8. Ownership and Takeover

- [x] 8.1 Separate runtime writer ownership from phone controller attachment
- [x] 8.2 Fence lifecycle reports by runtime generation
- [x] 8.3 Add structured takeover challenges bound to exact presence and operation revision
- [x] 8.4 Implement immediate confirmed controller replacement in a responsive runtime
- [x] 8.5 Implement unresponsive takeover as revalidate, quiesce, terminate exact owner, confirm exit, then Resume
- [x] 8.6 Add tests for changed ownership, PID reuse, failed quiescence, unconfirmed exit, and concurrent phones

## 9. Mobile Session Access

- [x] 9.1 Introduce `SessionAccess` with open, takeover confirmation, cancellation, and operation inspection
- [x] 9.2 Move reconnect-first, operation persistence, pairing, and session-card reconciliation behind `SessionAccess`
- [x] 9.3 Replace separate Start, Resume, and offer-adoption screen orchestration with Open intents
- [x] 9.4 Replace English error matching with structured lifecycle states and actions
- [x] 9.5 Preserve accepted operations and phone identity across app reload
- [x] 9.6 Add mobile tests for open-existing, activate-live, stopped Resume, Start, retry, cancellation, and takeover

## 10. Reload, Clear, and Retention

- [x] 10.1 Reclaim active identity across same-session extension reload while fencing the previous generation
- [x] 10.2 Disconnect and discard active identity on `/clear`; start the replacement session dormant
- [x] 10.3 Remove expired completed operations and unclaimed identities after three days
- [x] 10.4 Add reload, `/clear`, expiry, and live-reference retention tests

## 11. Compatibility and Cleanup

- [x] 11.1 Adapt legacy spawn, Resume, offer, pairing, result, claimed, and launch-status messages to coordinator operations
- [x] 11.2 Dual-read new presence and positive legacy attachment/offer evidence during rollout
- [x] 11.3 Dual-write downgrade-compatible state where required
- [x] 11.4 Add old/new phone, Station, and extension compatibility matrix tests
- [x] 11.5 Isolate legacy lifecycle policy behind compatibility adapters and document/test the removal gate for a release after the support window

## 12. Scale, Documentation, and Validation

- [x] 12.1 Add 20- and 100-dormant-session harnesses measuring RSS, handles, startup latency, idle CPU, cleanup, and remote connections
- [x] 12.2 Enforce less than 5 MB aggregate endpoint/presence overhead for 20 dormant sessions, excluding existing Node process baselines
- [x] 12.3 Update setup, pairing, hosting, security, privacy, and troubleshooting documentation
- [x] 12.4 Run focused shared, extension, Station, and mobile tests
- [x] 12.5 Run mobile type tests plus repository test, build, lint, and version checks
- [x] 12.6 Verify end-to-end direct QR, phone Start, stopped Resume, live dormant activation, reconnect, responsive takeover, forced restart, Station restart, extension reload, and `/clear`

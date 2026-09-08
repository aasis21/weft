## 1. Protocol and Collection

- [x] 1.1 Advertise `device-monitor-v1` through the project-list capability field
- [x] 1.2 Add typed monitor-ID-scoped start, stop, and ordered snapshot messages to the shared protocol
- [x] 1.3 Implement a dependency-injectable Windows telemetry collector with bounded CPU sampling, cached slow sections, stable issue codes, and PowerShell timeouts
- [x] 1.4 Add protocol and collector tests covering capability compatibility, sequencing, nullable metrics, visible-app grouping, caching, and partial failures
- [x] 1.5 Stabilize CPU utilization with a 500 ms aggregate counter-delta sample

## 2. Device Station Monitoring

- [x] 2.1 Handle monitor-ID-scoped leases in Device Station with immediate snapshots, clamped cadence, renewal, replacement, matching stop, and automatic expiry
- [x] 2.2 Add listener tests proving stale-stop rejection, ordered snapshots, lease behavior, and heartbeat independence

## 3. Mobile Runtime and UI

- [x] 3.1 Extend mobile device state and reducers to hold capabilities plus runtime-only snapshot and monitoring state
- [x] 3.2 Start and renew one monitor while Device Details is visible, stop it during cleanup, and reject mismatched or reordered snapshots
- [x] 3.3 Render a compact health header, percentage-first system cards, and a three-item expandable Running Now list
- [x] 3.4 Render loading, partial-unavailable, stale, and laptop-update states without fabricated zero values
- [x] 3.5 Add runtime and screen tests for capability gating, snapshot ordering, monitor lifecycle, and responsive presentation
- [x] 3.6 Reduce Device Details density with a single-row action rail, lightweight Copilot workspace rows, and compact session rows
- [x] 3.7 Unify Device Details sections around one width, surface, heading, metadata, row, and divider system
- [x] 3.8 Persist the last system-health summary and show it while a fresh page-scoped snapshot loads

## 4. Validation

- [x] 4.1 Regenerate or update shared declarations and verify workspace type safety
- [x] 4.2 Run focused shared, extension, and mobile tests
- [x] 4.3 Run the repository build and lint commands

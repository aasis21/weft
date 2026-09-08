## ADDED Requirements

### Requirement: Monitoring is active only while requested
The phone SHALL create a unique monitor ID and request a time-bounded monitoring lease when Device Details becomes visible. The Device Station SHALL stop periodic collection when the matching monitor stops or its lease expires.

#### Scenario: Device page starts monitoring
- **WHEN** the user opens Device Details for a connected device
- **THEN** the phone sends a monitoring-start request containing a new monitor ID and the station immediately returns a snapshot for that monitor

#### Scenario: Visible page renews monitoring
- **WHEN** Device Details remains visible before the current lease expires
- **THEN** the phone renews the lease using the same monitor ID without creating a second monitoring loop

#### Scenario: Device page stops monitoring
- **WHEN** the user leaves Device Details
- **THEN** the phone sends a monitoring-stop request containing the active monitor ID and the station stops its periodic telemetry

#### Scenario: Delayed stop belongs to an old screen instance
- **WHEN** the station receives a monitoring-stop request whose monitor ID does not match the active monitor
- **THEN** the station ignores the request and continues the active monitor

#### Scenario: Stop message is lost
- **WHEN** the phone disconnects without delivering a monitoring-stop request
- **THEN** the station stops periodic telemetry when the monitoring lease expires

### Requirement: Device snapshots use the encrypted device channel
The system SHALL deliver monitoring requests and device snapshots through the existing end-to-end encrypted Device Station channel.

#### Scenario: Relay observes a device snapshot
- **WHEN** a Device Station publishes a snapshot through a relay transport
- **THEN** the relay receives only the existing encrypted transport envelope and cannot read the telemetry

### Requirement: Device snapshots contain useful system state
Each successful snapshot SHALL include its schema version, monitor ID, increasing sequence, capture time, effective interval, lease expiry, CPU utilization, memory utilization, system uptime, disk capacity, battery information when available, and a curated list of visible user applications.

#### Scenario: Windows device returns a snapshot
- **WHEN** monitoring is requested from a reachable Windows Device Station
- **THEN** the snapshot contains current system metrics and applications with visible top-level windows

#### Scenario: Battery is unavailable
- **WHEN** Windows reports no battery
- **THEN** the snapshot identifies battery information as unavailable without failing the remaining metrics

#### Scenario: A metric cannot be collected
- **WHEN** the operating system rejects or times out part of telemetry collection
- **THEN** the station returns a stable issue code for that component, keeps unaffected data available, and does not transmit raw local exception details

### Requirement: Slow telemetry sections are cached
The Device Station SHALL collect CPU and memory for every published snapshot while collecting visible applications, disk, and battery at lower bounded cadences and SHALL include observation timestamps for independently cached sections.

#### Scenario: Snapshot tick occurs before application cache expires
- **WHEN** the station publishes a snapshot while its application observation is still fresh
- **THEN** it reuses the cached application list and preserves the applications observation timestamp

#### Scenario: Application cache expires
- **WHEN** the applications observation age reaches its configured cadence
- **THEN** the station refreshes visible applications before publishing the next complete snapshot

### Requirement: Running applications protect detail privacy
The Device Station SHALL group visible applications into user-facing application summaries and SHALL NOT transmit window titles, document names, browser tab titles, or background-only processes.

#### Scenario: Application has multiple windows or processes
- **WHEN** multiple visible processes belong to the same executable
- **THEN** the snapshot contains one grouped application entry with aggregate counts and memory

#### Scenario: Background process is running
- **WHEN** a process has no visible top-level window
- **THEN** that process is excluded from the running-application list

### Requirement: Monitoring cadence is bounded
The Device Station SHALL clamp requested monitoring intervals and lease durations to supported limits and SHALL keep the existing device heartbeat independent from telemetry.

#### Scenario: Phone requests an excessively frequent interval
- **WHEN** the phone requests an interval below the supported minimum
- **THEN** the station uses the supported minimum rather than the requested value

#### Scenario: No phone is viewing Device Details
- **WHEN** no active monitoring lease exists
- **THEN** the station sends only its existing liveness heartbeat and no device snapshots

### Requirement: Monitoring support is discoverable
The Device Station SHALL advertise `device-monitor-v1` in the optional capabilities field of its project-list response.

#### Scenario: New phone connects to a compatible station
- **WHEN** the phone receives a project-list response containing `device-monitor-v1`
- **THEN** it enables system statistics and Running Now monitoring

#### Scenario: New phone connects to an older station
- **WHEN** the project-list response does not advertise `device-monitor-v1`
- **THEN** the phone does not send monitoring commands and presents an actionable laptop-update state

### Requirement: Mobile Device Details presents current telemetry
The mobile application SHALL display system statistics and running applications from the newest snapshot and SHALL communicate loading, unavailable, and stale states.

#### Scenario: First snapshot is pending
- **WHEN** Device Details has requested monitoring but no snapshot has arrived
- **THEN** the screen presents a loading state without fabricating metric values

#### Scenario: Snapshot arrives
- **WHEN** the runtime receives a newer device snapshot
- **THEN** Device Details updates its system statistics and running applications

#### Scenario: Snapshot belongs to an old monitor
- **WHEN** the runtime receives a snapshot whose monitor ID differs from the page's active monitor ID
- **THEN** it ignores the snapshot

#### Scenario: Snapshot is duplicated or reordered
- **WHEN** the runtime receives a snapshot with a sequence not greater than the latest accepted sequence
- **THEN** it ignores the snapshot

#### Scenario: Snapshot becomes stale
- **WHEN** no newer snapshot arrives within the expected monitoring window
- **THEN** the screen indicates that the displayed information is stale

### Requirement: Device Details is optimized for mobile scanning
Device Details SHALL present a compact system summary and a curated Running Now list without reproducing Task Manager's process table.

#### Scenario: System metrics are available
- **WHEN** the latest snapshot contains CPU, memory, disk, or battery information
- **THEN** the screen displays percentage-first values with concise supporting details

#### Scenario: Uptime is available
- **WHEN** the latest snapshot contains system uptime
- **THEN** the screen presents uptime as a peer system-health metric

#### Scenario: Device actions are presented
- **WHEN** the user views Device Details
- **THEN** Start Copilot, Resume Copilot, Explore Files, and Open Terminal use one consistent quick-action layout
- **AND** actions without an implemented protocol are visibly unavailable rather than pretending to succeed

#### Scenario: Registered launch folders are presented
- **WHEN** the Device Station reports registered projects
- **THEN** Device Details presents them as Copilot workspaces with names, compact paths, default state, and a bounded initial list

#### Scenario: Monitoring events are inspected
- **WHEN** the user opens the device event log
- **THEN** device snapshot events are represented alongside other device-channel event types
- **AND** consecutive high-frequency snapshots may be coalesced to keep the bounded log useful

#### Scenario: Running applications are available
- **WHEN** the latest snapshot contains visible applications
- **THEN** the screen displays friendly grouped application names, relevant window counts or memory, and initially limits the list to five entries

#### Scenario: Battery is unavailable
- **WHEN** the device does not report battery information
- **THEN** the screen hides the battery metric rather than displaying a misleading zero value

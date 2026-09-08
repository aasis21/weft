## ADDED Requirements

### Requirement: Keep Awake uses a bounded station lease
The phone SHALL request Keep Awake with a unique lease ID and bounded duration, and Device Station
SHALL keep the system awake only until the matching lease stops, expires, is replaced, or the
station shuts down.

#### Scenario: User starts Keep Awake
- **WHEN** the user selects a supported duration
- **THEN** the station activates system-required execution state and returns the authoritative expiry

#### Scenario: User extends Keep Awake
- **WHEN** the user extends an active lease
- **THEN** the station updates that lease expiry without creating a second power helper

#### Scenario: User stops Keep Awake
- **WHEN** the user selects Stop keeping awake
- **THEN** the station deactivates the matching lease and restores normal system sleep behavior

#### Scenario: Lease expires or station exits
- **WHEN** the lease reaches its expiry or Device Station shuts down
- **THEN** the station terminates the Keep Awake helper and restores normal system sleep behavior

### Requirement: Keep Awake is visible and capability-gated
Device Station SHALL advertise `device-keep-awake-v1`, and Device Details SHALL show the active
state, remaining duration, and explicit Stop and Extend controls.

#### Scenario: Keep Awake is active
- **WHEN** an authoritative active status contains an expiry
- **THEN** the quick action and Power card display the remaining time

#### Scenario: Laptop does not support Keep Awake
- **WHEN** the connected station omits `device-keep-awake-v1`
- **THEN** the Keep Awake action remains unavailable and explains that the laptop must be updated

### Requirement: Device health reports actionable power state
Device snapshots SHALL report AC-power availability independently from battery percentage and
charging state, and Device Details SHALL present Power instead of Uptime in the primary health grid.

#### Scenario: Laptop is on battery
- **WHEN** a snapshot reports a battery percentage and no AC power
- **THEN** the Power card displays the percentage and On battery

#### Scenario: Laptop is charging
- **WHEN** a snapshot reports a battery percentage and charging or AC power
- **THEN** the Power card displays the percentage and Charging

#### Scenario: Desktop is connected to AC power
- **WHEN** a snapshot reports AC power without battery information
- **THEN** the Power card displays AC and Plugged in

#### Scenario: Power state is unavailable
- **WHEN** neither battery nor AC state can be determined
- **THEN** the Power card displays an unavailable state without fabricating a percentage

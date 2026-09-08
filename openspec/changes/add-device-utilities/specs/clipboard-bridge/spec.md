## ADDED Requirements

### Requirement: Clipboard transfer is explicit and text-only
The system SHALL transfer clipboard text only after an explicit user action and SHALL NOT
automatically synchronize clipboard changes.

#### Scenario: User reads the laptop clipboard
- **WHEN** the user opens Clipboard and selects Read laptop clipboard
- **THEN** the phone sends a request-ID-scoped read command and displays the returned plain text

#### Scenario: User writes to the laptop clipboard
- **WHEN** the user enters text and selects Send to laptop
- **THEN** the station writes that exact plain text to the Windows clipboard and returns a correlated result

### Requirement: Clipboard data is bounded and ephemeral
The phone and station SHALL enforce a 64 KiB UTF-8 clipboard limit and SHALL keep clipboard contents
out of persistent storage and diagnostics.

#### Scenario: Clipboard content exceeds the limit
- **WHEN** a read or write payload exceeds 64 KiB
- **THEN** the operation fails with a stable too-large error without transferring or storing the content

#### Scenario: Clipboard sheet closes
- **WHEN** the user dismisses the Clipboard sheet
- **THEN** all clipboard text and operation state for that sheet are cleared from mobile runtime state

#### Scenario: Device events are inspected
- **WHEN** clipboard commands or results pass over the encrypted device channel
- **THEN** event logs omit clipboard text and retain at most redacted operation metadata

### Requirement: Clipboard compatibility is capability-gated
Device Station SHALL advertise `device-clipboard-v1`, and the phone SHALL send clipboard commands
only when that capability is present.

#### Scenario: Laptop does not support clipboard transfer
- **WHEN** the connected station omits `device-clipboard-v1`
- **THEN** the Clipboard action remains unavailable and explains that the laptop must be updated

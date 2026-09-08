## ADDED Requirements

### Requirement: Explicitly authorized terminal access
Station MUST reject terminal operations unless remote shell access was enabled on
the laptop, and MUST negotiate support independently of Copilot session capabilities.

#### Scenario: Default Station denies shell access
- **WHEN** the paired phone requests a terminal from Station started without authorization
- **THEN** no shell or local window is created and an actionable error is returned

### Requirement: One shared visible terminal
Open terminal SHALL create or reuse exactly one Station-owned shell, displayed by
both the phone and a visible local attach client.

#### Scenario: Repeated open requests
- **WHEN** concurrent or repeated open requests reach a Station with a live terminal
- **THEN** all successful replies refer to the same terminal and no duplicate shell or window is created

### Requirement: Continuous shell input
Commands and direct input MUST target the existing shell with explicit ownership.
Duplicate or stale inputs MUST NOT execute a second time or enter a replacement shell.

#### Scenario: Duplicate input delivery
- **WHEN** an already accepted input sequence is delivered again
- **THEN** Station does not write that input into the PTY again

#### Scenario: Competing frontend input
- **WHEN** a frontend without control attempts to type
- **THEN** input is rejected until that frontend claims control

### Requirement: Reconnectable bounded terminal output
The phone SHALL reconstruct the terminal from a bounded snapshot and subsequent
sequenced output without retransmitting commands.

#### Scenario: Phone reconnects while a command is running
- **WHEN** the phone returns after losing its connection
- **THEN** it attaches to the same live terminal, receives its available screen and scrollback, and resumes output
- **AND** any omitted scrollback is clearly indicated

### Requirement: Explicit terminal lifecycle
Leaving the phone terminal view SHALL keep the shell running. Confirmed close,
natural shell exit, or closing the owned laptop frontend SHALL end that terminal
and report the closed state. Station shutdown SHALL clean up owned resources.

#### Scenario: Phone closes the terminal
- **WHEN** the user confirms Close terminal
- **THEN** the shell process tree ends, its local attach client exits, and a later Open creates a new terminal identity

### Requirement: Mobile-friendly terminal controls
The phone SHALL provide editable command submission, direct interactive input,
special keys, readable/selectable output, ownership and connection status, and
reconnect/close actions without forcing a reader to the bottom.

#### Scenario: Reader scrolls away during command output
- **WHEN** new output arrives while the reader is above the latest output
- **THEN** the reading position is preserved and a return-to-latest action is available

### Requirement: Private content and installable runtime
Terminal contents and attachment credentials MUST NOT be persisted in diagnostic
logs. Supported installed Windows builds MUST include a usable native PTY runtime.

#### Scenario: Terminal started outside a checkout
- **WHEN** a supported Windows installation starts an authorized Station without repository dependencies
- **THEN** it can create, attach to, use, and close its terminal without requiring C++ build tools

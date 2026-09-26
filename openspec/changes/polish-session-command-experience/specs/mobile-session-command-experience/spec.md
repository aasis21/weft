## ADDED Requirements

### Requirement: Ordered Markdown preserves authored numbering
The mobile transcript SHALL preserve the starting marker of every ordered Markdown list, including lists separated by paragraphs.

#### Scenario: Paragraphs split numbered findings
- **WHEN** an assistant response contains separately rendered ordered-list blocks starting at 1, 2, and 3
- **THEN** each rendered list starts at its authored number

### Requirement: Start Session prioritizes naming before permissions
The New Session form SHALL place the optional session name before permission selection and keep the focused field usable above the mobile keyboard.

#### Scenario: User names and starts a session from the keyboard
- **WHEN** the user focuses the session-name field, enters a valid name, and presses Enter
- **THEN** the field remains visible and the session starts with that name

### Requirement: Resume sessions use a compact readable list
The Resume view SHALL present sessions as compact rows with title and age on the primary line, repository/branch metadata on the secondary line, and a clear lightweight selected state.

#### Scenario: Many resumable sessions are visible
- **WHEN** the device returns multiple sessions
- **THEN** the view fits more rows than the previous card layout without losing title, age, repository, branch, or selection information

### Requirement: Shell ToolCards separate command, output, and status
Expanded shell ToolCards SHALL present the command, options, output, completion status, exit code, and shell identifier as distinct readable surfaces while keeping raw arguments optional.

#### Scenario: Completed shell command includes a shell marker
- **WHEN** a shell tool result ends with an internal shell completion marker
- **THEN** the visible output excludes that marker and the card displays the parsed exit code and shell identifier separately

### Requirement: Reader scroll intent survives session heartbeats
The chat SHALL treat an explicit upward touch gesture as detached reading intent until the reader deliberately returns to the latest content.

#### Scenario: Heartbeat arrives during momentum scrolling
- **WHEN** the reader swipes upward, releases the screen, and a heartbeat or resize update arrives before the next decisive scroll event
- **THEN** the transcript remains at the reader's position and offers Jump to latest

### Requirement: Phone commands support generic argument experiences
The shared phone-command catalogue SHALL describe no-input, free-text, and curated-option arguments so the mobile composer can render and validate command arguments without command-specific UI branches.

#### Scenario: Option command is selected
- **WHEN** the user selects a command with curated options
- **THEN** the existing suggestion panel displays filterable friendly choices and executes the hidden validated value

#### Scenario: Text command is selected
- **WHEN** the user selects a command that accepts required or optional text
- **THEN** the composer accepts free text according to the shared requirement and placeholder

### Requirement: Mobile model selection is curated and validated
The mobile `/model` experience SHALL expose only Weft-approved friendly choices, keep CLI model IDs out of visible UI, and validate the chosen value on both phone and extension.

#### Scenario: User selects an approved model
- **WHEN** the user chooses a curated model from the `/model` argument list
- **THEN** Weft invokes `/model` with the hidden internal value and reports the real command outcome

#### Scenario: Model is unavailable
- **WHEN** the CLI rejects a curated model for the current account or version
- **THEN** Weft displays the failure and does not claim that the model changed

### Requirement: Tool activity uses consistent explainable labels
Chat and Explore SHALL use one centralized mapping for compact tool names while preserving detailed raw arguments only in expandable ToolCards.

#### Scenario: Ripgrep activity is projected
- **WHEN** the session emits an `rg` tool event
- **THEN** compact activity displays `Search` rather than `Rg` or a raw search pattern

### Requirement: Chat can enter Discover with a right-edge gesture
On supported mobile layouts, Chat SHALL allow a deliberate right-edge swipe left to reveal and open Discover without interfering with vertical scrolling or other overlays.

#### Scenario: Gesture crosses the threshold
- **WHEN** a touch begins in the right-edge activation zone and moves left with horizontal dominance beyond the commit threshold
- **THEN** Discover opens directly and one Back action returns to the same chat

#### Scenario: Gesture is cancelled
- **WHEN** the movement remains below threshold or becomes vertically dominant
- **THEN** the preview springs back and Chat remains active

### Requirement: Explore live Copilot tile prioritizes current work
The Explore live Copilot tile SHALL present one clear current activity, real streaming assistant text, limited deduplicated history, meaningful elapsed time, and an integrated path back to chat.

#### Scenario: Repeated identical tools complete
- **WHEN** adjacent tool events have the same compact presentation
- **THEN** the tile collapses them into one truthful summarized activity rather than rendering duplicate rows

#### Scenario: Approval needs attention
- **WHEN** a pending approval or elicitation exists
- **THEN** the tile replaces the normal feed with one clear attention action that opens Chat

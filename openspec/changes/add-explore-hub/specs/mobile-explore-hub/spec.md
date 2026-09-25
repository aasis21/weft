## ADDED Requirements

### Requirement: Permanent Explore entry
The mobile application SHALL display a permanent compass action in the active session header without changing the existing session title or Live, Quiet, Working, Offline, or related status subtitle.

#### Scenario: Open Explore from an active chat
- **WHEN** the user activates the compass action from an active session
- **THEN** the application opens the full-screen Explore home and preserves the active chat state for return

#### Scenario: Explore entry remains stable
- **WHEN** the active agent changes between idle, working, completed, or blocked states
- **THEN** the compass action remains in the same header position and neighboring session actions do not shift

### Requirement: Explore home and category navigation
Explore SHALL present an Agent Pulse and four category choices named Discover, Watch, Play, and Unwind.

#### Scenario: First opening
- **WHEN** the user opens Explore without a remembered category
- **THEN** the application shows the Explore home with four category cards and Agent Pulse

#### Scenario: Open a category
- **WHEN** the user selects a category card
- **THEN** the application shows that category and replaces the large cards with compact tabs for all four categories

#### Scenario: Return navigation
- **WHEN** the user navigates back from a category
- **THEN** the application returns to Explore home, and a subsequent back action returns to the preserved chat

### Requirement: Agent Pulse
Explore SHALL display a fixed-height Agent Pulse derived only from Weft's local encrypted session state.

#### Scenario: Agent is working
- **WHEN** the active session is busy and has an intent or running tool
- **THEN** Agent Pulse shows a concise current activity and elapsed time without changing the chat status subtitle

#### Scenario: Work needs user input
- **WHEN** an approval or elicitation is pending
- **THEN** Agent Pulse indicates that attention is required and activation opens the actionable Weft-owned request

#### Scenario: Agent is idle
- **WHEN** no turn is running and no action is pending
- **THEN** Agent Pulse remains present and shows a ready or recent-activity state

#### Scenario: View agent detail
- **WHEN** the user activates a non-blocked Agent Pulse
- **THEN** Explore shows an agent activity view containing current or recent timeline information and a route back to the conversation

### Requirement: Bundled Discover content
Discover SHALL provide 50 original, bundled, offline-readable cards with stable identifiers, titles, concise bodies, content categories, and estimated reading durations.

#### Scenario: Browse cards offline
- **WHEN** the device has no network connection
- **THEN** the user can browse and read every bundled Discover card

#### Scenario: Read a card
- **WHEN** the user opens a Discover card
- **THEN** the application presents readable typography, semantic headings, estimated duration, and a route back to the prior card position

### Requirement: Isolated Watch integration
Watch SHALL support an optional auto-updating third-party short-video widget loaded only after explicit user action and isolated from the Weft application.

#### Scenario: Provider is configured
- **WHEN** the user opens Watch and explicitly chooses to load external videos
- **THEN** the application loads the configured provider in a sandboxed iframe without passing prompts, session IDs, repository data, filenames, tool data, or agent activity

#### Scenario: Provider is unavailable
- **WHEN** the provider is unconfigured, offline, blocked, or fails to load within the allowed time
- **THEN** Watch shows an explicit unavailable state with a retry action and does not display a blank or misleading success state

#### Scenario: Video does not autoplay
- **WHEN** the Watch category is opened
- **THEN** video and audio do not begin until the user explicitly starts playback

### Requirement: Local Play activities
Play SHALL provide Threadline and Signal Steps as offline, locally executed activities without advertisements, external navigation, or network requirements.

#### Scenario: Complete a Threadline puzzle
- **WHEN** the user moves all Threadline nodes until no lines cross
- **THEN** the application marks the puzzle complete, records local progress, and provides non-color completion feedback

#### Scenario: Play Signal Steps
- **WHEN** the user repeats the displayed sequence correctly
- **THEN** the application advances the sequence and records the best local result

#### Scenario: Operate games accessibly
- **WHEN** the user operates a game with keyboard controls, assistive technology, reduced motion, or touch
- **THEN** the core game remains understandable and operable

### Requirement: Native Unwind activities
Unwind SHALL provide Weave Breath and Eye Horizon as bounded, locally executed rest experiences.

#### Scenario: Run Weave Breath
- **WHEN** the user starts a configured breathing duration
- **THEN** the application guides inhale and exhale phases, respects reduced-motion settings, and ends without automatically starting another activity

#### Scenario: Run Eye Horizon
- **WHEN** the user starts Eye Horizon
- **THEN** the application presents a twenty-second look-away timer and provides optional completion feedback

### Requirement: Explore interruption priority
Explore SHALL preserve Weft-owned approvals, elicitations, errors, and completed-response awareness above all Explore content.

#### Scenario: Approval arrives over external video
- **WHEN** an approval request arrives while the Watch iframe is visible
- **THEN** the application presents the approval in a Weft-owned layer above the iframe

#### Scenario: Reply completes during an activity
- **WHEN** the assistant completes a reply while the user is in Discover, Watch, Play, or Unwind
- **THEN** Agent Pulse changes to Reply ready without forcibly navigating away from the activity

### Requirement: Explore privacy and persistence
Explore SHALL keep personalization and activity state local and SHALL NOT disclose private Weft session context to content providers.

#### Scenario: Persist local preferences
- **WHEN** the user changes category, reading progress, game progress, or unwind preferences
- **THEN** the application stores only those Explore-specific values in local application storage

#### Scenario: Load external content
- **WHEN** the external Watch provider is loaded
- **THEN** the provider receives no Weft-generated context beyond the browser information inherently required to serve the embedded page

### Requirement: Mobile accessibility and layout
Explore SHALL remain usable on supported narrow mobile viewports and with relevant accessibility settings.

#### Scenario: Narrow viewport
- **WHEN** Explore is displayed on the smallest supported phone width
- **THEN** header controls retain usable touch targets and content does not require horizontal page scrolling

#### Scenario: Reduced motion
- **WHEN** the operating system requests reduced motion
- **THEN** Agent Pulse, games, and unwind activities use static or reduced-motion alternatives without losing state information

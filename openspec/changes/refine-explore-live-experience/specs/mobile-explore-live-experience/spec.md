## ADDED Requirements

### Requirement: Shared Explore header
Explore SHALL use the established Weft sessions navigation affordance rather than a nested-page Back control.

#### Scenario: Open sessions from Explore
- **WHEN** the user activates the three-line button in Explore
- **THEN** the application opens the same session drawer used by the active chat

#### Scenario: Compact header
- **WHEN** Explore is displayed on mobile
- **THEN** the header contains the sessions button, Explore title, and compact accessible tiles for Discover, Watch, Play, and Unwind without a separate category band

#### Scenario: Active category
- **WHEN** an Explore category is selected
- **THEN** its header tile expands to show the category label while the other category tiles remain compact

#### Scenario: Desktop-wide navigation
- **WHEN** the persistent desktop session sidebar is visible
- **THEN** Explore shows the established static Weft mark instead of a redundant hamburger

### Requirement: Live Copilot Dock
Explore SHALL display a fixed bottom dock that projects live state from the active GitHub Copilot CLI session.

#### Scenario: Stream assistant text
- **WHEN** an assistant response is arriving through assistant deltas
- **THEN** the current dock activity line updates normalized text in place with a live indicator without changing height

#### Scenario: Show ordered tool activity
- **WHEN** tools start, complete, or fail while the session is working
- **THEN** the dock shows up to three real assistant and tool events in timeline order and rolls older activity upward

#### Scenario: Do not invent activity
- **WHEN** the session remains busy without receiving a new assistant or tool event
- **THEN** the dock preserves the latest real event with elapsed time and an active indicator rather than fabricating progress text

#### Scenario: Show work before text arrives
- **WHEN** the session is busy but has no streamed assistant text
- **THEN** the dock shows current intent or the latest running tool with elapsed work time

#### Scenario: Work needs attention
- **WHEN** an approval or elicitation is pending
- **THEN** the dock shows a visually and semantically distinct attention state describing the blocked action

#### Scenario: Reply is ready
- **WHEN** the assistant completes while the user remains in Explore
- **THEN** the dock shows Reply ready with a bounded response preview without navigating away

#### Scenario: Return to chat
- **WHEN** the user activates any Live Copilot Dock state
- **THEN** the application returns directly to the active conversation

#### Scenario: No duplicate activity surface
- **WHEN** the user interacts with live status in Explore
- **THEN** the application does not open a separate Agent Activity view, step list, approval dialog, or elicitation form inside Explore

### Requirement: Swipeable Discover deck
Discover SHALL present one complete useful-idea card at a time without topic filters, a multi-card list, or a separate reader screen.

#### Scenario: Open Discover
- **WHEN** the user selects Discover
- **THEN** the application immediately shows one complete card with topic, deck position beside duration, title, summary, and useful insight without a standalone illustration or bottom action row

#### Scenario: Advance by touch
- **WHEN** the user swipes left beyond the gesture threshold
- **THEN** the current card follows the gesture, exits left, reveals the next card, and advances exactly once

#### Scenario: Return by touch
- **WHEN** the user swipes right beyond the gesture threshold and a prior card exists
- **THEN** the current card follows the gesture, exits right, reveals the previous card, and returns exactly once

#### Scenario: Cancel an incomplete swipe
- **WHEN** a horizontal gesture ends before the navigation threshold
- **THEN** the current card springs back without changing deck position

#### Scenario: Operate without touch
- **WHEN** the user presses Arrow Left, Arrow Right, or the accessible Previous and Next controls
- **THEN** Discover performs the equivalent animated single-card navigation from controls positioned at the card's vertical edges

#### Scenario: Preserve vertical scrolling
- **WHEN** enlarged content requires scrolling
- **THEN** vertical gestures scroll the current card without changing cards

### Requirement: Balanced deterministic discovery
Discover SHALL generate a locally deterministic deck that varies topics and avoids repeats until the catalog is exhausted.

#### Scenario: Build a daily deck
- **WHEN** a Discover cycle begins
- **THEN** the application deterministically shuffles cards within topics and interleaves topics using a local daily seed

#### Scenario: Avoid adjacent topic clusters
- **WHEN** cards from multiple topics remain available
- **THEN** the deck avoids adjacent cards from the same topic when an alternative topic is available

#### Scenario: Resume position
- **WHEN** the user leaves and later reopens Discover on the same cycle
- **THEN** the application restores the same deck and current card

#### Scenario: Exhaust a cycle
- **WHEN** the user reaches the final unseen card
- **THEN** the next advance begins a newly seeded complete cycle

### Requirement: Single-screen Explore layout
Explore SHALL fit its standard mobile experiences within the dynamic viewport without page scrolling.

#### Scenario: Explore home
- **WHEN** Explore home is displayed at a supported standard phone size
- **THEN** the compact header, four `2 x 2` category choices, and Live Copilot Dock are simultaneously visible without page scrolling or a Continue card

#### Scenario: Category view
- **WHEN** a category is displayed at a supported standard phone size
- **THEN** the integrated header navigation, category content, and taller Live Copilot Dock are simultaneously visible without page scrolling

#### Scenario: Short viewport
- **WHEN** viewport height is below the comfortable breakpoint
- **THEN** decorative illustrations and spacing reduce before readable text or controls are removed

#### Scenario: Enlarged accessibility text
- **WHEN** accessibility text scaling prevents content from fitting safely
- **THEN** only the flexible content region may scroll while the global header and Live Copilot Dock remain stable

#### Scenario: Reduced motion
- **WHEN** the operating system requests reduced motion
- **THEN** dock updates and card changes preserve all state information without sliding or marquee animation

### Requirement: Explore navigation history
Explore SHALL preserve predictable system Back behavior without recording every card swipe.

#### Scenario: Back from a category
- **WHEN** the user invokes system or browser Back from an Explore category or activity detail
- **THEN** the application returns to Explore home

#### Scenario: Back from Explore home
- **WHEN** the user invokes system or browser Back from Explore home
- **THEN** the application returns to the preserved active chat

#### Scenario: Swipe cards
- **WHEN** the user navigates between Discover cards
- **THEN** the application does not create browser history entries for individual cards

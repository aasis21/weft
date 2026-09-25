## Why

Explore currently behaves like a nested content page: Agent Pulse occupies premium space at the top, opens a second activity screen, and Discover requires choosing filters and cards before reading. The phone experience should instead keep Copilot visibly alive in one compact bottom dock while every Explore category fits the viewport and Discover removes choice paralysis through a single swipeable idea deck.

## What Changes

- Replace the top Agent Pulse and Agent Activity screen with a persistent bottom Live Copilot Dock.
- Stream the latest assistant text in the dock, with intent, active tool, elapsed work, reply-ready, blocked, error, and idle fallbacks compacted into the same fixed space.
- Make the dock return directly to the active chat when activated.
- Replace the Explore Back and saved-card header actions with the existing sessions hamburger, compass mark, and a compact Explore title.
- Reuse the existing session drawer rather than introducing an Explore-specific menu.
- Replace Discover topic filters, multi-card feed, and separate reader with one complete vertically swipeable card at a time.
- Build a deterministic balanced deck that varies topics, avoids repeats until exhaustion, and preserves position locally.
- Keep per-card Save as a local signal for later personalization without exposing a saved-content list or personalization controls.
- Reflow Explore home, Watch, Play, and Unwind into a fixed `100dvh` shell with no page scrolling at standard mobile text sizes.
- Preserve safe internal scrolling only when accessibility text scaling makes it necessary.

## Capabilities

### New Capabilities

- `mobile-explore-live-experience`: Compact Explore shell, shared session navigation, live Copilot dock, swipeable balanced Discover deck, viewport fitting, persistence, and accessibility behavior.

### Modified Capabilities

None.

## Impact

- Mobile application shell and session-drawer ownership.
- Explore navigation, live session projection, interruptions, and chat return behavior.
- Discover presentation, ordering, gestures, persistence, and catalog constraints.
- Explore responsive styling and safe-area handling.
- Focused App, session-header, Explore, persistence, gesture, reduced-motion, and accessibility tests.
- Explore design, setup, and privacy documentation where behavior descriptions change.

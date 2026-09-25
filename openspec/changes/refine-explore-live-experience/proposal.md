## Why

Explore currently behaves like a nested content page: Agent Pulse occupies premium space at the top, opens a second activity screen, and Discover requires choosing filters and cards before reading. The phone experience should instead keep Copilot visibly alive in one compact bottom dock while every Explore category fits the viewport and Discover removes choice paralysis through a single swipeable idea deck.

## What Changes

- Replace the top Agent Pulse and Agent Activity screen with a persistent bottom Live Copilot Dock.
- Stream the latest assistant text in the dock, with intent, active tool, elapsed work, reply-ready, blocked, error, and idle fallbacks compacted into the same fixed space.
- Make the dock return directly to the active chat when activated.
- Replace the Explore Back and right-side header actions with the existing sessions hamburger, compass mark, and a compact Explore title.
- Move Discover, Watch, Play, and Unwind into compact header tiles, with the active category expanded and the separate category band removed.
- Reuse the existing session drawer rather than introducing an Explore-specific menu.
- Replace Discover topic filters, multi-card feed, and separate reader with one complete horizontally swipeable card at a time.
- Remove the large card illustration, move deck position beside duration, place navigation controls at the card edges, and animate drag, exit, reveal, and spring-back motion.
- Build a deterministic balanced deck that varies topics, avoids repeats until exhaustion, and preserves position locally.
- Remove the Discover card-side secondary action and its persisted field.
- Increase the Live Copilot Dock height and render an ordered, continuously updating feed of real assistant and tool activity rather than only the latest text excerpt.
- Reflow Explore home, Watch, Play, and Unwind into a fixed `100dvh` shell with no page scrolling at standard mobile text sizes.
- Preserve safe internal scrolling only when accessibility text scaling makes it necessary.

## Capabilities

### New Capabilities

- `mobile-explore-live-experience`: Compact Explore shell, shared session navigation, live Copilot dock, swipeable balanced Discover deck, viewport fitting, persistence, and accessibility behavior.

### Modified Capabilities

None.

## Impact

- Mobile application shell and session-drawer ownership.
- Explore header navigation, live session projection, ordered activity rendering, interruptions, and chat return behavior.
- Discover presentation, ordering, gestures, persistence, and catalog constraints.
- Explore responsive styling and safe-area handling.
- Focused App, session-header, Explore, persistence, gesture, reduced-motion, and accessibility tests.
- Explore design, setup, and privacy documentation where behavior descriptions change.

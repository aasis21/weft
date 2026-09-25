## Context

Explore 0.2.24 is a sibling application view layered above a still-mounted `SessionScreen`. It currently owns a Back button, top Agent Pulse, optional Agent Activity screen, Weft-owned interruption overlay, Discover filters/feed/reader, and category-specific activities. The active `SessionView` already exposes streaming assistant items assembled from `assistant_delta`, live intent, running tools, busy timing, approvals, elicitations, unread state, errors, and session status.

The redesigned surface must fit normal phone viewports without page scrolling, preserve chat state, reuse the established session drawer, avoid a second activity/details destination, and remain accessible with touch, keyboard, screen readers, reduced motion, and enlarged text.

## Goals / Non-Goals

**Goals:**

- Make live Copilot work continuously visible in one fixed bottom dock.
- Stream current assistant text in place and compact all fallback activity states into the same region.
- Return directly to chat when the dock is activated.
- Give Explore the same hamburger/session-drawer affordance as the active chat.
- Consolidate category navigation into the header so the separate tab band does not consume viewport height.
- Make Discover a one-card-at-a-time, horizontally swipeable, balanced deck with no filters, list, reader transition, or card-side secondary action.
- Make card movement feel direct through drag-follow, spring-back, exit, and next-card reveal animation.
- Make the dock read as a live activity window by showing real assistant and tool events in order.
- Fit the Explore home and normal category experiences inside `100dvh` without page scrolling.
- Preserve local reading, game, and unwind state through the existing bounded storage key.

**Non-Goals:**

- Supporting non-GitHub-Copilot agents or a generic agent protocol.
- Building recommendations, accounts, cloud personalization, or a content library.
- Adding new protocol messages; all live dock data comes from the existing decrypted session projection.
- Turning Explore into a mobile IDE, file browser, or diff viewer in this change.
- Guaranteeing zero scrolling at extreme accessibility text scales where clipping would be worse.

## Decisions

### Explore is rendered inside the active session shell

`SessionScreen` will host the Explore overlay so its existing drawer controller and `SessionDrawer` remain authoritative. The App shell will continue to own browser history state, but it will pass Explore-open state and close callbacks into the active session screen rather than rendering an independent sibling that cannot open the drawer.

Alternative considered: duplicate the drawer or lift all drawer state and rendering into `App.tsx`. Rejected because it would create a second navigation implementation or broaden App ownership unnecessarily.

### The header is a stable shared-navigation header

Explore will show the existing unread-aware hamburger on mobile or the static Weft mark on desktop-wide layouts, the title `Explore`, and four compact category tiles. The active tile expands to include its label while inactive tiles remain icon-first. All tiles retain accessible names and minimum touch targets. The separate category tab band is removed.

System/browser Back remains hierarchical: category or activity detail returns to Explore home, then the next Back returns to chat. Internal games and unwind activities retain small in-content return controls.

### Live Copilot Dock derives from the current timeline

A pure projection will choose dock content in this order:

1. Pending approval or elicitation.
2. Session error or ended state.
3. Latest non-final assistant text while busy.
4. Current intent.
5. Latest running tool.
6. Completed unread reply preview.
7. Ready or recent activity.

The dock uses a fixed height approximately one and a half times the original compact dock. It renders a status row and up to three ordered activity lines derived from the existing timeline. Assistant deltas update their current line in place with a live cursor; tool starts, completions, and failures appear as compact rows and roll upward as newer events arrive. Intent is used as context when no assistant or tool event is available. Quiet periods never fabricate activity: elapsed time and an active indicator continue while the latest real event remains visible. Activating any dock state returns to chat. Approvals and elicitations are handled by the existing chat cards; Explore no longer renders a duplicate interruption dialog.

Alternative considered: keep Agent Pulse plus an Agent Activity destination. Rejected because it duplicates chat, consumes vertical space, and makes users choose between two representations of the same work.

### Discover is one complete card, not a feed plus reader

Discover will render one dense card that includes topic, deck progress, duration, title, summary, and useful insight. Deck progress sits beside duration in the top metadata row. The large standalone illustration and bottom action row are removed. Previous and Next controls sit at the vertical card edges without consuming a content row. Topic filters, feed cards, and reader state remain removed.

Horizontal swipe left advances and swipe right returns to the previous card. During a horizontal drag the card follows the pointer with bounded rotation while the adjacent card is revealed beneath it. Crossing the threshold animates the current card off-screen and promotes the revealed card; an incomplete gesture springs back. Arrow Left/Right and the edge controls use the same transition. Vertical gestures remain available for accessibility overflow scrolling, and reduced-motion mode performs the same state change without spatial animation.

### The deck is balanced, deterministic, and locally resumable

The deck builder will:

- group cards by topic,
- deterministically shuffle each topic bucket from a daily seed,
- interleave buckets so adjacent cards vary when possible,
- rotate the starting topic by seed,
- include every catalog card once before repeating,
- persist seed/day and current index,
- advance to a new seeded cycle only after exhaustion.

Completed-card state records cycle progress without changing deck order.

Alternative considered: `Array.sort(() => Math.random() - 0.5)` on each mount. Rejected because it is biased, unstable across renders, clusters topics, and cannot restore position.

### Viewport fitting is structural, not clipping

Explore uses a `100dvh` grid with one fixed header containing category navigation, flexible content, and a fixed Live Copilot Dock. Removing the category band and Discover illustration funds the taller live dock without increasing page height. The home removes the introductory paragraph and Continue card; four category choices use a compact `2 x 2` grid. Category content uses `minmax(0, 1fr)` and no page overflow.

Discover catalog tests enforce concise title, summary, and insight limits so normal cards fit without CSS line-clamping away content. Height breakpoints reduce decoration and spacing before reducing readable text. At extreme text scaling, the flexible content region may scroll internally while the global page and dock remain stable.

### History records detail presence, not every card

Entering a category or activity detail creates at most one Explore-detail history entry. Swiping Discover cards and switching categories update local state without adding browser history entries. This preserves predictable system Back behavior and avoids dozens of history entries during casual swiping.

## Risks / Trade-offs

- **Streaming text changes too rapidly to read** → Normalize whitespace, show only the newest bounded excerpt, and update in place without marquee motion.
- **A busy activity feed becomes visual noise** → Limit the dock to three real ordered events, keep the current event visually dominant, and never synthesize progress messages.
- **A long card overflows short phones** → Enforce content limits, remove decorative media at short heights, and allow accessibility-only internal scrolling.
- **Horizontal swipe conflicts with platform navigation** → Discover requires a dominant horizontal threshold and retains explicit controls, while vertical gestures remain native scrolling.
- **Drag animation causes motion discomfort** → Respect reduced-motion preferences and commit navigation without spatial transitions.
- **Drawer integration destabilizes SessionScreen** → Reuse its existing state and component, keep Explore as an overlay within the same mounted shell, and add App/session integration tests.
- **Daily order feels repetitive** → Persist a complete cycle, rotate by day, and reseed after catalog exhaustion without repeating within a cycle.
- **Removing Explore approval overlays delays action** → The dock uses a high-contrast attention state and returns directly to the canonical chat card.

## Migration Plan

1. Extend the existing Explore storage record with optional deck day, seed, and index fields; tolerate all 0.2.24 records.
2. Keep existing completed card IDs and discard the obsolete per-card preference field.
3. Remove obsolete topic/reader/activity-detail UI without deleting compatible stored fields.
4. Ship through the standard versioned `ship.ps1` production pipeline.
5. Roll back by restoring the 0.2.24 Explore module; additive storage fields remain harmless.

## Open Questions

None. The agreed interaction is fixed: integrated category header, taller real-event dock returning to chat, and dense animated horizontal Discover cards with no list or filters.

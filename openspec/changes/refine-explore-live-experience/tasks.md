## 1. Shared Explore Shell

- [x] 1.1 Render Explore within the mounted active session shell so it can reuse the existing session drawer
- [x] 1.2 Replace the Explore Back and right-side header actions with the mobile hamburger or desktop Weft mark, compass, and compact title
- [x] 1.3 Preserve system Back behavior from category or activity to Explore home and then chat
- [x] 1.4 Reflow the Explore shell into fixed header, optional tabs, flexible content, and bottom dock viewport bands
- [x] 1.5 Compact Explore home to a no-scroll title and `2 x 2` category grid without the introductory paragraph or Continue card

## 2. Live Copilot Dock

- [x] 2.1 Implement a pure dock projection for attention, error, streaming text, intent, running tool, reply-ready, and idle priorities
- [x] 2.2 Render normalized streaming assistant text in a fixed-height two-line bottom dock
- [x] 2.3 Show elapsed work and compact intent or tool detail without growing the dock
- [x] 2.4 Make all dock states return directly to the active chat
- [x] 2.5 Remove Agent Pulse, Agent Activity, and Explore-owned approval and elicitation overlays
- [x] 2.6 Add focused tests for streaming updates, priority ordering, fixed content bounds, attention states, and chat return

## 3. Swipeable Discover Deck

- [x] 3.1 Replace topic filters, feed cards, and reader state with one complete Discover card
- [x] 3.2 Implement deterministic per-topic shuffling and balanced topic interleaving from a daily seed
- [x] 3.3 Persist deck day, cycle seed, and current index while migrating existing Explore storage safely
- [x] 3.4 Implement horizontal swipe thresholds for next and previous while preserving vertical scrolling
- [x] 3.5 Add Arrow Left, Arrow Right, and accessible Previous and Next controls
- [x] 3.6 Remove the per-card secondary action and its legacy persisted field
- [x] 3.7 Add catalog length constraints and remove repeated reader-only copy so every standard card fits
- [x] 3.8 Add logic and interaction tests for deterministic balance, no repeats, persistence, gestures, keyboard operation, cycle exhaustion, and storage migration

## 4. Category Viewport Fitting

- [x] 4.1 Fit Watch, Play, and Unwind pickers inside the flexible viewport region without page scrolling
- [x] 4.2 Scale Threadline, Signal Steps, Weave Breath, and Eye Horizon controls for short phones
- [x] 4.3 Add short-height and reduced-motion styling that removes decoration before readable content
- [x] 4.4 Preserve accessibility-only internal scrolling for enlarged text without moving the global dock
- [x] 4.5 Add focused layout contract tests for home, categories, and dock-safe content padding

## 5. Documentation and Validation

- [x] 5.1 Update Explore documentation and privacy wording for the live dock, canonical chat actions, and shuffled local deck
- [x] 5.2 Run focused mobile tests and mobile test type-checking
- [x] 5.3 Run complete repository tests, build, lint, and version checks
- [x] 5.4 Review the final diff for navigation, streaming privacy, gesture conflicts, accessibility, viewport fitting, and unrelated changes
- [x] 5.5 Validate all OpenSpec artifacts and mark every completed task

## 6. Dense Animated Explore Refinement

- [x] 6.1 Move category navigation into compact accessible header tiles and remove the separate category band
- [x] 6.2 Remove the Discover illustration and bottom controls, move deck position beside duration, and add card-edge navigation
- [x] 6.3 Implement pointer-follow, bounded rotation, adjacent-card reveal, exit, spring-back, keyboard, and reduced-motion behavior
- [x] 6.4 Increase the Live Copilot Dock height and render up to three ordered real assistant and tool events
- [x] 6.5 Add focused tests for integrated navigation, dense card layout, swipe motion, real activity ordering, and quiet working behavior
- [ ] 6.6 Run complete validation, review, merge, release, and verify production

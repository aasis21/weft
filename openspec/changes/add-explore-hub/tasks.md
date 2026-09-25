## 1. Explore Shell and Navigation

- [x] 1.1 Add stable Explore route state and history/back behavior to the mobile application shell
- [x] 1.2 Add the permanent accessible compass action before the existing start-session action without changing the status subtitle
- [x] 1.3 Build the responsive Explore home with fixed-height Agent Pulse and Discover, Watch, Play, and Unwind cards
- [x] 1.4 Build category navigation that replaces home cards with compact tabs and preserves the last selected category
- [x] 1.5 Add shared Explore styling for narrow phones, safe areas, light/dark themes, and reduced motion

## 2. Agent Pulse and Interruptions

- [x] 2.1 Implement a pure Agent Pulse projection over active session state with blocked, error, working, reply-ready, and idle priorities
- [x] 2.2 Build the Agent activity detail view from existing intent and timeline information
- [x] 2.3 Route pending approvals and elicitations to Weft-owned actionable overlays above every Explore category
- [x] 2.4 Add focused tests for pulse priority, status independence, activity detail, and interruption behavior

## 3. Discover Content

- [x] 3.1 Define the typed Discover card model and add all 50 original bundled starter cards
- [x] 3.2 Build the Discover card feed and accessible reader with estimated duration and return-position preservation
- [x] 3.3 Add local reading-completion persistence using repository-standard storage helpers
- [x] 3.4 Add tests for catalog integrity, offline rendering, reader navigation, and reading state

## 4. Watch Integration

- [x] 4.1 Add build-time configuration for the external widget URL without committing provider credentials
- [x] 4.2 Build an explicit-load, sandboxed iframe surface that passes no Weft session context
- [x] 4.3 Add loading, offline, timeout, unconfigured, blocked, retry, and provider-disclosure states
- [x] 4.4 Ensure approvals and elicitations remain operable above the iframe and add focused privacy/lifecycle tests

## 5. Play Activities

- [x] 5.1 Implement deterministic Threadline puzzle generation, touch/keyboard node movement, completion detection, and local progress
- [x] 5.2 Implement deterministic Signal Steps sequencing, accessible controls, round progression, and local best score
- [x] 5.3 Add daily/free-play selection and non-color feedback while respecting reduced-motion and vibration preferences
- [x] 5.4 Add focused logic and interaction tests for both games

## 6. Unwind Activities

- [x] 6.1 Implement Weave Breath durations, phase timing, reduced-motion presentation, optional vibration, pause, and completion
- [x] 6.2 Implement Eye Horizon's bounded twenty-second rest timer and optional completion feedback
- [x] 6.3 Add focused fake-timer, reduced-motion, and lifecycle tests for both unwind activities

## 7. Documentation and Validation

- [x] 7.1 Document Explore behavior, third-party video boundaries, privacy, configuration, and offline capabilities
- [x] 7.2 Run focused mobile tests and mobile test type-checking
- [x] 7.3 Run the complete repository test, build, lint, and version checks required by AGENTS.md
- [x] 7.4 Review the final diff for privacy, accessibility, mobile layout, external-content isolation, and unrelated changes

## Why

Long-running agent turns leave mobile users with little to do beyond watching a small status label, which makes the session feel stalled even when useful work is progressing. Weft can make that time useful without crowding the chat by adding a permanent, optional Explore destination that combines concise agent awareness with lightweight reading, video, play, and rest experiences.

## What Changes

- Add a permanent compass action to the mobile session header without changing the existing read-only Live, Quiet, or Working status line.
- Add a full-screen Explore destination with a compact always-visible Agent Pulse and four entry points: Discover, Watch, Play, and Unwind.
- Add an Agent activity view derived from existing encrypted session state, including current intent, elapsed work, tool progress, completion, approval, and connection states.
- Add 50 original bundled Discover cards with local reading and save state.
- Add a lazy, isolated third-party short-video widget surface for Watch, with explicit loading, no session-context sharing, and a safe unavailable/configuration fallback.
- Add two offline games: Threadline and Signal Steps.
- Add two native rest experiences: Weave Breath and Eye Horizon.
- Preserve Explore navigation and activity state across chat transitions while ensuring approvals and elicitation requests remain immediately actionable.
- Add focused accessibility, privacy, interaction, and mobile-layout tests.

## Capabilities

### New Capabilities
- `mobile-explore-hub`: Permanent Explore navigation, Agent Pulse, bundled content, isolated video embedding, local games, unwind activities, persistence, interruptions, accessibility, and privacy boundaries.

### Modified Capabilities

None.

## Impact

- Mobile React navigation and session-screen header controls.
- New Explore UI, content catalog, local persistence, games, unwind activities, and tests.
- Existing session activity selectors and timeline data, reused without changing the encrypted protocol for the initial release.
- Mobile styling, responsive layout, reduced-motion behavior, and accessibility labels.
- Optional third-party video-widget configuration and Content Security Policy/iframe allowances; no agent, repository, prompt, filename, or session content may be passed to the provider.
- User documentation describing Explore behavior, external video content, privacy, and configuration.

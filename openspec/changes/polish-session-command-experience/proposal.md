## Why

Several recently completed mobile UX fixes never reached `main`, while the shipped chat and Explore surfaces still expose avoidable friction: heartbeat updates can pull readers to the latest message, internal tool names leak into user-facing activity, command arguments require ad hoc handling, and Discover lacks a direct gesture from chat. These issues should land together because they share the same goal: make Weft feel like a coherent mobile control surface for a live Copilot session.

## What Changes

- Recover the abandoned ordered-list numbering, Start Session name-field, compact resume-list, and shell ToolCard improvements without restoring stale release metadata.
- Preserve a reader's explicit scroll-away intent across heartbeat, streaming, and layout updates until they deliberately return to the latest message.
- Add a right-edge mobile gesture that reveals Discover from chat and returns to the same chat with one Back action.
- Centralize lightly humanized tool labels so Chat and Explore show consistent, explainable names without exposing raw internal identifiers.
- Redesign the Explore live Copilot tile around one current activity, streaming assistant text, deduplicated recent activity, meaningful elapsed time, and an integrated Open Chat action.
- Deepen the shared phone-command definition into a generic command-argument platform supporting no input, free text, curated options, filtering, hidden values, optional custom text, validation, and confirmation.
- Use that platform to present a curated mobile `/model` chooser while keeping model IDs internal and validating the selected value again on the extension.

## Capabilities

### New Capabilities

- `mobile-session-command-experience`: Mobile chat, Explore, session-launch, resume-list, ToolCard, Markdown, and phone-command behavior for controlling a live Copilot CLI session.

### Modified Capabilities

None.

## Impact

- Shared phone-command declarations and runtime validation.
- Extension command invocation and tests.
- Mobile session state, composer command palette, ChatThread scrolling, ToolCard and Markdown rendering, Start Session and resume-list UX, Explore navigation and live activity presentation.
- OpenSpec, product documentation, focused tests, complete monorepo validation, release packaging, and hosted PWA deployment.

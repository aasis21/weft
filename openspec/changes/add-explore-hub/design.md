## Context

Weft's mobile application currently renders one primary surface at a time from `App.tsx`: onboarding, device management, shared terminal, or the active Copilot session. The session header already exposes stable actions for starting and joining sessions, and the session model already carries the data needed for a useful activity summary: connection status, busy state, agent intent, thinking start time, approvals, elicitations, and tool timeline items.

Explore must be permanently reachable without changing the existing Live, Quiet, or Working status line and without inserting frequently changing elements into `ChatThread`, whose scrolling behavior intentionally protects users reading earlier messages. The feature also introduces bundled content, local interactive activities, and optional untrusted third-party video code, so privacy, isolation, accessibility, offline behavior, and interruption priority must be explicit.

## Goals / Non-Goals

**Goals:**

- Add a stable compass action and a full-screen Explore destination that preserves chat state.
- Keep a compact Agent Pulse visible across Explore home and category views.
- Provide useful offline Discover, Play, and Unwind experiences.
- Support a lazily loaded auto-updating short-video widget without sending Weft context to it.
- Preserve immediate access to approvals and elicitation requests.
- Reuse current encrypted session state without a protocol change.
- Keep the initial implementation coherent and testable without fragmenting it into many small modules.

**Non-Goals:**

- Building a recommendation service, social graph, account system, or cloud-synced game leaderboard.
- Sending prompts, repository information, filenames, tool arguments, or session metadata to content providers.
- Automatically playing video or audio.
- Replacing the existing chat status line or deriving chat liveness from Explore.
- Supporting arbitrary third-party HTML or user-provided scripts.
- Implementing downloadable content packs or RSS sources in the first release.

## Decisions

### Explore is a sibling application view

`App.tsx` will own an `exploreOpen` route state alongside the existing device and terminal views. Opening Explore will not unmount or mutate the active session runtime; returning to chat will restore the existing conversation and its scroll state through the current conversation-key behavior.

Alternative considered: insert Explore into `ChatThread` or above the composer. Rejected because it permanently consumes chat space and live updates can cause layout movement.

### The compass action is permanent and status-independent

The session header will receive a dedicated compass action immediately before the existing start-session action. It remains in a stable location regardless of agent state. The existing title and status subtitle remain read-only and unchanged.

Alternative considered: make the Working label tappable or only show an activity affordance while busy. Rejected because Explore must remain discoverable and useful when no agent is running, and conditional controls shift neighboring touch targets.

### Explore uses a dashboard followed by category tabs

The Explore home shows Agent Pulse plus four large choices: Discover, Watch, Play, and Unwind. Selecting one opens a category surface where those same choices become compact horizontal tabs. The dashboard and tabs are not shown simultaneously.

This preserves first-use clarity while allowing fast category switching after the user's intent is known.

### Agent Pulse derives from existing session state

Agent Pulse will use a pure projection over the active `SessionView`:

1. Pending approval or elicitation.
2. Connection error or ended session.
3. Busy session with agent intent, running tool description, or generic Working label.
4. Completed reply/unread state.
5. Ready or recent completed activity.

The pulse row always has a fixed layout height. Tapping a blocked state opens the relevant approval or elicitation surface; other states open an Agent activity view. No provider or content surface receives pulse data.

### Bundled content uses typed local data

The 50 Discover cards will be stored as typed application data with stable identifiers, category, title, summary, estimated duration, body sections, and optional illustration metadata. Reading and saved state will be persisted locally through the existing settings/storage conventions.

The initial cards use original text and local assets so Discover works offline and has no licensing or network dependency.

### Watch isolates vendor code

Watch will render a local explanatory placeholder until the user explicitly opens the video surface. The provider URL will come from a build-time Vite setting. When configured, it loads in a sandboxed iframe with the smallest permissions needed for scripts, presentation, and explicit outbound navigation. The parent passes no query parameters, session identifiers, referrer context beyond browser requirements, or postMessage payloads.

If the provider is not configured, blocked, offline, or fails to load within a bounded time, Watch shows an explicit unavailable state rather than an empty frame or success-shaped fallback.

Alternative considered: inject the provider's JavaScript into the React document. Rejected because it gives third-party code access to the application DOM and complicates CSP, lifecycle, and cleanup.

### Play and Unwind are local

Threadline is a deterministic SVG untangling puzzle. Signal Steps is a deterministic sequence-memory activity. Both use date-derived daily seeds plus free-play mode, local progress, keyboard/touch support, and no network access.

Weave Breath is a timed breathing exercise with reduced-motion behavior and optional vibration. Eye Horizon is a bounded twenty-second screen-rest timer. Neither automatically chains into another activity.

Alternative considered: embed a third-party game portal. Rejected for the initial release because ads, trackers, focus capture, navigation, and mobile controls would create substantially more risk than the small local games require.

### Interruptions remain owned by Weft

Approvals and elicitations render in a Weft-owned overlay above every Explore category, including the iframe. Normal tool updates only refresh Agent Pulse. A completed response updates the pulse to Reply ready but does not forcibly navigate back to chat.

### Persistence stays local and bounded

Explore stores only:

- last selected category,
- saved Discover card IDs,
- per-card reading completion,
- local game progress and daily scores,
- unwind preferences such as vibration,
- optional acknowledgement that external video content is provided by a third party.

No browsing history from the embedded provider is copied into Weft.

### Source organization favors substantial modules

The feature will use a small number of cohesive files: one Explore screen module for routing and presentation, one content catalog, and one activities module for local games/unwind logic, with focused test files. Splitting further is justified only where a component has an independently testable lifecycle such as the isolated video frame.

## Risks / Trade-offs

- **Third-party widget changes or blocks iframe use** → Keep the provider URL configurable, isolate it behind one component, detect load failure, and retain a useful offline Watch explanation.
- **Provider tracking or inappropriate content** → Load only after explicit action, disclose the provider, pass no Weft context, sandbox the frame, and document that provider policies apply inside it.
- **Explore competes with approvals** → Keep approvals and elicitations in Weft-owned overlays above all categories.
- **Header crowding on narrow phones** → Preserve minimum touch targets, use icon-only controls with accessible names, and test the smallest supported viewport.
- **Agent Pulse contradicts the chat status** → Derive both from the same session state helpers and test priority ordering.
- **Bundled content increases application size** → Store concise text and lightweight inline illustrations; avoid large media assets.
- **Games or animation ignore accessibility needs** → Provide keyboard operation, semantic labels, reduced-motion alternatives, optional vibration, and non-color status cues.
- **Activity state is stale after reconnection** → Use current session state only for live pulse details and label older information as recent history.

## Migration Plan

1. Ship Explore behind the presence of the new compass action; no persisted migration is required.
2. Default to bundled/local experiences when the video widget is unconfigured.
3. Configure and validate the provider URL separately for hosted production.
4. Roll back by removing the compass action and Explore route; all persisted Explore keys are isolated and safe to leave unused.

## Open Questions

- The final production widget URL and vendor account configuration must be supplied outside source control.
- Hosted and Capacitor builds must verify the exact iframe sandbox/CSP permissions required by the selected vendor before enabling it in production.

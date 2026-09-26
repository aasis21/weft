## Context

Weft `0.2.27` already keeps the active chat mounted beneath Explore, projects real assistant/tool activity into a bottom dock, and exposes a shared whitelist of phone-invokable CLI commands. However, command arguments are represented only as `none | optional | required`, Chat and Explore humanize tool names independently, and the chat-follow state depends too heavily on transient layout measurements. Two local commits from the previous 48 hours also contain useful UX fixes that never received a PR and now include stale release metadata.

The implementation spans `shared`, `extension`, and `mobile`, so compatibility and validation must remain centralized. Relays continue to carry encrypted envelopes only; this change does not expose additional private session content.

## Goals / Non-Goals

**Goals:**

- Recover only the still-missing behavior from the abandoned commits.
- Make explicit reader intent authoritative over heartbeat and layout churn.
- Provide one generic command-argument interface that supports future curated commands without Composer-specific branches.
- Offer a small, validated mobile model list while keeping model IDs out of visible UI.
- Make Chat and Explore tool names consistent and understandable.
- Add a direct mobile gesture into Discover without breaking browser Back, vertical scrolling, or Discover card swipes.
- Simplify the Explore live Copilot tile while preserving real ordered activity.

**Non-Goals:**

- Enumerating every model available to every Copilot account.
- Claiming an authoritative current model after reconnect when the CLI cannot report one.
- Changing relay encryption, pairing, or transport behavior.
- Restoring obsolete package versions, changelog entries, or entire abandoned commits.
- Replacing existing slash commands with a new remote execution mechanism.

## Decisions

### Recover abandoned work as focused edits

The ordered-list, Start Session, resume-list, and shell ToolCard changes will be reapplied against current `main`. The stale commits will not be cherry-picked because they mix release bumps and unrelated code with behavior that has since evolved.

### Deepen the shared command definition

`PhoneCommand.arg` will become a discriminated input definition:

- `none`
- `text` with required/optional semantics and a placeholder
- `options` with centrally declared values, labels, hints, aliases, and optional custom input

Shared helpers will resolve commands and validate option values. The mobile composer will consume the definition to drive command search, argument filtering, keyboard/touch selection, hidden values, confirmation, and submission. The extension will use the same definition to reject values that the phone was not allowed to send.

The curated `/model` definition will expose `Auto`, `GPT-5.6 Sol`, `Claude Sonnet 5`, and `Gemini 3.8 Flash`. Visible labels remain separate from internal CLI arguments. A successful command invocation can confirm the phone-requested choice for the current connection, but reconnects will not pretend that locally remembered state is authoritative.

### Centralize tool presentation

A small mobile presentation module will map internal names to explainable labels such as `Search`, `View`, `Edit Files`, `Activate Skill`, and `Read Agent`. It will prefer an existing human description for secondary detail, preserve useful basenames, and avoid exposing full paths or raw arguments in compact activity. ToolCard and Explore will share this interface.

### Latch reader detachment from touch intent

ChatThread will track the initial touch position and mark the reader detached as soon as a vertical gesture toward older messages crosses a small threshold. That latch survives heartbeat, busy-state, streaming, ResizeObserver, and momentum-scroll timing. It clears only when the reader genuinely returns near the bottom, taps Jump to latest, sends a phone prompt, or changes conversations.

### Treat direct Discover entry as a distinct history shape

App history will distinguish Explore-home navigation from a direct Chat-to-Discover entry. A right-edge gesture begins only on narrow/touch layouts, within a small right-edge activation zone, and only when conflicting overlays or the soft keyboard are absent. Horizontal dominance locks the gesture; a lightweight Discover preview follows the finger. Crossing the distance or velocity threshold opens Discover directly. Cancelling springs the preview back. One Back action returns to the same chat.

### Make the live Copilot tile a presence card

The tile will show:

- a Copilot glyph and sentence-case state,
- elapsed time only after it becomes meaningful,
- one primary current activity,
- up to two lines of streaming assistant text,
- at most one muted previous activity,
- consecutive duplicate tool events collapsed,
- an integrated `Open chat` affordance.

Attention and error states replace the activity feed with a single clear action. The card remains fully tappable and uses only real session events.

## Risks / Trade-offs

- **Curated model IDs may become unavailable** → Keep the list small, validate in the extension, surface the CLI failure, and preserve the prior session behavior.
- **Direct Discover gestures can conflict with vertical scrolling** → Require an edge start and horizontal dominance before preventing native scrolling.
- **Touch-intent latching can stop legitimate following** → Clear only on measured return to the bottom, explicit Jump to latest, phone send, or conversation change.
- **Shared command definitions can become overly general** → Support only the three input shapes needed now; avoid dynamic remote option providers until a second real adapter exists.
- **Activity deduplication can hide individual calls** → Collapse only adjacent identical compact labels; full Chat tool cards remain available.

## Migration Plan

1. Add backward-compatible shared command metadata and update both mobile and extension in the same release.
2. Reapply current-source versions of the abandoned UX changes.
3. Add focused tests for every recovered or newly introduced invariant.
4. Validate the complete monorepo and protocol artifacts.
5. Merge the feature PR, run the normal patch release, and verify production plus immutable manifests.

Rollback is a normal revert followed by a patch release. No persistent data migration is required.

## Open Questions

None. The curated model catalogue is intentionally controlled by Weft and can be revised in future releases.

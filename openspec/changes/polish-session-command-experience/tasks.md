## 1. Recover Abandoned Mobile UX

- [x] 1.1 Preserve authored ordered-list start values and add focused Markdown tests
- [x] 1.2 Move the New Session name field above permissions and restore keyboard visibility plus Enter submission
- [x] 1.3 Restore compact resume rows with separated age and repository metadata
- [x] 1.4 Restore rich shell ToolCard input, output, metadata, status, and parsing tests

## 2. Protect Chat Reading Position

- [x] 2.1 Track older-message touch intent independently from transient bottom-gap measurements
- [x] 2.2 Preserve detached reading through heartbeat, streaming, resize, and momentum-scroll timing
- [x] 2.3 Add regression tests for heartbeat and ResizeObserver updates during mobile scrolling

## 3. Deepen Phone Command Arguments

- [x] 3.1 Replace the shallow command argument flag with shared no-input, text, and option definitions
- [x] 3.2 Add shared option lookup and validation helpers used by mobile and extension
- [x] 3.3 Refactor the composer suggestion flow into command and argument stages with filtering and keyboard/touch selection
- [x] 3.4 Add curated mobile model choices with hidden IDs and extension-side allowlist validation
- [x] 3.5 Add shared, extension, and mobile tests for text, option, custom, confirmation, failure, and model flows

## 4. Refine Chat and Explore Navigation

- [x] 4.1 Add direct Discover history state and correct one-step return to Chat
- [x] 4.2 Add right-edge swipe intent, preview, commit, cancellation, overlay guards, and reduced-motion behavior
- [x] 4.3 Add focused tests for threshold, direction, cancellation, direct Back, and disabled contexts

## 5. Centralize Tool Presentation and Redesign the Live Tile

- [x] 5.1 Create one explainable tool-label mapping shared by ToolCard and Explore
- [x] 5.2 Replace the debug-log tile layout with a Copilot presence card and integrated Open Chat action
- [x] 5.3 Deduplicate adjacent compact tool activities and preserve real streaming assistant text
- [x] 5.4 Add tests for mappings, elapsed-time thresholds, deduplication, attention states, and chat return

## 6. Documentation and Validation

- [x] 6.1 Update README and relevant product documentation for command options, model selection, gestures, and live activity
- [x] 6.2 Run focused shared, extension, composer, chat, Start Session, ToolCard, Markdown, App, and Explore tests
- [x] 6.3 Run mobile type tests, complete repository tests, build, lint, version check, and strict OpenSpec validation
- [x] 6.4 Review the integrated diff for protocol compatibility, privacy, accessibility, gesture conflicts, and unrelated changes

## 7. Land and Release

- [x] 7.1 Create and link the matching work item and feature PR
- [ ] 7.2 Merge the feature after all required checks pass
- [ ] 7.3 Build and deploy the next patch release with the normal release script
- [ ] 7.4 Merge the release PR, verify production and immutable manifests, and complete the work item

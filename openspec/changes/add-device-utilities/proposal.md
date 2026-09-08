## Why

Device Details can observe a laptop and launch Copilot sessions, but it cannot yet handle two
common away-from-keyboard needs: moving a small piece of text between devices and preventing the
laptop from sleeping while remote work continues. Power state is also less useful than uptime in
the primary health grid.

## What Changes

- Add explicit, user-initiated plain-text clipboard reads from the laptop and writes to the laptop.
- Add time-bounded Keep Awake leases with selectable duration, extension, visible remaining time,
  and explicit cancellation.
- Report actionable laptop power state and replace the Uptime health card with a stable Power card.
- Replace the disabled Explore Files and Open Terminal actions with Clipboard and Keep Awake.
- Add mobile bottom sheets for clipboard transfer and Keep Awake controls.
- Keep clipboard contents runtime-only, bounded, encrypted in transit, and absent from event logs.

## Capabilities

### New Capabilities

- `clipboard-bridge`: Explicit, bounded, encrypted text transfer between the paired phone and laptop.
- `device-power-control`: Power-state reporting and leased prevention of system sleep from Device Details.

### Modified Capabilities

None.

## Impact

- Shared control protocol and TypeScript declarations.
- Device Station capabilities, Windows clipboard access, power collection, and Keep Awake lifecycle.
- Mobile device runtime state, command handling, Device Details actions, health presentation, and sheets.
- Protocol, listener, telemetry, runtime, screen, privacy, and lifecycle tests.

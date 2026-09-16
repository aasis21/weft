## Why

Weft currently initializes too much code in every Copilot CLI session and cannot distinguish an already-open but Weft-inactive terminal session from stopped history. As a result, unused sessions produce noise and consume unnecessary resources, while a phone Resume request can launch a second terminal for a session that is already running.

## What Changes

- Replace the in-session extension with a silent, lightweight bootstrap that defers pairing, cryptography, transport, relay, QR, and diagnostics until activation.
- Publish minimal local presence for every running Copilot session so Device Station can distinguish live sessions from stopped history.
- Give each running extension a dormant user-local control pipe for reliable activation and lifecycle queries without polling.
- Persist launch operations, runtime presence metadata, and activation identity references under `~/.weft/` for restart recovery.
- Route phone Start and Open/Resume through one Device Station session coordinator.
- When the phone opens Session A and Session A is already running, activate and pair that exact process instead of launching `copilot --resume`.
- Preserve existing phone-started session behavior using the current environment/file identity handoff.
- Keep Device Station as the required bridge for phone-initiated Start, Resume, discovery, and dormant-session activation.
- Keep `/weft` QR pairing as the explicit direct-session path when Device Station is absent.
- Separate Copilot writer ownership from phone attachment state and enforce one Weft-mediated writer per logical session.
- Add structured lifecycle results, immediate confirmed controller replacement for responsive sessions, and terminate-confirm-resume only for unresponsive takeover.
- Require fresh activation after `/clear`; retain recoverable operation and identity records for three days.

## Capabilities

### New Capabilities

- `session-activation-lifecycle`: Lightweight runtime presence, local activation, safe session opening, durable recovery, writer ownership, and takeover behavior.

### Modified Capabilities

None.

## Impact

- Copilot extension entrypoint, active runtime, build output, installer, and updater.
- Device Station listener, session catalog, launch handling, and local lifecycle coordination.
- Shared lifecycle protocol and declarations.
- Mobile Start, Resume, reconnect, takeover, and operation-recovery flows.
- New user-private runtime presence, local endpoint, operation, and identity state under `~/.weft/`.
- Extension, Station, shared protocol, mobile runtime, scale, compatibility, and end-to-end tests.
- Setup, pairing, hosting, security, privacy, and troubleshooting documentation.

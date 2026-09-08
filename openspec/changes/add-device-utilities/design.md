## Context

Device Station already exposes an authenticated, end-to-end encrypted control channel, additive
capability negotiation, and a leased monitoring lifecycle. Device Details already renders monitored
health and a four-action rail. Clipboard contents are highly sensitive, while Keep Awake is a
local side effect that must never alter persistent Windows power plans.

## Goals / Non-Goals

**Goals:**

- Transfer bounded plain text in either direction only after an explicit phone action.
- Keep the laptop system awake for a visible, bounded duration with automatic cleanup.
- Replace the Uptime card with actionable power and battery state without removing uptime telemetry.
- Preserve compatibility with older laptop and phone versions.

**Non-Goals:**

- Automatic clipboard synchronization, clipboard history, images, files, or rich clipboard formats.
- Keeping the laptop display illuminated.
- Permanent Windows power-plan changes.
- Remote shutdown, restart, sleep, lock, or process control.

## Decisions

### Advertise independent capabilities

Device Station advertises `device-clipboard-v1` and `device-keep-awake-v1` alongside
`device-monitor-v1`. Independent flags let clients expose only supported behavior and allow either
feature to evolve without implying the other.

### Use explicit request/result clipboard messages

The phone sends request-ID-scoped read and write commands. Results echo the request ID, carry a
stable success or failure code, and include text only for a successful read. The station and phone
both enforce a 64 KiB UTF-8 limit. Clipboard text is never placed in device event logs, telemetry,
persisted device state, analytics, or error messages.

Windows clipboard access lives behind an injectable `deviceClipboard` adapter. PowerShell receives
write text through standard input rather than command interpolation, avoiding command injection and
command-line exposure. Reads and writes use bounded timeouts and return sanitized error codes.

### Keep Awake is one station-wide bounded lease

The phone sends `KEEP_AWAKE_START { requestId, leaseId, durationMs }` or
`KEEP_AWAKE_STOP { requestId, leaseId }`. The station clamps durations to 15 minutes through eight
hours, replaces or extends the active lease, and returns authoritative status containing the lease
ID and expiry. The phone derives remaining time from `expiresAt`.

On Windows, a dedicated hidden PowerShell child owns
`SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)`. It deliberately omits
`ES_DISPLAY_REQUIRED`, so the display may turn off while the system remains awake. Lease expiry,
explicit stop, listener shutdown, or controller failure terminates the helper and clears execution
state. No registry, scheduled task, or persistent power-plan setting is changed.

### Include power state in monitored snapshots

The existing device snapshot adds `onAcPower: boolean | null`. Existing battery percentage and
charging fields remain. Uptime also remains in the protocol and cache for compatibility, but Device
Details replaces the Uptime card with a stable Power card:

- battery percentage plus `Charging` or `On battery` when a battery is available;
- `AC` plus `Plugged in` for an AC-powered device without a reported battery;
- `Power unavailable` when neither source can be determined;
- active Keep Awake time as secondary status when a lease is active.

Power collection remains in `deviceTelemetry` and follows the existing slow battery cache and
partial-failure model.

### Use two focused mobile sheets

Clipboard and Keep Awake replace the disabled Explore Files and Open Terminal actions. Each opens a
mobile bottom sheet with dialog semantics, focus restoration, backdrop/Escape/native-back dismissal,
and the same surface tokens as Device Details.

The Clipboard sheet never reads automatically. Closing it clears all clipboard text from Redux.
The Keep Awake sheet may close while the lease remains active; reopening shows authoritative
remaining time and Stop/Extend controls.

## Risks / Trade-offs

- **Clipboard contents can contain secrets** → explicit actions only, text-only bounds, runtime-only
  state, redacted diagnostics, and no automatic preview.
- **PowerShell clipboard access can hang or be unavailable** → hidden non-interactive process,
  bounded timeout, injectable tests, and stable error codes.
- **A Keep Awake helper could outlive the intent** → bounded lease, station-owned child process,
  explicit stop, shutdown cleanup, and no permanent system setting.
- **Phone and laptop clocks can differ** → station supplies an absolute expiry; the phone treats it
  as display guidance and refreshes status after each command.
- **Older stations ignore messages** → capability-gated controls remain visible but disabled with an
  update explanation.

## Migration Plan

The protocol is additive. New phones enable each utility only when its capability is advertised.
Older phones ignore the new capabilities and snapshot field. Rollback removes the UI and handlers;
any active Keep Awake lease still expires automatically or ends when Device Station exits.

## Open Questions

None for the initial implementation.

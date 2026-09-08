## Why

Device Station currently offers no terminal access. Users need to open or reconnect to one real laptop shell from a phone, comfortably enter commands, and see the same session in a visible laptop terminal.

## What Changes

- Add a single Station-owned terminal per device, created or resumed by Open terminal.
- Show the same shell in a visible Windows terminal through a local Weft attach client.
- Add an encrypted, capability-negotiated terminal protocol, reconnectable output, explicit input ownership, and idempotent lifecycle operations.
- Add a mobile-friendly terminal screen with a command editor, direct terminal input, special keys, reconnect, and confirmed close.
- Require laptop-side opt-in for remote shell access; exclude terminal content from diagnostic logs.
- Package the native PTY runtime with hosted installers and updates, preserving existing configuration and pairing.

## Capabilities

### New Capabilities

- `shared-terminal`: One explicitly authorized laptop shell shared by the phone and a visible local terminal.

### Modified Capabilities

None.

## Impact

Shared message contracts; Station listener and CLI; mobile device navigation, runtime and terminal UI; PTY and terminal-renderer dependencies; build/installer/update distribution; documentation and focused integration coverage. Existing Copilot sessions remain independent. This change does not deploy production or update the current laptop installation.

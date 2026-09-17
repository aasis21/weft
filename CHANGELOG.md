# Changelog

Notable user-facing changes are recorded here. Versions follow the release version shipped
with the Weft extension and mobile app.

## Unreleased

## 0.2.21

- Added the source device name beside each session's project metadata in the session drawer.
- Kept Start and Resume together above Clipboard, Keep Awake, and Terminal in Quick actions.
- Made the mobile slash-command palette independently scrollable and bounded above the keyboard.

## 0.2.20

- Improved device fallback states when Windows cannot provide system metrics or an
  older Device Station does not advertise monitoring support.
- Replaced the cramped terminal capability warning with a readable, mobile-safe card
  that explains update and configuration options without overflowing.

## 0.2.19

- Repairs incomplete same-version installs by downloading every mandatory bundle declared
  by the hosted release manifest.
- Keeps phone control connected across full Copilot extension process replacements by
  restoring durable controller identity and re-authenticating after heartbeat loss.
- Removes dead runtime-presence records without collapsing independent live sessions, and
  fences stale lifecycle handles from deleting replacement state.
- Reconciles preserved Dev Tunnels to the active relay port and cleans up abandoned or
  partially provisioned cloud tunnels.

## 0.2.18

- Redesigned session activation so dormant Copilot sessions stay silent and lightweight,
  Device Station reuses already-running terminals without duplicate Resume processes, and
  lifecycle recovery, cancellation, and controller takeover remain single-writer safe.
- Simplified onboarding around `install` → `weft start` → scan.
- Added phone/laptop version mismatch and update guidance.
- Added expiring, single-use pairing grants, nonce-bound handshakes, and authenticated
  replay/order protection for encrypted session traffic.
- Stopped native builds from mirroring pairing keys and transcripts into WebView
  `localStorage`; legacy native mirrors are migrated and removed.
- Added strict browser security headers and content security policies.
- Added checksum-verified installers and updates, immutable GitHub release archives,
  provenance attestations, and optional APK metadata for a future signed Android pipeline.
- Expanded the launch gate to cover every workspace, mobile test types, the extension
  relay harness, Chromium/WebKit journeys, accessibility checks, builds, and dependency
  auditing.
- Clarified that the relay stores no session content while paired devices retain local
  session data for reconnect and restore.
- Added privacy, security reporting, support, contribution, and hosted-service policy
  surfaces.
- Moved `/weft`, alternate transports, pairing modes, and self-hosting into advanced
  documentation.
- Improved hosted-app metadata and icon declarations.

## 0.2.6

- Current public preview release.
- Added the standalone Device Station, multi-device/session management, persistent
  pairings, version reporting, voice controls, and hosted web installation.

Earlier development history is available in the
[Git commit log](https://github.com/aasis21/weft/commits/main/).

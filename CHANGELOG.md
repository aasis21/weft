# Changelog

Notable user-facing changes are recorded here. Versions follow the release version shipped
with the Weft extension and mobile app.

## Unreleased

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

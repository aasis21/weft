# Weft repository instructions

Use these instructions for AI-assisted changes in this repository. Read the relevant
source and documentation before editing, preserve compatibility between the laptop and
phone, and keep changes focused.

## Product overview

Weft turns a phone into a mobile interface for a computer running GitHub Copilot CLI.
It is not a remote desktop. The laptop remains a normal computer while the phone offers
purpose-built views for devices, projects, sessions, approvals, chat, and system status.

The repository is a Node.js monorepo:

- `shared/` defines the encrypted channel and protocol messages used by both endpoints.
- `extension/` contains the Copilot CLI extension, standalone `weft` Device Station,
  relay integration, Windows telemetry, and command-line tooling.
- `mobile/` contains the React/Vite/Capacitor phone application and hosted PWA.
- `docs/` contains setup, architecture, pairing, hosting, release, and support guidance.
- `openspec/` records planned protocol or product changes.

The real-time path is:

```text
Copilot CLI / Device Station
  -> encrypted SecureChannel messages
  -> Supabase Realtime or Microsoft Dev Tunnel relay
  -> phone runtime and Redux state
  -> React mobile UI
```

Relays transport ciphertext. Pairing establishes the keys used for end-to-end
AES-256-GCM encryption.

## Development rules

- Use Node.js 20 or newer.
- Keep protocol definitions, TypeScript declarations, extension handlers, mobile
  handlers, and tests synchronized.
- Make additive protocol changes where possible. Use explicit capability negotiation
  when an older phone or laptop may not support new behavior.
- Do not log or transmit credentials, pairing secrets, raw window titles, document
  names, browser tabs, executable paths, or private session content.
- Preserve `~/.weft/` configuration and persistent pairing data during installs,
  updates, and releases.
- Add focused tests near changed behavior. Update user documentation when commands,
  storage, privacy, compatibility, or security behavior changes.
- Use an OpenSpec change for substantial product, lifecycle, or protocol work.

## Validation

Run the smallest focused tests while iterating, then validate the complete repository
before landing a cross-workspace change:

```powershell
npm test
npm run build
npm run lint
npm run check-version
```

For mobile type-test coverage:

```powershell
npm run test:types --workspace @aasis21/weft-mobile
```

## Versioning and releases

`VERSION` is the single source of truth. Workspace `package.json` files and
`package-lock.json` must match it.

- Do not manually bump the patch version for an ordinary change.
- `.\ship.ps1` automatically increments the patch version and runs
  `scripts\sync-version.mjs` before building and deploying.
- Manually set `VERSION` only for an intentional minor, major, prerelease, or other
  explicitly chosen version, then run `npm run sync-version`.
- Use `.\ship.ps1 -NoVersionBump` only when re-shipping an already-versioned build or
  after deliberately setting the version by hand.
- Do not claim that a commit on `main` is available to installed clients until the
  hosted release has been successfully deployed.

Normal production release:

```powershell
.\ship.ps1
```

Useful explicit variants:

```powershell
.\ship.ps1 -Draft
.\ship.ps1 -Install
.\ship.ps1 -SkipDeploy -Install -Push
```

The release script builds the extension, refreshes hosted installer assets, builds the
phone PWA, publishes the release manifest and checksums, and deploys to Netlify. Passing
`-Install` also updates the current laptop; it is never implied.

## Updating installed clients

After a hosted release, update a laptop installation with:

```powershell
weft update --check
weft update
```

Restart `weft start` or Copilot CLI afterward. A fresh installation and QR re-pairing
are not required: the updater preserves transport configuration, registered projects,
logs, and persistent pairing material under `~/.weft/`.

The hosted PWA updates through the browser. Close and reopen the installed PWA after a
release if it is still running the previous build.

## Important references

- `README.md` - product entry point and basic installation
- `CONTRIBUTING.md` - contributor workflow
- `docs/setup.md` - local development
- `README.md` and `docs/hosting.md` - system and relay architecture
- `docs/pairing.md` - trust and cryptographic pairing
- `docs/releases.md` - supported release and update process
- `SECURITY.md` and `PRIVACY.md` - security and data-handling requirements

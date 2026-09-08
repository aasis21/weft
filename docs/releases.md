# Releases and updates

[Documentation handbook: releases and updates](https://aasis21.github.io/weft/#updates)

## Phone app

The hosted PWA at <https://useweft.netlify.app> is the primary Weft phone experience.
Install it with the browser's **Install app** or **Add to Home Screen** action. Web
updates are delivered by the browser; close and reopen the installed PWA after a new
release if the old build remains active.

Weft does not currently publish an Android APK. Native Android builds are for local
development until a signed Android release pipeline is available. Do not install debug,
unversioned, or third-party APKs presented as official Weft releases.

## Laptop extension and CLI

Check without changing the installation:

```sh
weft update --check
```

Install the current hosted release:

```sh
weft update
```

The updater stages and validates the complete bundle set against the published SHA-256
release manifest before replacing the installed release as one transaction. It does not remove or overwrite
`~/.weft/` configuration, registered projects, logs, or persistent pairing material.
Restart Copilot CLI or Device Station after updating.

## Compatibility check

Open **Settings → About** in the phone app. It shows the phone build and the version
reported by each paired laptop. When Weft highlights a mismatch, update the laptop,
restart it, and reload the PWA before deeper troubleshooting. A mismatch is a useful
diagnostic signal, not a guarantee that the protocol is incompatible.

## Release notes and provenance

- GitHub releases: <https://github.com/aasis21/weft/releases>
- Changelog: [`../CHANGELOG.md`](../CHANGELOG.md)
- Hosted release manifest: <https://useweft.netlify.app/release-manifest.json>
- Source repository: <https://github.com/aasis21/weft>

GitHub release archives and the release manifest are published from version tags.

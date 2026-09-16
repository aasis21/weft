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

The updater reads the mandatory bundle set from the published release manifest, then
stages and validates every bundle and the usage skill against their SHA-256 checksums
before replacing them in one transaction. This also repairs a same-version installation
when an older updater omitted a newly introduced bundle or a required file is missing or
corrupt. It does not remove or overwrite `~/.weft/` configuration, registered projects,
logs, or persistent pairing material.
Restart Copilot CLI or Device Station after updating; an already-running process does
not switch to the downloaded code automatically.

An ordinary update does not require fresh pairing. Do not use `weft clean-install`
to update: that command deletes configuration and pairing data as well as code.

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

The hosted release manifest declares the mandatory install bundle set consumed by
`weft install`, `weft update`, release verification, and same-version repair.
A commit on `main`, a GitHub release archive, and the hosted deployment are distinct:
code is available to installed clients only after the hosted release is published.
The documentation site on GitHub Pages is deployed separately from the web app.

# Weft privacy notice

Weft connects a phone to GitHub Copilot CLI sessions running on a laptop. It is
designed so relay infrastructure does not receive plaintext session content.

## Data stored on your devices

The phone or installed PWA stores data locally so it can restore your workspace:

- paired devices and sessions;
- transcript history and session metadata;
- app and voice preferences;
- pairing public keys and private keys.

The native app uses Capacitor Preferences. The PWA uses browser storage. Removing a
session deletes its locally cached transcript; clearing the app's site data removes
the PWA's local data.

The laptop stores installed code under `~/.copilot/extensions/weft/`. Configuration,
registered projects, logs, relay settings, and persistent Device Station pairing
material are stored under `~/.weft/`. A `/weft` pairing inside one Copilot session uses
an ephemeral identity that ends with that session.

## Data handled by relay infrastructure

Session traffic is end-to-end encrypted between the paired phone and laptop. Relay
infrastructure forwards ciphertext and stores no session content, transcripts, or key
escrow. It cannot decrypt session traffic without an endpoint key.

The relay and its infrastructure providers may process ordinary service metadata such
as IP addresses, connection times, request logs, channel identifiers, traffic volume,
and error diagnostics. Self-hosted relay operators control their own logging and
retention.

The hosted web app loads font files from Google Fonts. Google may receive ordinary web
request metadata such as your IP address and browser headers when those assets load.

## Accounts, analytics, and notifications

- Weft pairing does not require a Weft account.
- The Weft app does not include advertising or behavioral analytics.
- Local approval notifications contain a tool name, not command arguments or transcript
  content. Browser and operating-system notification services remain subject to their
  own privacy terms.

## Your choices

- Use the hosted Supabase relay, self-host Supabase, or use a Microsoft Dev Tunnel.
- Remove individual sessions to delete their cached phone transcripts.
- Clear the app's browser/site data to delete PWA-local data.
- Remove `~/.weft/` to delete laptop-side configuration and persistent pairing material.
- Run `weft rotate-pairing` if a persistent QR or paired phone may be compromised.

See [`docs/security.md`](docs/security.md) for the threat model and
[`SUPPORT.md`](SUPPORT.md) for cleanup and issue-reporting guidance.

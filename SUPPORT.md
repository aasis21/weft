# Weft support

## Before filing an issue

1. Check the installed laptop version with `weft version`.
2. Run `weft update --check`; if an update is available, run `weft update` and restart
   Copilot CLI or Device Station.
3. Close and reopen the PWA so the browser can activate the current deployment.
4. Re-run pairing. For a persistent Device Station pairing that may be stale, use
   `weft rotate-pairing` and scan the new QR.
5. If pairing fails, open **Trouble connecting?** in the app and run the connectivity
   test.

## Report a problem

Use [GitHub Issues](https://github.com/aasis21/weft/issues/new/choose) for reproducible,
non-sensitive bugs and feature requests. Include:

- phone model, operating system, browser or native app, and Weft version;
- laptop operating system, Copilot CLI version, and `weft version`;
- transport: hosted Supabase, self-hosted Supabase, or dev tunnel;
- concise reproduction steps, expected behavior, and actual behavior;
- sanitized diagnostics from **Trouble connecting?** when relevant.

Never paste pairing QR payloads, keys, access tokens, private repository content, or
transcripts into a public issue. Report security-sensitive problems privately using
[`SECURITY.md`](SECURITY.md).

## Install and update help

The PWA at <https://useweft.netlify.app> is the supported primary phone distribution.
Weft does not currently publish an Android APK; native builds are for local development
until a signed Android release pipeline is available. Debug, unversioned, and
third-party APKs are not supported.

See [`docs/releases.md`](docs/releases.md) for release channels and
[`docs/setup.md`](docs/setup.md) for developer setup.

## Remove Weft

Remove `~/.copilot/extensions/weft/` and `~/.copilot/skills/weft-how-to-use/` to
uninstall the laptop code. Remove `~/.weft/` only when you also intend to delete local
configuration, registered projects, logs, and persistent pairing material. On the phone,
remove the installed PWA/native app and clear its site/app data to delete locally stored
transcripts and pairings.

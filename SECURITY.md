# Security policy

## Supported releases

Security fixes are provided for the latest published Weft release. Before reporting a
problem, run:

```sh
weft update --check
weft update
```

Then restart Copilot CLI or Device Station and reproduce the issue. PWA users should
close and reopen the installed app so the browser can activate the current deployment.

## Report a vulnerability privately

Do not open a public issue for a vulnerability, exposed pairing payload, secret,
transcript, or other sensitive data. Use
[GitHub private vulnerability reporting](https://github.com/aasis21/weft/security/advisories/new)
and include:

- the affected Weft version and phone/browser platform;
- the transport in use (hosted Supabase, self-hosted Supabase, or dev tunnel);
- reproduction steps and the expected impact;
- logs or screenshots with secrets, pairing payloads, repository paths, and transcript
  content removed.

For non-sensitive bugs and support requests, follow [`SUPPORT.md`](SUPPORT.md).

## Security model

Relay infrastructure forwards end-to-end-encrypted envelopes and stores no session
content. Transcripts and pairing keys are intentionally stored locally on paired
devices to support history and reconnection. The full trust model, storage boundaries,
QR risks, and known residual risks are documented in
[`docs/security.md`](docs/security.md).

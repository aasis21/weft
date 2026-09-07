# Weft hosted relay terms

**Effective date:** September 6, 2026

These terms apply when you use the public relay configured by the official Weft
installation. If you self-host, the operator of that relay sets its own service terms.

These are the project's current operating terms. They are not legal advice and are not
presented as having been independently reviewed by legal counsel.

The Weft **software** is licensed under Apache-2.0 (see [`LICENSE`](./LICENSE)). These
terms govern use of a **hosted relay instance**, which is a separate service that an
operator runs. See [`docs/hosting.md`](./docs/hosting.md) for the distinction.

## The service

- The relay is a Supabase Realtime Broadcast channel that routes **end-to-end encrypted**
  messages between a paired laptop and phone. Relay infrastructure stores no session
  content, and the operator does not hold the endpoint keys needed to decrypt traffic.
- Weft does not require an account for pairing. Infrastructure providers may still
  process ordinary connection metadata such as IP addresses, timestamps, request logs,
  and channel identifiers. See [`PRIVACY.md`](./PRIVACY.md).
- Transcripts, session metadata, settings, and pairing material may be stored locally on
  your phone or laptop. They are not stored by the relay.

## Acceptable use

You agree not to:

- exceed published rate limits or otherwise degrade the service for others;
- attempt to join channels you were not paired into, or circumvent RLS / access controls;
- use the service for unlawful purposes or to transmit unlawful content;
- resell the hosted instance or represent it as your own service.

The operator may rate-limit, suspend, or revoke access at any time, with or without
notice, to protect the service.

Do not send secrets in public bug reports. Security vulnerabilities should be reported
through the private process in [`SECURITY.md`](./SECURITY.md).

## Your responsibilities

You are responsible for protecting pairing QR codes and paired devices, for the prompts
and approvals you send through Weft, and for complying with the terms governing GitHub
Copilot and any systems your session accesses. Run `weft rotate-pairing` if a persistent
QR or paired phone may have been exposed.

## No warranty

The service is provided **"as is", without warranty of any kind**, and may change or shut
down at any time. To the maximum extent permitted by law, the operator is not liable for
any damages arising from use of, or inability to use, the service. (This mirrors the
warranty and liability disclaimers in the Apache-2.0 license that covers the software.)

Some jurisdictions do not allow every exclusion or limitation above, so those provisions
apply only to the extent permitted by law.

## Changes and contact

Material changes will be published in this file with a new effective date. Continued use
after a change takes effect means you accept the updated terms. If you do not agree, stop
using the hosted relay.

For service questions, use [`SUPPORT.md`](./SUPPORT.md). Report vulnerabilities privately
through [`SECURITY.md`](./SECURITY.md).

## Self-hosting

You can always run your own relay instead — see [`docs/hosting.md`](./docs/hosting.md).
These terms apply only to the public relay configured by the official Weft distribution.

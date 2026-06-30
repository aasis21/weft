# Helm — Acceptable Use (hosted relay)

> Template terms for anyone operating a **public** Helm relay. This is a starting point,
> not legal advice — adapt it before relying on it. If you self-host for personal use
> only, you can ignore this file.

The Helm **software** is licensed under Apache-2.0 (see [`LICENSE`](./LICENSE)). These
terms govern use of a **hosted relay instance**, which is a separate service that an
operator runs. See [`docs/hosting.md`](./docs/hosting.md) for the distinction.

## The service

- The relay is a Supabase Realtime Broadcast channel that routes **end-to-end encrypted**
  messages between a paired laptop and phone. It stores no session content, and the
  operator cannot decrypt traffic.
- Pairing is by QR; there is no account, and the relay itself collects no identity.

## Acceptable use

You agree not to:

- exceed published rate limits or otherwise degrade the service for others;
- attempt to join channels you were not paired into, or circumvent RLS / access controls;
- use the service for unlawful purposes or to transmit unlawful content;
- resell the hosted instance or represent it as your own service.

The operator may rate-limit, suspend, or revoke access at any time, with or without
notice, to protect the service.

## No warranty

The service is provided **"as is", without warranty of any kind**, and may change or shut
down at any time. To the maximum extent permitted by law, the operator is not liable for
any damages arising from use of, or inability to use, the service. (This mirrors the
warranty and liability disclaimers in the Apache-2.0 license that covers the software.)

## Self-hosting

You can always run your own relay instead — see [`docs/hosting.md`](./docs/hosting.md).
These terms apply only to instances operated by a given operator.

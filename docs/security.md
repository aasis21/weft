# Helm security model

Helm's promise: **the relay never sees your session.** Supabase (or any relay) only
ever transports opaque ciphertext. Confidentiality and integrity live entirely on the
two paired devices.

## Trust boundaries

| Component | Trusted with plaintext? | Notes |
|---|---|---|
| Extension (laptop) | yes | runs as a child of `gh copilot`; holds one ECDH private key |
| Mobile app (phone) | yes | holds the other ECDH private key |
| Supabase Realtime | **no** | sees only `{ iv, ciphertext, ts }` envelopes + a channel name |
| Network / ISP | **no** | TLS to Supabase + E2E payload encryption |

## Cryptography

- **Key agreement:** ECDH on **P-256** (universal Web Crypto support in Node ≥18 and
  browsers/WebViews). Each device generates an ephemeral keypair per session.
- **Key derivation:** ECDH shared secret → **HKDF-SHA256** (salt `"helm-v1"`, info
  `"helm-session-key"`) → a 256-bit AES key.
- **Payload encryption:** **AES-256-GCM** with a fresh **random 96-bit IV per
  message**. GCM provides confidentiality *and* integrity (tampered ciphertext is
  rejected on decrypt — see `shared/test/crypto.test.mjs`).
- **Channel id:** 128 bits of CSPRNG entropy, hex. Namespaces the relay channel as
  `private:helm:<channelId>`.

Envelope on the wire: `{ iv: base64, ciphertext: base64, ts: number }`. Nothing else
— no plaintext metadata, no tool names, no prompts.

## Supabase configuration (Phase 2)

- Use **Realtime Broadcast** with **zero database persistence** in v1.
- Enable **Realtime Authorization** and add **RLS** policies on `realtime.messages`
  so only authorized clients may join `private:helm:*` channels.
- Channel config uses `broadcast: { self: false, ack: true }`.
- The **anon key is shippable**: it grants only the ability to attempt a join.
  Confidentiality does **not** depend on it — it rests on (a) the unguessable
  `channelId`, (b) RLS, and (c) end-to-end encryption. Even a full channel compromise
  yields only ciphertext.

## Threats & mitigations

| Threat | Mitigation | Residual risk (v1) |
|---|---|---|
| Relay/operator reads sessions | E2E AES-256-GCM; relay sees ciphertext only | none for content |
| Network eavesdropper | TLS + E2E | none for content |
| Channel-name guessing | 128-bit random `channelId` + RLS | negligible |
| Message tampering / replay garbage | GCM auth tag rejects modified ciphertext | replay of *valid* old envelopes not yet sequence-checked → **see below** |
| **QR shoulder-surf / screenshot** | QR shown briefly; contains only a public key + channelId | **anyone who reads the QR can pair** — accepted in v1 |
| **Pairing race / impersonation** | `waitForPeer` resolves on the first `pair.hello` | an attacker who saw the QR could pair first — accepted in v1 |
| Approval prompt hangs the agent | `onPermissionRequest` has a **timeout → deny** safety net (`HELM_APPROVAL_TIMEOUT_MS`, default 120s) | a slow phone denies a tool it might have approved |
| Lost/stolen phone | session key is ephemeral and dies with the session | a live, unlocked paired phone can drive the session |

### The QR is a bearer credential

The QR encodes `{ channelId, laptopPublicKey }`. Both are non-secret individually,
but together they are sufficient to **join the channel and complete the handshake**.
Therefore, in v1, treat the QR like a glance-only password: don't screenshot it, don't
share it, and re-pair (new `channelId` + keypair) if it may have been seen. This is the
same trust level as someone watching your terminal.

### Replay / ordering

AES-GCM rejects *modified* ciphertext, but the v1 protocol does not yet add a
monotonic sequence number, so a relay could in principle re-deliver a previously valid
envelope. Impact is low (live-only, no persistence, idempotent-ish UI), but adding a
per-message counter inside the encrypted payload is a tracked hardening item.

## What is NOT stored

v1 keeps **no history**: no database rows, no logs of prompts/responses, no key
escrow. Closing the `gh copilot` terminal ends the session, the extension process
dies, the relay channel vanishes, and the phone shows "Session Ended".

## v2 evolution (forward-looking)

A multi-machine command center (all of one user's sessions in one app) introduces the
core tension between E2E ("we can't read your sessions") and cloud sync. Two paths are
documented in `plan.md` §9: stay E2E via account-derived keys + key wrapping (Path A,
the privacy differentiator) or a normal TLS+RLS SaaS posture (Path B). v1's
device-local ephemeral keys and per-session channelId are intentionally swappable to
keep both paths open.

# Helm pairing handshake

How a phone attaches to a live `gh copilot` session and establishes an end-to-end
encrypted channel, with no shared secret ever leaving the two devices.

## Why a handshake is needed

Helm encrypts every payload with an **AES-256-GCM session key** derived via **ECDH
(P-256)**. ECDH needs *both* parties' public keys:

```
sessionKey = ECDH(laptop.privateKey, phone.publicKey)
           = ECDH(phone.privateKey,  laptop.publicKey)   // same value
```

The QR code carries the **laptop's public key**. The phone therefore still has to
deliver **its** public key back to the laptop before the laptop can derive the key.
That return trip is the handshake.

Public keys are not secrets, so the handshake is the *only* unencrypted traffic on
the channel. Everything afterwards goes through `SecureChannel` (ciphertext only).

## The exchange

```
  Laptop (extension)                         Phone (mobile app)
  ------------------                         ------------------
  generateKeyPair()                          generateKeyPair()
  channelId = randomChannelId()
  show QR: { v, channelId, pub:laptopPub } ──scan──► parsePairingPayload()
  waitForPeer():                                     sayHello():
    subscribe "pair.hello"                             key = ECDH(phonePriv, laptopPub)
    connect()                                          connect()
                              ◄── pair.hello {pub:phonePub, deviceId} ──
    key = ECDH(laptopPriv, phonePub)
    publish "pair.ack" ───────────────────────────►   (optional) await ack
    => { key, peer }                                   => { key }
  new SecureChannel({transport,key})         new SecureChannel({transport,key})
  attachRelay()                              subscribe stream/approval/control …
```

Both ends now hold the identical `key` and only ever exchange
`{ iv, ciphertext, ts }` envelopes.

## API (`@aasis21/helm-shared`, `shared/pairing.mjs`)

| Function | Side | Purpose |
|---|---|---|
| `buildPairingPayload({ channelId, publicKeyB64 })` | laptop | QR JSON `{ v, channelId, pub }` |
| `parsePairingPayload(stringOrObj)` | phone | validate + extract `{ channelId, publicKeyB64 }` |
| `waitForPeer({ transport, keyPair, timeoutMs })` | laptop | await `pair.hello`, derive key, send `pair.ack` → `{ key, peer }` |
| `sayHello({ transport, keyPair, peerPublicKeyB64, deviceId, waitForAck })` | phone | derive key, publish `pair.hello` → `{ key }` |

Reserved transport events: `pair.hello` (phone → laptop) and `pair.ack`
(laptop → phone). These ride the same transport as the encrypted channel but use a
plaintext payload that contains only a public key.

A worked, runnable example lives in `shared/test/pairing.test.mjs`.

## Transport ordering note

`waitForPeer`/`sayHello` register their handler **before** calling
`transport.connect()`. This matters on the real Supabase Broadcast transport, where
`channel.on(...)` listeners must be registered before `channel.subscribe(...)`. The
in-process `LocalTransport` (harness, tests, mobile demo) has no such constraint.

> **Known follow-up (Phase 2 / p4):** `attachRelay` registers the `SecureChannel`
> event handlers *after* `waitForPeer` has already connected. On LocalTransport this
> is fine. On Supabase, those post-connect subscriptions need the transport to be
> made order-independent (e.g. a single broadcast listener with internal dispatch).
> Tracked in `plan.md`.

## Security boundary

See [`security.md`](./security.md). In short: the QR is a **bearer credential** —
anyone who can read it (and reach the channel) can pair. v1 treats the QR like a
glance-only secret; v2 moves to account-based pairing.

# Weft pairing handshake

[Documentation handbook: pairing and recovery](https://aasis21.github.io/weft/#pairing)

How a phone attaches to a live `copilot` session and establishes an end-to-end
encrypted channel without transmitting the resulting session encryption key.

## Device Station recovery

The Device Station persists its pairing identity by default. An already-paired
phone reconnects using its stored key; a claimed QR is not an invitation for another
phone. If the phone changes, browser profile changes, or browser/app storage is
cleared, stop the old station and run:

```sh
weft start --new-device
```

Scan the fresh QR. This replaces the previously trusted phone identity, so the old
pairing no longer reconnects. It does not restore transcripts deleted from phone
storage. `weft start --rotate-pairing` is an alias for the same option.

For an exposed persistent identity, stop the station and run `weft rotate-pairing`
before starting and pairing again. Stop a running station before rotating its
stored identity so it cannot continue using the old identity in memory.

## Why a handshake is needed

Weft encrypts every payload with an **AES-256-GCM session key** derived via **ECDH
(P-256)**. ECDH needs *both* parties' public keys:

```
sharedSecret = ECDH(laptop.privateKey, phone.publicKey)
             = ECDH(phone.privateKey,  laptop.publicKey) // same value
provisional = HKDF-SHA256(sharedSecret, phoneNonce)
sessionKey  = HKDF-SHA256(sharedSecret, phoneNonce + laptopChallenge)
```

The QR code carries the **laptop's public key**. The phone therefore still has to
deliver **its** public key back to the laptop before the laptop can derive the key.
That return trip is the handshake.

Public keys, nonces, and the laptop challenge are not secrets. The bearer proof and
acknowledgement are encrypted, and everything after pairing goes through
`SecureChannel` (ciphertext only).

## The exchange

```
  Laptop (extension)                         Phone (mobile app)
  ------------------                         ------------------
  generateKeyPair()                          generateKeyPair()
  channelId = randomChannelId()
  show QR: { channel, pub, transport, token, expiry } ─scan─► parsePairingPayload()
  waitForPeer():                                     sayHello():
    subscribe "pair"                                   provisional = HKDF(ECDH(...), phoneNonce)
    connect()                                          connect()
                              ◄── hello {pub, phoneNonce} ─────────
    challenge = random()
                              ─── challenge {phoneNonce, challenge} ►
                              ◄── encrypted proof {challenge, token?}
    verify current private-key possession
    atomically claim unexpired token
    key = HKDF(ECDH(...), phoneNonce + challenge)
    publish encrypted, challenge-bound ack ───────►   validate encrypted ack
    => { key, peer }                                   => { key }
  new SecureChannel({transport,key})         new SecureChannel({transport,key})
  attachRelay()                              subscribe stream/approval/control …
```

Both ends now hold the identical fresh `key`. Application messages are encrypted
envelopes whose ciphertext authenticates a stream id, monotonic sequence number, and
the typed Weft message.

## API (`@aasis21/weft-shared`, `shared/pairing.mjs`)

| Function | Side | Purpose |
|---|---|---|
| `buildPairingPayload({ channelId, publicKeyB64, transport })` | laptop | QR JSON with the channel, laptop public key, relay descriptor, and 10-minute bearer grant |
| `parsePairingPayload(stringOrObj)` | phone | validate and extract the channel, key, pairing kind, relay descriptor, grant, expiry, and optional app version |
| `createPairingGate(...)` | laptop | expire an unclaimed grant and atomically bind its first successful claim to one phone public key |
| `waitForPeer({ transport, keyPair, pairingGate, ... })` | laptop | issue a fresh challenge, validate the encrypted grant/private-key proof, derive the challenge-scoped key, and send an encrypted acknowledgement |
| `sayHello({ transport, keyPair, peerPublicKeyB64, pairingToken, ... })` | phone | answer the laptop challenge with an encrypted proof, derive the challenge-scoped key, and validate the acknowledgement |

Reserved transport events are `pair.hello`, `pair.challenge`, `pair.proof`, and
`pair.ack`. The hello and challenge expose only public keys/nonces and sender/device
identity fields. The bearer/private-key proof and acknowledgement are encrypted and
bound to both fresh values. Replaying a captured hello cannot recreate an old session key.

Pairing payload version 2 advertises this flow. Updated phones can still consume a
version-1 QR while an older laptop extension is being upgraded; a stored version-1 phone
identity advertises version-2 capability on reconnect so an updated laptop can challenge it
securely. Connections to an older laptop retain the version-1 direct encrypted-message framing;
connections that complete the challenge use the replay-protected version-2 stream envelope.
Older cached phone builds must be refreshed before scanning a version-2 QR.

A worked, runnable example lives in `shared/test/pairing.test.mjs`.

## Transport ordering note

`waitForPeer`/`sayHello` register their handler **before** calling
`transport.connect()`. This matters on the real Supabase Broadcast transport, where
`channel.on(...)` listeners must be registered before `channel.subscribe(...)`. The
in-process `LocalTransport` (harness, tests, mobile demo) has no such constraint.

`SupabaseTransport` is subscribe-order independent — it registers
a single catch-all broadcast listener at channel creation and dispatches to per-event
handlers from an in-memory map. `attachRelay` may therefore register `SecureChannel`
handlers after `waitForPeer` has connected without losing events.

## Security boundary

See [`security.md`](./security.md). In short: the QR is a **bearer credential** —
anyone who can read it (and reach the channel) can race to claim it while its bearer
grant remains valid. It contains the channel id, laptop public key, pairing kind, relay
descriptor, grant, expiry, and optional app version; a Supabase descriptor also contains
its client-safe anon key. The grant expires after 10 minutes and becomes bound to the
first successfully paired phone key. Treat it like a glance-only password.

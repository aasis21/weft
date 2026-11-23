# Weft security model

[Documentation handbook: security and privacy](https://aasis21.github.io/weft/#security)

Weft's promise: **relay infrastructure stores no session content and cannot decrypt
session traffic.** Supabase or a dev tunnel transports opaque ciphertext.
Confidentiality and integrity live on the paired endpoints.

## Trust boundaries

| Component | Trusted with plaintext? | Notes |
|---|---|---|
| Extension (laptop) | yes, when active | a dormant extension has no pairing key or remote connection; activation loads the runtime that holds the session key |
| Device Station | yes for machine lifecycle and its own device channel | required for phone automation, but not in the active phone-to-session traffic path |
| Mobile app (phone) | yes | holds the other ECDH private key |
| Supabase Realtime | **no** | sees only `{ iv, ciphertext, ts }` envelopes + a channel name |
| Network / ISP | **no** | TLS to Supabase + E2E payload encryption |

## Dormant activation and local control

A dormant extension publishes one bounded live record
(`~/.weft/sessions-live/<runtimeId>.json`) and listens on one user-local control pipe. It
performs no transport lookup, remote network access, pairing cryptography, QR generation,
logging, diagnostics, polling, heartbeat, retry timer, or other timer.

**Ownership.** Each file has exactly one writer: a session writes only its own live record and
capability file; Station writes only open requests (`~/.weft/requests/`) and keeps its
observations in memory. Station never rewrites a session's record. It deletes a record only after
proving the owning process is gone (pid and operating-system start time); a record whose process
cannot be verified is kept and its saved session is treated as `owner-unknown`, so Weft never
launches a second writer next to a process it cannot rule out. Records and stores left by Weft
versions before 0.2.75 are deleted only when their processes are dead; while an old-version process
lives, its saved session stays `owner-unknown`.

The record supports discovery and crash recovery. A separate 0600 capability file and the Windows
named pipe or Unix-domain socket authorize the live `probe`, `activate`, `resetLink`,
`replaceController`, `quiesce`, `traffic` and `reloadExtension` commands. Each request must carry
the private capability plus the session, runtime and generation identities in its first frame;
Station closes each temporary connection after the command. `resetLink` is fenced by the expected
link generation and `replaceController` by the expected controller revision, so a stale command
cannot act on a newer link or phone.

After pairing, prompts, events, approvals, streaming, and terminal traffic bypass
Station and the control pipe and travel directly between the phone and active
session over the encrypted relay.

**Retention.** Finished open requests, including the private identity file of a session Station
launched, are deleted three days after they finish unless a live session record still references
the request. Unfinished requests are never pruned; they are reconciled when Station starts.

## Cryptography

- **Key agreement:** ECDH on **P-256** (universal Web Crypto support in Node 20 and
  browsers/WebViews). `/weft` generates a fresh keypair per session. The standalone
  Device Station persists its pairing identity by default so paired phones reconnect;
  `weft set-pairing ephemeral` restores a fresh identity on every station start.
- **Key derivation:** ECDH shared secret → **HKDF-SHA256** (salt `"weft-v1"`, info
  `"weft-session-key"` plus the fresh phone nonce and laptop challenge) → a 256-bit AES key.
  Reconnecting peers therefore derive a new session key even when they reuse persistent
  ECDH identities.
- **Payload encryption:** **AES-256-GCM** with a fresh **random 96-bit IV per
  message**. GCM provides confidentiality *and* integrity (tampered ciphertext is
  rejected on decrypt — see `shared/test/crypto.test.mjs`).
- **Replay and ordering:** each encrypted application payload contains an authenticated
  random stream id and monotonically increasing sequence number. Duplicate, stale-stream,
  and non-monotonic envelopes are dropped.
- **Channel id:** 128 bits of CSPRNG entropy, hex. Namespaces the relay channel as
  `private:weft:<channelId>`.

Encrypted application envelope on the wire:
`{ iv: base64, ciphertext: base64, ts: number }`. Tool names and prompts are inside
the ciphertext. Public handshake values and infrastructure metadata (including
channel identifiers, timing, and traffic sizes) remain visible.

## Supabase configuration

- Use **Realtime Broadcast** without database persistence of session content.
- Enable **Realtime Authorization** and add **RLS** policies on `realtime.messages`
  that limit anonymous/authenticated broadcast traffic to the `private:weft:*`
  namespace. The current policy is namespace-level, not per-user or per-channel
  authorization; channel secrecy relies on the random id, pairing grant, and E2E key.
- Channel config uses `broadcast: { self: false, ack: true }`.
- The **anon key is shippable**: it grants only the ability to attempt a join.
  Confidentiality does **not** depend on it — it rests on (a) the unguessable
  `channelId`, (b) RLS, and (c) end-to-end encryption. Even a full channel compromise
  yields only ciphertext.

## Threats & mitigations

| Threat | Mitigation | Residual risk |
|---|---|---|
| Relay/operator reads sessions | E2E AES-256-GCM; relay sees ciphertext only | requires trusted endpoints and client code; connection metadata remains visible |
| Network eavesdropper | TLS + E2E | traffic metadata remains visible; endpoint compromise is outside this protection |
| Channel-name guessing | 128-bit random `channelId` + RLS | negligible |
| Message tampering / replay | GCM authentication plus encrypted stream ids and monotonic sequence numbers reject modified, duplicate, stale-stream, and non-monotonic envelopes | a relay can still delay or drop traffic |
| **QR shoulder-surf / screenshot** | QR bearer grant expires after 10 minutes and is invalid after its first successful claim | someone who copies a fresh QR can still race the intended phone during that window |
| **Pairing race / impersonation** | the grant is proved inside ECDH-encrypted data and atomically binds to the first valid phone key; every connection requires a fresh laptop challenge and encrypted private-key proof | first valid claimant wins, so protect the QR until pairing completes |
| **Stale live record or PID reuse** | Station verifies PID and operating-system process start time for every live record, authenticates each command with the private capability plus session, runtime and generation identities, and fences repairs and takeovers by link generation and controller revision | uncertain ownership fails closed (`owner-unknown`) and may require closing the stale terminal manually |
| **Controller takeover** | a different phone receives a challenge and requires explicit confirmation; a responsive runtime immediately revokes the prior controller and rotates pairing without restarting Copilot | the previous phone is disconnected immediately after confirmation |
| Approval prompt hangs the agent | prompt remains pending until the user responds or the relay/session stops | an unattended prompt can block the session indefinitely |
| Lost/stolen phone | `/weft` keys die with the session; Device Station identities can be invalidated with `weft rotate-pairing` | a phone paired to a persistent Device Station can reconnect until its identity is rotated |
| Clipboard exposes copied secrets | clipboard reads and writes require explicit user action, accept bounded plain text only, stay inside the encrypted channel, and are excluded from persistence and diagnostic logs | a trusted paired phone can read text currently placed on the laptop clipboard when the user explicitly requests it |
| Keep Awake remains active unexpectedly | one station-owned lease is duration-capped, visibly expiring, explicitly stoppable, and cleared on expiry or Device Station shutdown without changing persistent OS power settings; the macOS inhibitor also has a native timeout and watches the Station PID | the laptop intentionally remains awake until the active lease ends |

### The QR is a bearer credential

The QR encodes the channel id, laptop public key, pairing kind, relay descriptor, a
short-lived bearer grant, expiry, and optional app version. A Supabase descriptor also
includes its client-safe anon key. The bearer grant is presented only inside data
encrypted to the laptop's ECDH key, but anyone who copies a still-valid QR can attempt
to claim it first.

Treat the QR like a glance-only password: don't screenshot or share it. An unclaimed QR
expires after 10 minutes. Stop the station and run `weft rotate-pairing` if a persistent
Device Station QR or paired phone may have been exposed, then start and pair again.
`weft start --new-device` combines rotation and startup. Stop the old station first:
replacing the stored identity does not remove one already held in memory by a running
process. End an old per-session connection before establishing a new `/weft` identity.

## Remote shell access

Terminal access is enabled by default and allows the paired phone to control one
Station-owned shell on a supported Windows laptop. This is broader than relaying Copilot
prompts and approvals: shell commands run directly with the local user's permissions.
A registered workspace sets the initial directory and is not a sandbox.

The visible laptop frontend attaches through authenticated local IPC. Terminal
messages use the existing encrypted device channel, a terminal-generation identity,
input ownership, and input sequence checks. Reconnection restores screen state; it
does not authorize retransmission of commands whose delivery is uncertain.

Terminal input, output, and screen snapshots bypass diagnostic logs and phone
transcript persistence. In-memory buffers are bounded. Shell history, invoked
programs, and operating-system monitoring can still record commands or output
independently of Weft. To revoke remote shell access, set `terminal.enabled` to
`false` in `~/.weft/weft.config.json` and restart Station; rotate pairing as well if
the phone is no longer trusted. Unreadable or invalid configuration stops startup
rather than silently bypassing an opt-out.

## What is stored where

| Location | Stored data |
|---|---|
| Phone / installed PWA | Session metadata, cached transcripts and diagnostic event logs, preferences, device records, and local pairing private keys. Diagnostic payloads can include device health snapshots. Clipboard contents and Keep Awake operation state are runtime-only and are not persisted. Pairing storage uses Capacitor Preferences on native and browser storage in the PWA. |
| Laptop | Installed code under `~/.copilot/extensions/weft/`; configuration, registered projects, logs, persistent Device Station pairing identity, live session records and their capabilities (`sessions-live/`), and open requests with the private identity of each session Station launched (`requests/`) under `~/.weft/`. A per-session `/weft` identity is ephemeral. A live record is removed by its session on exit, or by Station once the process is proven gone. Finished open requests expire three days after they finish unless a live session record still references them. |
| Relay infrastructure | No session content, transcripts, or key escrow. It handles encrypted envelopes in transit. The infrastructure provider may retain ordinary operational metadata or logs such as IP addresses, timestamps, and channel identifiers. |

Removing a session from the phone deletes its locally cached transcript. Rotating a
persistent pairing invalidates the old pairing identity; clearing browser/app data or
removing `~/.weft/` deletes the corresponding local state. Closing a `copilot` terminal
ends that live session and its ephemeral `/weft` key.

Running `/clear` also ends the current phone attachment and does not transfer its
identity to the replacement conversation. The replacement session starts dormant and
requires fresh activation.

Event logs are bounded local troubleshooting data, not an exhaustive audit trail or
a health-history service. The device log includes snapshot messages, and adjacent
repeated telemetry is coalesced. Review and redact payloads before sharing any log;
payload compaction does not guarantee removal of private content. See
[diagnostic scope and retention](https://aasis21.github.io/weft/#diagnostics).

Clipboard commands are an exception to ordinary device-event diagnostics: Weft omits
their text payloads rather than relying on later redaction. Clipboard text is limited
to 64 KiB of UTF-8 data, is held only for the active operation, and is cleared when the
mobile sheet closes.

## Endpoint and availability limitations

Encryption does not protect a compromised laptop, phone, or delivered client build.
The hosted app's provider delivers code trusted on the phone. Protect browser profiles
and local pairing keys, and review the permissions of the connected Copilot session.
A relay can delay, drop, or block traffic even when it cannot decrypt it. Local history
is not a cloud backup, and deleting browser storage requires pairing again.

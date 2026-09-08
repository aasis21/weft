# Event envelope

[Documentation handbook: protocol reference](https://aasis21.github.io/weft/#event-envelope)

Weft uses one nested envelope for messages exchanged between the phone, Device
Station, and Copilot session extensions. The shared contract lives in
`shared/messages.mjs` and `shared/messages.d.ts`.

## Wire format

```ts
interface EventEnvelope {
  eventType: string;    // "stream" | "prompt" | "approval" | "decision"
                         // | "elicitation" | "elicitation_response" | "control"
  eventSubtype: string; // fine-grained type scoped under eventType
  channelId?: string;   // populated by the secure channel on publish
  sessionId?: string;   // present when the event identifies a Copilot session
  senderId?: string;    // sender identity, when stamped
  senderName?: string;  // display label, when available
  msg: Record<string, unknown>;  // everything kind-specific — nested, never flattened
  ts: number;
}
```

Design principles:

- **`eventType` is the transport-level publish/subscribe event.** The transport
  subscribes only to the event families the client understands.
- **`eventSubtype` is scoped under `eventType`.** Together they identify the
  message without a separate mapping layer.
- **`msg` is always an object,** even when empty (`interrupt`, `state_request`).
  Nothing kind-specific ever lives outside it.
- **`channelId` and `sessionId` identify routing context** independently of the
  message-specific payload. A Device Station event does not necessarily belong
  to a Copilot session, so `sessionId` is optional.
- **`senderId` and `senderName` identify the source** for attribution in the UI.
- **`ts` records the sender timestamp** in epoch milliseconds.

## Event catalog

These are common session events, not the complete schema. Use
[`shared/messages.d.ts`](../shared/messages.d.ts) for every subtype, optional field,
and payload definition.

| eventType | eventSubtype | `msg{}` contents |
|---|---|---|
| `stream` | `assistant_message` | `{ content, messageId }` |
| `stream` | `assistant_delta` | `{ content, messageId }` |
| `stream` | `intent` | `{ text, thinking }` |
| `stream` | `tool_start` | `{ toolCallId, toolName, args }` |
| `stream` | `tool_complete` | `{ toolCallId, toolName, success, resultPreview }` |
| `stream` | `log` | `{ level, message }` |
| `stream` | `activity` | `{ busy }` |
| `stream` | `user_message` | `{ text, origin, id }` |
| `prompt` | `prompt` | `{ text, attachments?, delivery? }` |
| `approval` | `request` | `{ requestId, toolName, toolArgs, options }` |
| `approval` | `complete` | `{ requestId, decision? }` |
| `decision` | `approval_decision` | `{ requestId, optionId, raw? }` |
| `elicitation` | `request` | `{ requestId, message, mode, requestedSchema, toolCallId, url }` |
| `elicitation` | `complete` | `{ requestId, action }` |
| `elicitation_response` | `response` | `{ requestId, action, content? }` |
| `control` | `channel_up` | `{ cwd, title }` |
| `control` | `session_meta` | `{ title, cwd }` |
| `control` | `channel_down` | `{ reason }` |
| `control` | `heartbeat` | `{ latestTurnIndex, busy }` |
| `control` | `mode` | `{ mode }` |
| `control` | `interrupt` | `{}` |
| `control` | `history_request` | `{ before, since, limit }` |
| `control` | `history` | `{ items, nextCursor, hasMore, since }` |
| `control` | `state_request` | `{}` |
| `control` | `state_snapshot` | `{ busy, abortable, mode, latestTurnIndex, approvals, elicitations }` |

## Device Station events

The device channel handles laptop discovery and session launch coordination
separately from each Copilot session's stream:

| Task | Control subtypes |
| --- | --- |
| Liveness and supported features | `device_heartbeat` |
| Registered project choices | `project_list_request`, `project_list` |
| Resumable sessions | `session_list_request`, `session_list` |
| Launch or resume work | `spawn_session`, `resume_session`, `spawn_pairing`, `spawn_result`, `launch_status` |
| Join a session offered by the laptop | `session_offers`, `session_claimed` |
| Request current health | `device_monitor_start`, `device_monitor_stop`, `device_snapshot` |
| Transfer clipboard text explicitly | `clipboard_read`, `clipboard_write`, `clipboard_result` |
| Control a temporary Keep Awake lease | `keep_awake_start`, `keep_awake_stop`, `keep_awake_status_request`, `keep_awake_status` |
| Remove device trust | `forget_device` |

Health monitoring is capability-negotiated with `device-monitor-v1`. Its snapshot
schema is separate from the session's `state_snapshot`: one describes the laptop,
the other describes a Copilot session. See the shared declarations for monitoring
IDs, sequence numbers, system metrics, application summaries, and issue fields.

Clipboard and Keep Awake are independently capability-negotiated with
`device-clipboard-v1` and `device-keep-awake-v1`. Clipboard messages are correlated
with request IDs and carry plain text only for the explicit operation that requested
it. Keep Awake messages identify a bounded lease and its authoritative expiry.
Clipboard payloads are deliberately omitted from the phone's device event log.

The phone's device event log includes `device_snapshot`, but it is not a lossless
wire capture: consecutive heartbeat/snapshot messages of the same subtype and
direction are coalesced, and retention is bounded. Device and session logs use
separate channels; see [the diagnostic guide](https://aasis21.github.io/weft/#diagnostics).

## Pairing bootstrap

Pairing events are transported before a `SecureChannel` is available:

- `pair.hello` shares the phone public key and fresh nonce.
- `pair.challenge` binds the attempt to a fresh laptop challenge.
- `pair.proof` encrypts the private-key and pairing-grant proof.
- `pair.ack` confirms the negotiated session key in an encrypted,
  nonce-and-challenge-bound acknowledgement.

Only public handshake data is exposed by the hello and challenge. Pairing proofs
and acknowledgements are encrypted.

## Secure channel behavior

`shared/channel.mjs` encrypts the complete event envelope with AES-256-GCM. Each
connection uses a random stream ID and monotonically increasing sequence number.
The receiver authenticates and validates an envelope once, rejects replayed or
retired-stream messages, and then delivers the accepted message to every handler
registered for its `eventType`.

## Implementation map

- `shared/messages.mjs` and `shared/messages.d.ts` define event types, subtypes,
  envelope types, and message factories.
- `shared/pairing.mjs` establishes the session key.
- `shared/channel.mjs` encrypts, sequences, validates, and dispatches envelopes.
- `extension/src/relay.mjs` translates Copilot CLI events into shared messages.
- `mobile/src/session/` applies messages to the phone session state.

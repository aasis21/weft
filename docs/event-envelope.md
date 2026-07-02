# Event envelope redesign (implemented)

> **Status: IMPLEMENTED.** `shared/`, `extension/`, and `mobile/` all speak the nested
> envelope described here. The wire shape is `{ eventType, eventSubtype, channelId,
> sessionId, senderId, senderName, msg, ts }`; `EVENT_TYPE` + `SUBTYPE` (nested per type)
> replace the old `EVENTS` + `KIND` + `eventForKind()` mapping, which have been removed.
> Pairing (`PAIR.HELLO`/`ACK`) travels on the same envelope. The "Current state" section
> below is retained for historical context only.

## Problem with the current shape

Today (`shared/messages.mjs`) the protocol has two overlapping enums bridged by a
hand-maintained mapping function:

- `EVENTS` (7 values) — the wire-level topic a message is published on.
- `KIND` (~20 values) — the fine-grained type of the message.
- `eventForKind(kind)` — a switch statement mapping every `KIND` to its `EVENTS`,
  which must be kept in sync by hand whenever a kind is added.

The decrypted message itself is flat — identity fields (`userId`, `deviceId`,
`sessionId`, stamped by `SecureChannel.send()`), the `kind`, `ts`, and every
kind-specific field (`content`, `requestId`, `toolName`, ...) all sit as siblings
at the same object level, with no structural boundary between "envelope" and
"payload." Every consumer has to know, per `kind`, which top-level keys belong to
it. Handlers also frequently subscribe by `EVENTS` group and then re-check `kind`
inside the handler (e.g. `relay.mjs`'s `onEvent(EVENTS.DECISION, (msg) => { if
(msg?.kind !== KIND.APPROVAL_DECISION) return; ... })`), which is redundant once
you're already filtering by the specific type.

## Decision: standardized, nested envelope

Replace the flat shape with one generic envelope, used by every message:

```ts
interface EventEnvelope {
  eventType: string;    // "stream" | "prompt" | "approval" | "decision"
                         // | "elicitation" | "elicitation_response" | "control"
                         // — the wire-level topic; == today's EVENTS, unchanged (7 values)
  eventSubtype: string; // fine-grained type, scoped under eventType
                         // — replaces today's KIND, but consistently namespaced
  channelId: string;    // the pairing's channel id (private:helm:<channelId>)
  sessionId: string;    // the Copilot CLI session being mirrored
  senderId: string;     // stable device identifier: "laptop" | "phone-<uuid>"
  senderName: string;   // display label for who sent it
  msg: Record<string, unknown>;  // everything kind-specific — nested, never flattened
  ts: number;
}
```

Design rationale:

- **`eventType` stays at 7 values and stays == the transport-level publish/subscribe
  event.** No change to `Transport`, no wildcard-subscribe plumbing needed, no change
  to Supabase channel/RLS behavior. `ALL_EVENTS` in `mobile/src/lib/helmClient.ts`
  keeps working unmodified.
- **`eventSubtype` replaces `KIND`,** but is scoped under its `eventType` instead of
  being an independently-invented flat string. `eventForKind()` is deleted entirely —
  there is nothing to keep in sync, because `eventType` is just a field on the
  message, not derived from `eventSubtype` via a lookup table.
- **`msg` is always an object,** even when empty (`interrupt`, `state_request`).
  Nothing kind-specific ever lives outside it.
- **`channelId` / `sessionId` move from ad hoc per-kind fields (e.g. `channel_up`
  used to carry both) to the envelope**, since every message already travels on a
  specific channel/session — this removes the one place (`channel_up`) that
  previously duplicated data implicit in the subscription context.
- **`senderId` / `senderName` replace `SecureChannel`'s `identity.deviceId` /
  `identity.userId`.** Today those identity fields are stamped on every outgoing
  message but are **write-only** — no handler currently reads them back
  (confirmed by grep across `relay.mjs`, `sessionManager.ts`, `timeline.ts`).
  `senderId` maps cleanly onto `deviceId` (stable, unique per physical device).
  `senderName` maps onto `userId`, which today is just a fixed role constant
  (`"copilot"` / `"phone"`) — renaming it doesn't add capability by itself, but
  positions the field for a real display name if the product ever grows a
  multi-user/account concept.
  - **Open question (unresolved as of this doc):** should `senderName` stay a role
    label for now, or is it meant to carry a real per-user display name later?

## Full audit: every current `kind` → `eventType` / `eventSubtype` / `msg{}`

| eventType | eventSubtype | `msg{}` contents |
|---|---|---|
| `stream` | `assistant_message` | `{ content, messageId }` |
| `stream` | `assistant_delta` | `{ content, messageId }` |
| `stream` | `tool_start` | `{ toolCallId, toolName, args }` |
| `stream` | `tool_complete` | `{ toolCallId, toolName, success, resultPreview }` |
| `stream` | `log` | `{ level, message }` |
| `stream` | `activity` | `{ busy }` |
| `stream` | `user_message` | `{ text, origin, id }` |
| `prompt` | `prompt` | `{ text, attachments? }` |
| `approval` | `request` | `{ requestId, toolName, toolArgs, options }` |
| `decision` | `approval_decision` | `{ requestId, optionId, raw? }` |
| `elicitation` | `request` | `{ requestId, message, mode, requestedSchema, toolCallId, url }` |
| `elicitation` | `complete` | `{ requestId, action }` |
| `elicitation_response` | `response` | `{ requestId, action, content? }` |
| `control` | `channel_up` | `{ cwd, title }` (was `{ channelId, sessionId, cwd, title }` — the first two move to the envelope) |
| `control` | `session_meta` | `{ title, cwd }` |
| `control` | `channel_down` | `{ reason }` |
| `control` | `heartbeat` | `{ latestTurnIndex, busy }` |
| `control` | `mode` | `{ mode }` |
| `control` | `interrupt` | `{}` |
| `control` | `history_request` | `{ before, since, limit }` |
| `control` | `history` | `{ items, nextCursor, hasMore, since }` |
| `control` | `state_request` | `{}` |
| `control` | `state_snapshot` | `{ busy, abortable, mode, latestTurnIndex, approvals, elicitations }` |

The `pair.hello` / `pair.ack` bootstrap events (`shared/pairing.mjs`) are
unaffected by this doc — they run before a `SecureChannel`/AES key exists, so
they're plaintext and out of scope for the envelope format.

## Current state (for contrast, as implemented today)

```js
// shared/channel.mjs — SecureChannel.send()
async send(message) {
  const tagged = { ...this.identity, ...message };  // flat merge, no envelope boundary
  const event = eventForKind(message.kind);           // hand-maintained KIND -> EVENTS map
  const enc = await encryptJSON(this.key, tagged);
  await this.transport.publish(event, { ...enc, ts: message.ts ?? Date.now() });
}
```

Decrypted shape today, e.g. for `kind: "assistant.message"`:

```js
{
  userId: "copilot", deviceId: "laptop", sessionId: "abc-session",
  kind: "assistant.message", content: "hi", messageId: "sdk-evt-123",
  ts: 1751500000000,
}
```

## Implementation scope (when this is picked up)

Touches: `shared/messages.mjs` / `.d.ts` (rewrite), `shared/channel.mjs` (drop
`eventForKind`, build the envelope), `extension/src/relay.mjs` (every
`channel.onEvent(EVENTS.X, ...)` call site + kind-guards + every `data.foo` /
`msg.foo` access), `mobile/src/lib/sessionManager.ts`, `mobile/src/lib/timeline.ts`,
`mobile/src/lib/helmClient.ts`, and every test in `shared/test/*` and
`mobile/src/lib/__tests__/*` that asserts on `kind` / `EVENTS` / flat payload
fields. This is a **wire-protocol breaking change** — the extension and the
mobile app must be redeployed together; there is no on-wire backward-compat
shim planned.

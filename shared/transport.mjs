// Weft transport abstraction.
//
// A Transport delivers opaque, already-encrypted envelopes for ONE pairing channel
// (identified by channelId), multiplexed by logical event name (see EVENTS in messages.mjs).
// It knows nothing about plaintext or crypto — SecureChannel (channel.mjs) layers those on top.
//
//   interface Transport {
//     connect(): Promise<void>
//     publish(event: string, envelope: Envelope): Promise<void>
//     subscribe(event: string, handler: (envelope: Envelope) => void): Unsubscribe
//     close(): Promise<void>
//   }
//   type Envelope = { iv: string, ciphertext: string, ts: number }
//   type Unsubscribe = () => void
//
// Four implementations:
//   - createLocalTransport  (transport-local.mjs)     — in-process pub/sub for the harness/tests
//   - createSupabaseTransport (transport-supabase.mjs) — Supabase Realtime Broadcast (Phase 2)
//   - createWebPubSubTransport (transport-webpubsub.mjs) — Azure Web PubSub group broadcast
//   - createRelayTransport (transport-relay.mjs) — any self-hosted/tunneled `ws` endpoint (e.g.
//     a plain ws server you run yourself, or one reached through a Microsoft Dev Tunnel)

export { createLocalTransport } from "./transport-local.mjs";
export { createSupabaseTransport } from "./transport-supabase.mjs";
export { createWebPubSubTransport } from "./transport-webpubsub.mjs";
export { createRelayTransport } from "./transport-relay.mjs";

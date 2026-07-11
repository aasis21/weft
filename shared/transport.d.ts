import type { EncryptedPayload } from "./crypto";

export interface Envelope extends EncryptedPayload {
  ts: number;
}

export type Unsubscribe = () => void;

/**
 * Serializable, non-secret description of which transport + endpoint a channel should use.
 * The laptop resolves this from its own env at pairing time and stamps it into the QR
 * (see pairing.d.ts PairingPayload.transport) so the phone builds a matching transport at
 * runtime, with zero pre-baked config of its own. Nothing here is a credential: Supabase's
 * anon key is meant to be public (RLS enforces access), and Web PubSub's actual per-connection
 * token is minted separately by the negotiate endpoint, never carried in the descriptor.
 * "devtunnel" is the one exception — its url is the base WebSocket URL of a self-hosted relay
 * exposed through a Microsoft Dev Tunnel (or any equivalent tunnel/reverse-proxy) with anonymous
 * connect access. It's channel-agnostic (channel/room selection is applied at socket-construction
 * time via `?channelId=…`, symmetric with how Supabase applies channelId via its client SDK),
 * not durable, and only reachable while the operator keeps the shared relay alive on their
 * machine — so carrying it in the QR matches the trust level of a one-time pairing code rather
 * than a persistent credential.
 */
export type TransportDescriptor =
  | { kind: "local" }
  | { kind: "supabase"; url: string; anonKey: string }
  | { kind: "webpubsub"; negotiateUrl: string }
  | { kind: "devtunnel"; url: string };

/** Live connection state of the underlying socket, reported after connect(). */
export type TransportStatus = "connected" | "disconnected";

export interface Transport {
  connect(): Promise<void>;
  publish(event: string, envelope: Envelope): Promise<void>;
  subscribe(event: string, handler: (envelope: Envelope) => void): Unsubscribe;
  /**
   * Optional: observe ongoing connection-state changes (socket drop / silent
   * disconnect / rejoin) that happen AFTER the initial connect(). Transports that
   * can't detect this omit the method; callers must treat it as optional. A handler
   * registered while already connected is invoked once with "connected".
   */
  onStatus?(handler: (status: TransportStatus, detail?: unknown) => void): Unsubscribe;
  close(): Promise<void>;
}

export function createLocalTransport(opts: {
  channelId: string;
  deliverSelf?: boolean;
}): Transport;

/** Phase 2 (p2-relay): pass a SupabaseClient from @supabase/supabase-js. */
export function createSupabaseTransport(opts: { client: unknown; channelId: string }): Transport;

/** Pass an already-constructed WebPubSubClient from @azure/web-pubsub-client (not yet started). */
export function createWebPubSubTransport(opts: { client: unknown; channelId: string }): Transport;

/**
 * Pass an already-constructed, already-authenticated WebSocket (the `ws` package, or the
 * browser/React Native global WebSocket) pointed at a self-hosted relay or tunnel (e.g. a
 * Microsoft Dev Tunnel) URL. Not yet required to be open — connect() awaits the "open" event.
 */
export function createRelayTransport(opts: { socket: unknown; channelId: string }): Transport;

export function _resetLocalBus(): void;

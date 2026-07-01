import type { EncryptedPayload } from "./crypto";

export interface Envelope extends EncryptedPayload {
  ts: number;
}

export type Unsubscribe = () => void;

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

export function _resetLocalBus(): void;

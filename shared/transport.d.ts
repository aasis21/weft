import type { EncryptedPayload } from "./crypto";

export interface Envelope extends EncryptedPayload {
  ts: number;
}

export type Unsubscribe = () => void;

export interface Transport {
  connect(): Promise<void>;
  publish(event: string, envelope: Envelope): Promise<void>;
  subscribe(event: string, handler: (envelope: Envelope) => void): Unsubscribe;
  close(): Promise<void>;
}

export function createLocalTransport(opts: {
  channelId: string;
  deliverSelf?: boolean;
}): Transport;

/** Phase 2 (p2-relay): pass a SupabaseClient from @supabase/supabase-js. */
export function createSupabaseTransport(opts: { client: unknown; channelId: string }): Transport;

export function _resetLocalBus(): void;

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  EVENTS,
  SecureChannel,
  createLocalTransport,
  createSupabaseTransport,
  generateKeyPair,
  isValidInner,
  parsePairingPayload,
  sayHello,
} from '@aasis21/helm-shared';
import type { InnerMessage, LogicalEvent, Transport } from '@aasis21/helm-shared';
import type { StoredPairing } from './storage';

export interface HelmClient {
  channelId: string;
  channel: SecureChannel;
  send(message: InnerMessage): Promise<void>;
  subscribe(handler: (message: InnerMessage, event: LogicalEvent) => void): () => void;
  /** Observe live socket state (drop/rejoin) after connect; no-op on transports that can't detect it. */
  onStatus(handler: (status: 'connected' | 'disconnected') => void): () => void;
  close(): Promise<void>;
}

const ALL_EVENTS: LogicalEvent[] = [
  EVENTS.STREAM,
  EVENTS.PROMPT,
  EVENTS.APPROVAL,
  EVENTS.DECISION,
  EVENTS.ELICITATION,
  EVENTS.CONTROL,
];

/**
 * Pair with a freshly-scanned laptop QR. Returns a live client *and* the
 * StoredPairing material so the caller can persist it in the session list.
 * Does not write to storage itself.
 */
export async function pairSession(
  raw: string,
  opts?: { transport?: Transport },
): Promise<{ client: HelmClient; pairing: StoredPairing }> {
  const { channelId, publicKeyB64 } = parsePairingPayload(raw);
  const phoneKeys = await generateKeyPair();
  const deviceId = getStableDeviceId();
  const transport = opts?.transport ?? createTransport(channelId);
  const { key } = await sayHello({
    transport,
    keyPair: phoneKeys,
    peerPublicKeyB64: publicKeyB64,
    deviceId,
    waitForAck: true,
    timeoutMs: 20_000,
  });
  const privateKeyJwk = await crypto.subtle.exportKey('jwk', phoneKeys.privateKey);
  const pairing: StoredPairing = {
    channelId,
    peerPublicKeyB64: publicKeyB64,
    publicKeyB64: phoneKeys.publicKeyB64,
    privateKeyJwk,
    deviceId,
    savedAt: Date.now(),
  };
  const client = await createClientFromMaterial({ channelId, key, deviceId, transport });
  return { client, pairing };
}

/** Reconnect to a previously-joined session from its stored ECDH material. */
export async function connectSession(
  pairing: StoredPairing,
  opts?: { transport?: Transport },
): Promise<HelmClient> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    pairing.privateKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const transport = opts?.transport ?? createTransport(pairing.channelId);
  const { key } = await sayHello({
    transport,
    keyPair: { privateKey, publicKeyB64: pairing.publicKeyB64 },
    peerPublicKeyB64: pairing.peerPublicKeyB64,
    deviceId: pairing.deviceId,
    waitForAck: false,
  });
  return createClientFromMaterial({
    channelId: pairing.channelId,
    key,
    deviceId: pairing.deviceId,
    transport,
  });
}

export async function createClientFromMaterial(opts: {
  channelId: string;
  key: CryptoKey;
  deviceId?: string;
  userId?: string;
  transport?: Transport;
}): Promise<HelmClient> {
  const channel = new SecureChannel({
    transport: opts.transport ?? createTransport(opts.channelId),
    key: opts.key,
    identity: {
      userId: opts.userId ?? 'phone',
      deviceId: opts.deviceId ?? getStableDeviceId(),
      sessionId: opts.channelId,
    },
  });
  await channel.connect();
  return wrapChannel(opts.channelId, channel);
}

// ONE Supabase client (hence one WebSocket) is shared across every channel. Supabase Realtime — like
// Phoenix Channels underneath it — multiplexes many channel subscriptions over a single socket, so a
// client-per-channel (the previous shape) opened N sockets for no reason. Memoizing it means N joined
// sessions cost one socket and N cheap topic subscriptions, with a single managed reconnect loop.
// Each channel still authorizes independently (private-channel RLS) and carries its own ECDH key.
let sharedClient: SupabaseClient | undefined;

function getSupabaseClient(url: string, anonKey: string): SupabaseClient {
  if (!sharedClient) {
    sharedClient = createClient(url, anonKey);
    // Private channels authorize against RLS on realtime.messages; the anon key is the realtime
    // access token. Apply supabase/migrations first or joins are denied.
    sharedClient.realtime.setAuth(anonKey);
  }
  return sharedClient;
}

function createTransport(channelId: string): Transport {
  if (import.meta.env.VITE_HELM_TRANSPORT === 'supabase') {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before using Supabase transport.');
    }
    const client = getSupabaseClient(url, anonKey);
    return createSupabaseTransport({ client, channelId });
  }
  return createLocalTransport({ channelId });
}

function wrapChannel(channelId: string, channel: SecureChannel): HelmClient {
  return {
    channelId,
    channel,
    send: (message) => channel.send(message),
    subscribe(handler) {
      const unsubs = ALL_EVENTS.map((event) =>
        channel.onEvent(event, (message) => {
          if (isValidInner(message)) handler(message, event);
        }),
      );
      return () => {
        for (const unsub of unsubs) unsub();
      };
    },
    onStatus(handler) {
      return channel.onStatus(handler as (status: string, detail?: unknown) => void);
    },
    close: () => channel.close(),
  };
}

function getStableDeviceId(): string {
  const key = 'helm.deviceId.v1';
  const existing = globalThis.localStorage?.getItem(key);
  if (existing) return existing;
  const next = `phone-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  globalThis.localStorage?.setItem(key, next);
  return next;
}

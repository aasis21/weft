import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import {
  EVENT_TYPE,
  SecureChannel,
  createLocalTransport,
  createSupabaseTransport,
  generateKeyPair,
  isValidEnvelope,
  parsePairingPayload,
  sayHello,
} from '@aasis21/helm-shared';
import type { EventEnvelope, EventType, Transport } from '@aasis21/helm-shared';
import type { StoredPairing } from './storage';

/** A connect that never reaches SUBSCRIBED (a wedged/suspended shared socket) would otherwise hang
 *  forever, wedging the caller — e.g. reconnect()'s in-flight guard never clears, so the Reconnect
 *  button no-ops. Bound it so a dead connect fails honestly instead. Under the 30s liveness window. */
const CONNECT_TIMEOUT_MS = 15_000;
/** A send whose broadcast never acks (same wedged socket) would hang forever, so the optimistic UI
 *  (sending bubble, dismissed approval/elicitation, mode toggle, history spinner) never receives its
 *  failure signal and stays stuck. Bounding it turns a hang into a reject — which every send call
 *  site already recovers from (setUserFailed / restore* / markHistoryLoading(false) / mode revert). */
const SEND_TIMEOUT_MS = 10_000;

/** Reject with `message` if `promise` hasn't settled within `ms`; always clears its own timer. The
 *  underlying op is NOT cancelled, so callers holding a resource (e.g. a transport) clean it up. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export interface HelmClient {
  channelId: string;
  channel: SecureChannel;
  send(message: EventEnvelope): Promise<void>;
  subscribe(handler: (message: EventEnvelope, event: EventType) => void): () => void;
  /** Observe live socket state (drop/rejoin) after connect; no-op on transports that can't detect it. */
  onStatus(handler: (status: 'connected' | 'disconnected') => void): () => void;
  close(): Promise<void>;
}

const ALL_EVENTS: EventType[] = [
  EVENT_TYPE.STREAM,
  EVENT_TYPE.PROMPT,
  EVENT_TYPE.APPROVAL,
  EVENT_TYPE.DECISION,
  EVENT_TYPE.ELICITATION,
  EVENT_TYPE.CONTROL,
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
    senderName: getSenderName(),
    channelId,
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
  let client: HelmClient;
  try {
    client = await createClientFromMaterial({ channelId, key, deviceId, transport });
  } catch (err) {
    void transport.close().catch(() => {});
    throw err;
  }
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
  try {
    return await withTimeout(
      (async () => {
        const { key } = await sayHello({
          transport,
          keyPair: { privateKey, publicKeyB64: pairing.publicKeyB64 },
          peerPublicKeyB64: pairing.peerPublicKeyB64,
          deviceId: pairing.deviceId,
          senderName: getSenderName(),
          channelId: pairing.channelId,
          waitForAck: false,
        });
        return createClientFromMaterial({
          channelId: pairing.channelId,
          key,
          deviceId: pairing.deviceId,
          transport,
        });
      })(),
      CONNECT_TIMEOUT_MS,
      'Couldn’t reach your session — the terminal may be closed. Reconnect to try again.',
    );
  } catch (err) {
    // The connect never completed: drop the half-open channel so it can't leak a subscription on the
    // shared socket, then rethrow so the caller's guard/finally (e.g. reconnect) can recover.
    void transport.close().catch(() => {});
    throw err;
  }
}

export async function createClientFromMaterial(opts: {
  channelId: string;
  key: CryptoKey;
  deviceId?: string;
  transport?: Transport;
}): Promise<HelmClient> {
  const channel = new SecureChannel({
    transport: opts.transport ?? createTransport(opts.channelId),
    key: opts.key,
    identity: {
      channelId: opts.channelId,
      senderId: opts.deviceId ?? getStableDeviceId(),
      senderName: getSenderName(),
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
    send: (message) =>
      withTimeout(
        channel.send(message),
        SEND_TIMEOUT_MS,
        'Message timed out — the connection may be down. Try again.',
      ),
    subscribe(handler) {
      const unsubs = ALL_EVENTS.map((event) =>
        channel.onEvent(event, (message) => {
          if (isValidEnvelope(message)) handler(message, event);
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

/** The phone's display label on the wire: "App" in the installed Capacitor app, "WebApp" in a
 *  browser. Falls back to "WebApp" if the platform probe throws (e.g. plugin unavailable). */
export function getSenderName(): string {
  try {
    return Capacitor.isNativePlatform() ? 'App' : 'WebApp';
  } catch {
    return 'WebApp';
  }
}

function getStableDeviceId(): string {
  const key = 'helm.deviceId.v1';
  const existing = globalThis.localStorage?.getItem(key);
  if (existing) return existing;
  const next = `phone-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  globalThis.localStorage?.setItem(key, next);
  return next;
}

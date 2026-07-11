import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { Capacitor } from '@capacitor/core';
import {
  EVENT_TYPE,
  SecureChannel,
  createLocalTransport,
  createSupabaseTransport,
  createRelayTransport,
  generateKeyPair,
  isValidEnvelope,
  parsePairingPayload,
  sayHello,
} from '@aasis21/weft-shared';
import type { EventEnvelope, EventType, Transport, TransportDescriptor } from '@aasis21/weft-shared';
import type { PairingPayload } from '@aasis21/weft-shared';
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

export interface WeftClient {
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
  raw: string | PairingPayload,
  opts?: { transport?: Transport },
): Promise<{ client: WeftClient; pairing: StoredPairing }> {
  const { channelId, publicKeyB64, transport: transportDescriptor } = parsePairingPayload(raw);
  return pairWithPublicKey({
    channelId,
    publicKeyB64,
    transportDescriptor,
    transport: opts?.transport,
  });
}

export async function pairWithPublicKey(opts: {
  channelId: string;
  publicKeyB64: string;
  /** Which transport + endpoint to connect with — laptop-resolved, carried in the QR/pairing payload. */
  transportDescriptor: TransportDescriptor;
  transport?: Transport;
}): Promise<{ client: WeftClient; pairing: StoredPairing }> {
  const { channelId, publicKeyB64, transportDescriptor } = opts;
  const phoneKeys = await generateKeyPair();
  const deviceId = getStableDeviceId();
  const transport = opts.transport ?? createTransportFromDescriptor(transportDescriptor, channelId);
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
    transport: transportDescriptor,
  };
  let client: WeftClient;
  try {
    client = await createClientFromMaterial({ channelId, key, deviceId, transport });
  } catch (err) {
    void transport.close().catch(() => {});
    throw err;
  }
  return { client, pairing };
}

/** Shared shape for "reuse a previously-derived ECDH identity to reconnect without a fresh
 *  handshake" — satisfied by both StoredPairing (sessions) and RegisteredDevice (listeners). */
interface ReconnectMaterial {
  channelId: string;
  peerPublicKeyB64: string;
  publicKeyB64: string;
  privateKeyJwk: JsonWebKey;
  deviceId?: string;
  transport: TransportDescriptor;
}

/**
 * Reconnect using a previously-derived ECDH keypair instead of minting a new one. Critical for
 * listener devices (#device-reconnect): the laptop's `weft` listener locks onto the FIRST
 * phone public key it sees per run (`boundPeerPub` in listener.mjs) and silently ignores any hello
 * from a different key ("ignoring pairing from a different phone"). Generating a fresh keypair on
 * every reconnect (as a first-time pairing does) would make the SAME phone look like an intruder
 * to its own listener. Reusing the stored keypair + a fire-and-forget hello (no ack wait, mirroring
 * connectSession) keeps the phone's identity stable across reconnects.
 */
async function reconnectFromMaterial(
  material: ReconnectMaterial,
  opts?: { transport?: Transport },
): Promise<WeftClient> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    material.privateKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const transport =
    opts?.transport ?? createTransportFromDescriptor(material.transport, material.channelId);
  try {
    return await withTimeout(
      (async () => {
        const { key } = await sayHello({
          transport,
          keyPair: { privateKey, publicKeyB64: material.publicKeyB64 },
          peerPublicKeyB64: material.peerPublicKeyB64,
          deviceId: material.deviceId,
          senderName: getSenderName(),
          channelId: material.channelId,
          waitForAck: false,
        });
        return createClientFromMaterial({
          channelId: material.channelId,
          key,
          deviceId: material.deviceId,
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

/** Reconnect to a previously-joined session from its stored ECDH material. */
export async function connectSession(
  pairing: StoredPairing,
  opts?: { transport?: Transport },
): Promise<WeftClient> {
  return reconnectFromMaterial(pairing, opts);
}

/** Reconnect to a previously-registered listener device from its stored ECDH material — mirrors
 *  connectSession(), so a re-scan is never required just to resume talking to the same laptop. */
export async function connectDevice(
  device: ReconnectMaterial,
  opts?: { transport?: Transport },
): Promise<WeftClient> {
  return reconnectFromMaterial(device, opts);
}

export async function createClientFromMaterial(opts: {
  channelId: string;
  key: CryptoKey;
  deviceId?: string;
  transport: Transport;
}): Promise<WeftClient> {
  const channel = new SecureChannel({
    transport: opts.transport,
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

// ONE Supabase client (hence one WebSocket) is shared per distinct (url, anonKey) pair — Supabase
// Realtime, like Phoenix Channels underneath it, multiplexes many channel subscriptions over a
// single socket, so a client-per-channel opened N sockets for no reason. Memoizing it means N
// joined sessions on the same relay cost one socket and N cheap topic subscriptions, with a
// single managed reconnect loop. Each channel still authorizes independently (private-channel
// RLS) and carries its own ECDH key. Keyed (not a single global) because the transport descriptor
// is now laptop-controlled per pairing — different sessions may point at different relays.
const sharedSupabaseClients = new Map<string, SupabaseClient>();

function getSupabaseClient(url: string, anonKey: string): SupabaseClient {
  const cacheKey = `${url}::${anonKey}`;
  let client = sharedSupabaseClients.get(cacheKey);
  if (!client) {
    client = createClient(url, anonKey, {
      // Weft uses the anon key directly for realtime auth (private-channel RLS); there is no
      // Supabase user session in play. Disabling persist/auto-refresh prevents the auth module
      // from firing SIGNED_IN / TOKEN_REFRESHED events that would call realtime.setAuth() with
      // a stale or wrong token — on Android, localStorage persists across app restarts, making
      // that race far more likely than it is in a browser session. Mirrors extension/src/transportFactory.mjs.
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    // Private channels authorize against RLS on realtime.messages; the anon key is the realtime
    // access token. Apply supabase/migrations first or joins are denied.
    client.realtime.setAuth(anonKey);
    sharedSupabaseClients.set(cacheKey, client);
  }
  return client;
}

/**
 * Build a live Transport from a pairing's transport descriptor (see TransportDescriptor). The
 * laptop resolves this from its own env at pairing time and stamps it into the QR/pairing
 * payload — the phone has no transport env config of its own and just builds whatever the
 * descriptor says, switching transport/endpoint requires only a fresh scan, not a rebuild.
 */
function createTransportFromDescriptor(descriptor: TransportDescriptor, channelId: string): Transport {
  if (!descriptor?.kind) {
    // Belt-and-braces: sessions.ts already filters these out on load, but a directly-stored
    // pairing (e.g. storage.ts's single "current" pairing) could still reach here. Fail with a
    // clear, actionable message instead of a raw "Cannot read properties of undefined" crash.
    throw new Error('Weft: this session has no transport info — remove it and re-pair by scanning a fresh QR.');
  }
  if (descriptor.kind === 'local') return createLocalTransport({ channelId });
  if (descriptor.kind === 'supabase') {
    const client = getSupabaseClient(descriptor.url, descriptor.anonKey);
    return createSupabaseTransport({ client, channelId });
  }
  if (descriptor.kind === 'devtunnel') {
    // Symmetric with the supabase branch above: the descriptor carries only the relay's base
    // WebSocket URL (see extension-side resolveDevTunnelTransport), and channel/room selection
    // is applied here at socket-construction time \u2014 exactly like createSupabaseTransport takes
    // channelId as a separate arg. The relay server on the other end of the tunnel (see
    // extension/src/relayServer.mjs) reads `?channelId=` from the incoming URL to room-match this
    // socket with the laptop's; createRelayTransport itself never puts channelId on the wire.
    // React Native's global WebSocket is the standard-compliant socket createRelayTransport
    // expects (addEventListener/send/close/readyState).
    const socket = new WebSocket(withChannelId(descriptor.url, channelId));
    return createRelayTransport({ socket, channelId });
  }
  throw new Error(`Weft: unknown transport descriptor kind "${(descriptor as { kind: string }).kind}"`);
}

/** Appends `?channelId=\u2026` (or `&channelId=\u2026` if the URL already has a query string) so a bare
 * relay baseUrl becomes a room-scoped connect URL \u2014 mirrors the same helper on the extension
 * side (transportFactory.mjs) so both peers assemble identical URLs. */
function withChannelId(baseUrl: string, channelId: string): string {
  const sep = baseUrl.includes('?') ? '&' : '?';
  return `${baseUrl}${sep}channelId=${encodeURIComponent(channelId)}`;
}

function wrapChannel(channelId: string, channel: SecureChannel): WeftClient {
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

export function getStableDeviceId(): string {
  const key = 'weft.deviceId.v1';
  const existing = globalThis.localStorage?.getItem(key);
  if (existing) return existing;
  const next = `phone-${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  globalThis.localStorage?.setItem(key, next);
  return next;
}

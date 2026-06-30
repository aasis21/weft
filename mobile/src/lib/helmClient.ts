import { createClient } from '@supabase/supabase-js';
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
import { loadStoredPairing, saveStoredPairing } from './storage';
import type { StoredPairing } from './storage';

export interface HelmClient {
  channelId: string;
  channel: SecureChannel;
  send(message: InnerMessage): Promise<void>;
  subscribe(handler: (message: InnerMessage, event: LogicalEvent) => void): () => void;
  close(): Promise<void>;
}

const ALL_EVENTS: LogicalEvent[] = [
  EVENTS.STREAM,
  EVENTS.PROMPT,
  EVENTS.APPROVAL,
  EVENTS.DECISION,
  EVENTS.CONTROL,
];

export async function pairFromQr(raw: string): Promise<HelmClient> {
  const { channelId, publicKeyB64 } = parsePairingPayload(raw);
  const phoneKeys = await generateKeyPair();
  const deviceId = getStableDeviceId();
  const transport = createTransport(channelId);
  const { key } = await sayHello({
    transport,
    keyPair: phoneKeys,
    peerPublicKeyB64: publicKeyB64,
    deviceId,
    waitForAck: true,
    timeoutMs: 10_000,
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
  await saveStoredPairing(pairing);
  return createClientFromMaterial({ channelId, key, deviceId, transport });
}

export async function restorePairing(): Promise<HelmClient | null> {
  const pairing = await loadStoredPairing();
  if (!pairing) return null;
  if (!pairing.publicKeyB64) return null;
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    pairing.privateKeyJwk,
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  );
  const transport = createTransport(pairing.channelId);
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

function createTransport(channelId: string): Transport {
  if (import.meta.env.VITE_HELM_TRANSPORT === 'supabase') {
    const url = import.meta.env.VITE_SUPABASE_URL;
    const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;
    if (!url || !anonKey) {
      throw new Error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before using Supabase transport.');
    }
    return createSupabaseTransport({ client: createClient(url, anonKey), channelId });
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

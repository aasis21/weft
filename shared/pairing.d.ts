import type { Transport } from "./transport";

export declare const PAIR_VERSION: 1;

export interface PairingPayload {
  v: 1;
  channelId: string;
  pub: string;
}

/** Info about a paired peer, as seen by the laptop after a hello. */
export interface PairedPeer {
  publicKeyB64: string;
  deviceId?: string;
  senderName?: string;
}

export declare function buildPairingPayload(opts: {
  channelId: string;
  publicKeyB64: string;
}): PairingPayload;

export declare function parsePairingPayload(
  input: string | PairingPayload,
): { channelId: string; publicKeyB64: string };

export declare function listenForPeers(opts: {
  transport: Transport;
  keyPair: { privateKey: CryptoKey };
  onPeer: (info: { key: CryptoKey; peer: PairedPeer }) => void | Promise<void>;
  connect?: boolean;
  channelId?: string;
  senderId?: string;
  senderName?: string;
}): Promise<{ stop: () => void }>;

export declare function waitForPeer(opts: {
  transport: Transport;
  keyPair: { privateKey: CryptoKey };
  timeoutMs?: number;
  connect?: boolean;
  channelId?: string;
  senderId?: string;
  senderName?: string;
}): Promise<{ key: CryptoKey; peer: PairedPeer }>;

export declare function sayHello(opts: {
  transport: Transport;
  keyPair: { privateKey: CryptoKey; publicKeyB64: string };
  peerPublicKeyB64: string;
  deviceId?: string;
  senderName?: string;
  channelId?: string;
  waitForAck?: boolean;
  timeoutMs?: number;
  retryMs?: number;
}): Promise<{ key: CryptoKey }>;

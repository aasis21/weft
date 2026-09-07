import type { Transport, TransportDescriptor } from "./transport";

export declare const PAIR_VERSION: 2;
export declare const PAIRING_TTL_MS: number;

/** Pairing payload kinds: a normal mirrored session vs an ephemeral `weft` listener. */
export type PairKind = "session" | "listener";
export declare const PAIR_KIND: {
  readonly SESSION: "session";
  readonly LISTENER: "listener";
};

export interface PairingPayload {
  v: 1 | 2;
  channelId: string;
  pub: string;
  /** Which transport + endpoint the phone should connect with. Laptop-resolved, non-secret. */
  transport: TransportDescriptor;
  /** Absent for normal sessions; "listener" marks a `weft` spawn-capable device. */
  kind?: PairKind;
  /** The laptop's Weft version at pairing time, surfaced on the phone's Settings page. Optional —
   *  older laptops (or QRs minted before this field) omit it. */
  appVersion?: string;
  /** Single-use bearer grant authorizing the first phone enrollment. */
  token?: string;
  /** Epoch milliseconds after which an unclaimed token is rejected. */
  expiresAt?: number;
}

/** Info about a paired peer, as seen by the laptop after a hello. */
export interface PairedPeer {
  publicKeyB64: string;
  deviceId?: string;
  senderName?: string;
  handshakeNonce?: string;
}

export declare function buildPairingPayload(opts: {
  channelId: string;
  publicKeyB64: string;
  transport: TransportDescriptor;
  kind?: PairKind;
  appVersion?: string;
  pairingToken?: string;
  expiresAt?: number;
}): PairingPayload;

export declare function parsePairingPayload(
  input: string | PairingPayload,
): {
  pairVersion: 1 | 2;
  channelId: string;
  publicKeyB64: string;
  kind: PairKind;
  transport: TransportDescriptor;
  appVersion?: string;
  pairingToken?: string;
  expiresAt?: number;
};

export interface PairingGate {
  authorize(input: { publicKeyB64: string; token?: string }): boolean;
  readonly claimedPeerPublicKeyB64: string | null;
}

export declare function createPairingGate(opts?: {
  pairingToken?: string;
  expiresAt?: number;
  trustedPeerPublicKeyB64?: string | null;
  now?: () => number;
}): PairingGate;

export declare function listenForPeers(opts: {
  transport: Transport;
  keyPair: { privateKey: CryptoKey };
  onPeer: (info: { key: CryptoKey; peer: PairedPeer }) => void | Promise<void>;
  connect?: boolean;
  channelId?: string;
  senderId?: string;
  senderName?: string;
  pairingGate?: PairingGate | null;
}): Promise<{ stop: () => void }>;

export declare function waitForPeer(opts: {
  transport: Transport;
  keyPair: { privateKey: CryptoKey };
  timeoutMs?: number;
  connect?: boolean;
  channelId?: string;
  senderId?: string;
  senderName?: string;
  pairingGate?: PairingGate | null;
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
  pairingToken?: string;
  pairVersion?: 1 | 2;
}): Promise<{ key: CryptoKey; protocolVersion: 1 | 2 }>;

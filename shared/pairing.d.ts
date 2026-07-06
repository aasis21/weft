import type { Transport, TransportDescriptor } from "./transport";

export declare const PAIR_VERSION: 1;

/** Pairing payload kinds: a normal mirrored session vs an ephemeral `weft-cli` listener. */
export type PairKind = "session" | "listener";
export declare const PAIR_KIND: {
  readonly SESSION: "session";
  readonly LISTENER: "listener";
};

export interface PairingPayload {
  v: 1;
  channelId: string;
  pub: string;
  /** Which transport + endpoint the phone should connect with. Laptop-resolved, non-secret. */
  transport: TransportDescriptor;
  /** Absent for normal sessions; "listener" marks a `weft-cli` spawn-capable device. */
  kind?: PairKind;
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
  transport: TransportDescriptor;
  kind?: PairKind;
}): PairingPayload;

export declare function parsePairingPayload(
  input: string | PairingPayload,
): { channelId: string; publicKeyB64: string; kind: PairKind; transport: TransportDescriptor };

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

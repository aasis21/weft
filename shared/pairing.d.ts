import type { Transport } from "./transport";

export declare const PAIR_VERSION: 1;

/** Pairing payload kinds: a normal mirrored session vs an ephemeral `helm-cli` listener. */
export type PairKind = "session" | "listener";
export declare const PAIR_KIND: {
  readonly SESSION: "session";
  readonly LISTENER: "listener";
};

export interface PairingPayload {
  v: 1;
  channelId: string;
  pub: string;
  /** Absent for normal sessions; "listener" marks a `helm-cli` spawn-capable device. */
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
  kind?: PairKind;
}): PairingPayload;

export declare function parsePairingPayload(
  input: string | PairingPayload,
): { channelId: string; publicKeyB64: string; kind: PairKind };

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

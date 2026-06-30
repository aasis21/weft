import type { Transport } from "./transport";

export declare const PAIR_VERSION: number;
export declare const PAIR_EVENTS: Readonly<{ HELLO: "pair.hello"; ACK: "pair.ack" }>;

export interface PairingPayload {
  v: number;
  channelId: string;
  pub: string;
}

export declare function buildPairingPayload(opts: {
  channelId: string;
  publicKeyB64: string;
}): PairingPayload;

export declare function parsePairingPayload(
  input: string | PairingPayload,
): { channelId: string; publicKeyB64: string };

export declare function waitForPeer(opts: {
  transport: Transport;
  keyPair: { privateKey: CryptoKey };
  timeoutMs?: number;
  connect?: boolean;
}): Promise<{ key: CryptoKey; peer: { publicKeyB64: string; deviceId?: string } }>;

export declare function sayHello(opts: {
  transport: Transport;
  keyPair: { privateKey: CryptoKey; publicKeyB64: string };
  peerPublicKeyB64: string;
  deviceId?: string;
  waitForAck?: boolean;
  timeoutMs?: number;
}): Promise<{ key: CryptoKey }>;

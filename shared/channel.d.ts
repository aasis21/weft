import type { Transport, Envelope, TransportStatus } from "./transport";
import type { EventEnvelope, EventType } from "./messages";

export interface SecureChannelIdentity {
  channelId?: string;
  sessionId?: string;
  senderId?: string;
  senderName?: string;
}

export declare class SecureChannel {
  constructor(opts: { transport: Transport; key: CryptoKey; identity?: SecureChannelIdentity });
  transport: Transport;
  key: CryptoKey;
  identity: SecureChannelIdentity;
  connect(): Promise<void>;
  send(message: EventEnvelope): Promise<void>;
  onEvent(event: EventType | string, handler: (msg: EventEnvelope) => void): () => void;
  onStatus(handler: (status: TransportStatus, detail?: unknown) => void): () => void;
  close(): Promise<void>;
}

export type { Envelope };

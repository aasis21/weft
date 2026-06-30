import type { Transport, Envelope } from "./transport";
import type { InnerMessage, LogicalEvent } from "./messages";

export interface SecureChannelIdentity {
  userId?: string;
  deviceId?: string;
  sessionId?: string;
}

export declare class SecureChannel {
  constructor(opts: { transport: Transport; key: CryptoKey; identity?: SecureChannelIdentity });
  transport: Transport;
  key: CryptoKey;
  identity: SecureChannelIdentity;
  connect(): Promise<void>;
  send(message: InnerMessage): Promise<void>;
  onEvent(event: LogicalEvent | string, handler: (msg: InnerMessage) => void): () => void;
  close(): Promise<void>;
}

export type { Envelope };

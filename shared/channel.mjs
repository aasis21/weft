// SecureChannel — ties a Transport + an AES-GCM session key + an identity together so callers
// deal only in typed inner messages (messages.mjs). It encrypts on send, decrypts on receive,
// and stamps every outgoing message with { userId, deviceId, sessionId }.

import { encryptJSON, decryptJSON } from "./crypto.mjs";
import { eventForKind } from "./messages.mjs";

export class SecureChannel {
  /**
   * @param {object} opts
   * @param {import("./transport.d.ts").Transport} opts.transport
   * @param {CryptoKey} opts.key - AES-GCM session key from crypto.deriveSessionKey()
   * @param {{ userId?: string, deviceId?: string, sessionId?: string }} [opts.identity]
   */
  constructor({ transport, key, identity = {} }) {
    if (!transport) throw new Error("helm/channel: transport is required");
    if (!key) throw new Error("helm/channel: key is required");
    this.transport = transport;
    this.key = key;
    this.identity = identity;
  }

  async connect() {
    await this.transport.connect();
  }

  /**
   * Encrypt and publish a typed inner message. The logical event is derived from message.kind.
   * @param {import("./messages.d.ts").InnerMessage} message
   */
  async send(message) {
    const tagged = { ...this.identity, ...message };
    const event = eventForKind(message.kind);
    const enc = await encryptJSON(this.key, tagged);
    await this.transport.publish(event, { ...enc, ts: message.ts ?? Date.now() });
  }

  /**
   * Subscribe to a logical event; the handler receives the DECRYPTED inner message.
   * @param {string} event - one of EVENTS.*
   * @param {(msg: import("./messages.d.ts").InnerMessage) => void} handler
   * @returns {() => void} unsubscribe
   */
  onEvent(event, handler) {
    return this.transport.subscribe(event, async (envelope) => {
      try {
        const inner = await decryptJSON(this.key, envelope);
        handler(inner);
      } catch {
        // Drop messages we can't decrypt/parse (wrong key, tampering, malformed).
      }
    });
  }

  async close() {
    await this.transport.close();
  }
}

// SecureChannel — ties a Transport + an AES-GCM session key + an identity together so callers
// deal only in typed event envelopes (messages.mjs). It encrypts on send, decrypts on receive,
// and stamps every outgoing envelope with its identity { channelId, sessionId, senderId, senderName }.

import { encryptJSON, decryptJSON } from "./crypto.mjs";

export class SecureChannel {
  /**
   * @param {object} opts
   * @param {import("./transport.d.ts").Transport} opts.transport
   * @param {CryptoKey} opts.key - AES-GCM session key from crypto.deriveSessionKey()
   * @param {{ channelId?: string, sessionId?: string, senderId?: string, senderName?: string }} [opts.identity]
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
   * Encrypt and publish a typed event envelope. Stamps identity (channelId/sessionId/senderId/
   * senderName) and publishes on the message's own `eventType` (which IS the transport topic).
   * @param {import("./messages.d.ts").EventEnvelope} message
   */
  async send(message) {
    const ts = message.ts ?? Date.now();
    const full = { ...message, ...this.identity, ts };
    const enc = await encryptJSON(this.key, full);
    await this.transport.publish(full.eventType, { ...enc, ts });
  }

  /**
   * Subscribe to a logical event type; the handler receives the DECRYPTED envelope.
   * @param {string} event - one of EVENT_TYPE.*
   * @param {(msg: import("./messages.d.ts").EventEnvelope) => void} handler
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

  /**
   * Observe live connection-state changes (socket drop / rejoin) after connect(). Delegates to
   * the transport; transports that can't detect this return a no-op unsubscribe.
   * @param {(status: import("./transport.d.ts").TransportStatus, detail?: unknown) => void} handler
   * @returns {() => void} unsubscribe
   */
  onStatus(handler) {
    if (typeof this.transport.onStatus !== "function") return () => {};
    return this.transport.onStatus(handler);
  }
}

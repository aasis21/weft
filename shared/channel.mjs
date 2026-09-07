// SecureChannel — ties a Transport + an AES-GCM session key + an identity together so callers
// deal only in typed event envelopes (messages.mjs). It encrypts on send, decrypts on receive,
// and stamps every outgoing envelope with its identity { channelId, sessionId, senderId, senderName }.

import { encryptJSON, decryptJSON, randomChannelId } from "./crypto.mjs";

const SECURE_MESSAGE_VERSION = 2;

export class SecureChannel {
  /**
   * @param {object} opts
   * @param {import("./transport.d.ts").Transport} opts.transport
   * @param {CryptoKey} opts.key - AES-GCM session key from crypto.deriveSessionKey()
   * @param {{ channelId?: string, sessionId?: string, senderId?: string, senderName?: string }} [opts.identity]
   * @param {1 | 2} [opts.protocolVersion]
   */
  constructor({ transport, key, identity = {}, protocolVersion = 2 }) {
    if (!transport) throw new Error("weft/channel: transport is required");
    if (!key) throw new Error("weft/channel: key is required");
    this.transport = transport;
    this.key = key;
    this.identity = identity;
    this.protocolVersion = protocolVersion;
    this.sendStreamId = randomChannelId();
    this.sendSequence = 0;
    this.receiveSequence = 0;
    this.receiveStreamId = null;
    this.retiredReceiveStreams = new Set();
    this.sendChain = Promise.resolve();
    this.receiveChain = Promise.resolve();
    this.eventSubscriptions = new Map();
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
    const operation = this.sendChain.then(async () => {
      const ts = message.ts ?? Date.now();
      const full = { ...message, ...this.identity, ts };
      if (this.protocolVersion === 1) {
        const enc = await encryptJSON(this.key, full);
        await this.transport.publish(full.eventType, { ...enc, ts });
        return;
      }
      if (this.sendSequence >= Number.MAX_SAFE_INTEGER) {
        throw new Error("weft/channel: send sequence exhausted");
      }
      const sequence = this.sendSequence + 1;
      // Reserve before publishing. A timeout is ambiguous: the relay may have delivered the
      // ciphertext even though the acknowledgement was lost, so this sequence must never be reused.
      this.sendSequence = sequence;
      const enc = await encryptJSON(this.key, {
        v: SECURE_MESSAGE_VERSION,
        streamId: this.sendStreamId,
        sequence,
        message: full,
      });
      await this.transport.publish(full.eventType, { ...enc, ts });
    });
    this.sendChain = operation.catch(() => {});
    return operation;
  }

  /**
   * Subscribe to a logical event type; the handler receives the DECRYPTED envelope.
   * @param {string} event - one of EVENT_TYPE.*
   * @param {(msg: import("./messages.d.ts").EventEnvelope) => void} handler
   * @returns {() => void} unsubscribe
   */
  onEvent(event, handler) {
    let subscription = this.eventSubscriptions.get(event);
    if (!subscription) {
      const handlers = new Set();
      const unsubscribe = this.transport.subscribe(event, (envelope) => {
        const operation = this.receiveChain.then(async () => {
          const sealed = await decryptJSON(this.key, envelope);
          if (this.protocolVersion === 1) {
            if (sealed?.eventType !== event) return;
            for (const registeredHandler of [...handlers]) {
              try {
                await registeredHandler(sealed);
              } catch {
                // One consumer must not prevent other subscribers from receiving an accepted message.
              }
            }
            return;
          }
          if (
            !sealed ||
            typeof sealed !== "object" ||
            sealed.v !== SECURE_MESSAGE_VERSION ||
            typeof sealed.streamId !== "string" ||
            sealed.streamId.length === 0 ||
            !Number.isSafeInteger(sealed.sequence) ||
            sealed.sequence < 1 ||
            !sealed.message ||
            typeof sealed.message !== "object" ||
            sealed.message.eventType !== event
          ) {
            return;
          }

          if (this.retiredReceiveStreams.has(sealed.streamId)) return;
          if (this.receiveStreamId === null) {
            this.receiveStreamId = sealed.streamId;
          } else if (sealed.streamId !== this.receiveStreamId) {
            // Reconnects use a fresh challenge-derived key and create a fresh SecureChannel. Only
            // sequence 1 may start that new stream, and the prior stream cannot become active again.
            if (sealed.sequence !== 1) return;
            this.retiredReceiveStreams.add(this.receiveStreamId);
            this.receiveStreamId = sealed.streamId;
            this.receiveSequence = 0;
          }
          if (sealed.sequence <= this.receiveSequence) return;
          this.receiveSequence = sealed.sequence;
          for (const registeredHandler of [...handlers]) {
            try {
              await registeredHandler(sealed.message);
            } catch {
              // One consumer must not prevent other subscribers from receiving an accepted message.
            }
          }
        });
        this.receiveChain = operation.catch(() => {
          // Drop messages we can't decrypt/parse, replayed messages, and out-of-order messages.
        });
        return this.receiveChain;
      });
      subscription = { handlers, unsubscribe };
      this.eventSubscriptions.set(event, subscription);
    }
    subscription.handlers.add(handler);
    return () => {
      const current = this.eventSubscriptions.get(event);
      if (!current) return;
      current.handlers.delete(handler);
      if (current.handlers.size === 0) {
        current.unsubscribe?.();
        this.eventSubscriptions.delete(event);
      }
    };
  }

  async close() {
    for (const { unsubscribe } of this.eventSubscriptions.values()) unsubscribe?.();
    this.eventSubscriptions.clear();
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

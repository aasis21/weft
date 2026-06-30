// Helm pairing handshake.
//
// ECDH needs BOTH public keys. The laptop (extension) shows ITS public key + channelId in the
// QR code. The phone scans it, then must deliver ITS OWN public key back to the laptop so both
// sides derive the same AES-256-GCM session key. That single exchange is the ONLY unencrypted
// traffic on the channel, and it only ever carries PUBLIC keys (safe to send in the clear).
// Everything after pairing flows through SecureChannel (fully encrypted).
//
// ORDERING NOTE (real Supabase Broadcast transport): handlers are registered with channel.on()
// inside transport.subscribe(), and channel.subscribe() runs in transport.connect(). Supabase
// delivers only to handlers registered BEFORE connect(). These helpers therefore register their
// handler, THEN connect. The in-process LocalTransport has no such constraint. See docs/pairing.md.

import { deriveSessionKey } from "./crypto.mjs";

export const PAIR_VERSION = 1;

/** Reserved transport events used only for the pre-encryption handshake. */
export const PAIR_EVENTS = Object.freeze({
  HELLO: "pair.hello", // phone  -> laptop: { v, pub, deviceId, ts }
  ACK: "pair.ack", // laptop -> phone:  { v, ok, ts }
});

/** Build the QR payload shown by the laptop. Carries the laptop PUBLIC key only. */
export function buildPairingPayload({ channelId, publicKeyB64 }) {
  if (!channelId || !publicKeyB64) {
    throw new Error("helm/pairing: channelId and publicKeyB64 are required");
  }
  return { v: PAIR_VERSION, channelId, pub: publicKeyB64 };
}

/** Parse + validate a scanned QR payload (string or object). */
export function parsePairingPayload(input) {
  const o = typeof input === "string" ? JSON.parse(input) : input;
  if (
    !o ||
    o.v !== PAIR_VERSION ||
    typeof o.channelId !== "string" ||
    typeof o.pub !== "string"
  ) {
    throw new Error("helm/pairing: invalid pairing payload");
  }
  return { channelId: o.channelId, publicKeyB64: o.pub };
}

/**
 * Laptop/extension side: wait for the phone's hello, derive the shared session key.
 * @param {{ transport: import("./transport").Transport, keyPair: { privateKey: CryptoKey }, timeoutMs?: number, connect?: boolean }} opts
 * @returns {Promise<{ key: CryptoKey, peer: { publicKeyB64: string, deviceId?: string } }>}
 */
export async function waitForPeer({ transport, keyPair, timeoutMs = 0, connect = true } = {}) {
  if (!transport) throw new Error("helm/pairing: transport is required");
  if (!keyPair?.privateKey) throw new Error("helm/pairing: keyPair is required");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;

    const finish = (fn, arg) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      unsub?.();
      fn(arg);
    };

    const unsub = transport.subscribe(PAIR_EVENTS.HELLO, async (payload) => {
      if (settled || !payload || typeof payload.pub !== "string") return;
      try {
        const key = await deriveSessionKey(keyPair.privateKey, payload.pub);
        // Best-effort ACK so the phone can confirm the laptop derived the key.
        try {
          await transport.publish(PAIR_EVENTS.ACK, { v: PAIR_VERSION, ok: true, ts: Date.now() });
        } catch {
          /* ack is optional */
        }
        finish(resolve, { key, peer: { publicKeyB64: payload.pub, deviceId: payload.deviceId } });
      } catch (err) {
        finish(reject, err);
      }
    });

    if (connect) {
      Promise.resolve(transport.connect?.()).catch((err) => finish(reject, err));
    }
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => finish(reject, new Error("helm/pairing: timed out waiting for phone")),
        timeoutMs,
      );
      timer.unref?.();
    }
  });
}

/**
 * Phone side: derive the key from the scanned laptop public key, then announce our public key.
 * @param {{ transport: import("./transport").Transport, keyPair: { privateKey: CryptoKey, publicKeyB64: string }, peerPublicKeyB64: string, deviceId?: string, waitForAck?: boolean, timeoutMs?: number }} opts
 * @returns {Promise<{ key: CryptoKey }>}
 */
export async function sayHello({
  transport,
  keyPair,
  peerPublicKeyB64,
  deviceId,
  waitForAck = false,
  timeoutMs = 10_000,
} = {}) {
  if (!transport) throw new Error("helm/pairing: transport is required");
  if (!keyPair?.privateKey || !keyPair.publicKeyB64) {
    throw new Error("helm/pairing: keyPair is required");
  }
  if (!peerPublicKeyB64) throw new Error("helm/pairing: peerPublicKeyB64 is required");

  const key = await deriveSessionKey(keyPair.privateKey, peerPublicKeyB64);

  let ackPromise = Promise.resolve();
  if (waitForAck) {
    ackPromise = new Promise((resolve, reject) => {
      const unsub = transport.subscribe(PAIR_EVENTS.ACK, () => {
        unsub?.();
        resolve();
      });
      const t = setTimeout(() => {
        unsub?.();
        reject(new Error("helm/pairing: no ack from laptop"));
      }, timeoutMs);
      t.unref?.();
    });
  }

  await transport.connect?.();
  await transport.publish(PAIR_EVENTS.HELLO, {
    v: PAIR_VERSION,
    pub: keyPair.publicKeyB64,
    deviceId,
    ts: Date.now(),
  });
  if (waitForAck) await ackPromise;
  return { key };
}

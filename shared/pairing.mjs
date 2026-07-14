// Weft pairing handshake.
//
// ECDH needs BOTH public keys. The laptop (extension) shows ITS public key + channelId in the
// QR code. The phone scans it, then must deliver ITS OWN public key back to the laptop so both
// sides derive the same AES-256-GCM session key. That single exchange is the ONLY unencrypted
// traffic on the channel, and it only ever carries PUBLIC keys (safe to send in the clear).
// Everything after pairing flows through SecureChannel (fully encrypted).
//
// STANDARDIZED SHAPE: even though pairing is pre-key (plaintext), its two messages use the same
// event-envelope shape as everything else — eventType "pair", eventSubtype "hello" | "ack", with
// the public key in `msg` and the sender in `senderId`/`senderName`. Both travel on the single
// "pair" transport topic (== eventType) and are told apart by `eventSubtype`. Broadcast is
// self:false on both transports, and each side additionally filters by subtype, so a laptop never
// mistakes its own ack for a hello (or vice-versa).
//
// ORDERING NOTE (real Supabase Broadcast transport): handlers are registered with channel.on()
// inside transport.subscribe(), and channel.subscribe() runs in transport.connect(). Supabase
// delivers only to handlers registered BEFORE connect(). These helpers therefore register their
// handler, THEN connect. The in-process LocalTransport has no such constraint. See docs/pairing.md.

import { deriveSessionKey } from "./crypto.mjs";
import { EVENT_TYPE, SUBTYPE } from "./messages.mjs";

export const PAIR_VERSION = 1;

/** Pairing payload kinds: a normal mirrored-session QR vs an ephemeral `weft` listener QR. */
export const PAIR_KIND = Object.freeze({ SESSION: "session", LISTENER: "listener" });

/**
 * Validate a transport descriptor's shape for the QR/pairing payload. See transport.d.ts
 * TransportDescriptor. Rejects anything with an unknown `kind` or missing required fields for
 * that kind — the phone must be able to build a matching transport from this alone.
 */
function isValidTransportDescriptor(t) {
  if (!t || typeof t !== "object") return false;
  if (t.kind === "local") return true;
  if (t.kind === "supabase") return typeof t.url === "string" && typeof t.anonKey === "string";
  if (t.kind === "devtunnel") return typeof t.url === "string";
  return false;
}

/** Build a standardized plaintext pairing envelope (hello or ack). */
function pairEnvelope(eventSubtype, msg, { channelId, senderId, senderName } = {}) {
  return {
    eventType: EVENT_TYPE.PAIR,
    eventSubtype,
    channelId,
    senderId,
    senderName,
    msg,
    ts: Date.now(),
  };
}

/**
 * Build the QR payload shown by the laptop. Carries the laptop PUBLIC key AND the transport
 * descriptor (kind + non-secret endpoint) the laptop resolved from its own env — the laptop is
 * the single source of truth for transport selection; the phone builds its transport straight
 * from this, with no pre-baked config of its own. `kind` marks whether this is a normal mirrored
 * session ("session", default) or a `weft` listener ("listener") the phone should register as
 * a spawn-capable device rather than open as a session.
 */
export function buildPairingPayload({ channelId, publicKeyB64, transport, kind = PAIR_KIND.SESSION }) {
  if (!channelId || !publicKeyB64) {
    throw new Error("weft/pairing: channelId and publicKeyB64 are required");
  }
  if (!isValidTransportDescriptor(transport)) {
    throw new Error(
      'weft/pairing: transport descriptor is required (kind: "local" | "supabase" | "devtunnel")',
    );
  }
  const payload = { v: PAIR_VERSION, channelId, pub: publicKeyB64, transport };
  // Only stamp non-default kinds so existing session QRs stay byte-identical (back-compat).
  if (kind && kind !== PAIR_KIND.SESSION) payload.kind = kind;
  return payload;
}

/** Parse + validate a scanned QR payload (string or object). `kind` defaults to "session". */
export function parsePairingPayload(input) {
  const o = typeof input === "string" ? JSON.parse(input) : input;
  if (
    !o ||
    o.v !== PAIR_VERSION ||
    typeof o.channelId !== "string" ||
    typeof o.pub !== "string" ||
    !isValidTransportDescriptor(o.transport)
  ) {
    throw new Error("weft/pairing: invalid pairing payload");
  }
  const kind = o.kind === PAIR_KIND.LISTENER ? PAIR_KIND.LISTENER : PAIR_KIND.SESSION;
  return { channelId: o.channelId, publicKeyB64: o.pub, kind, transport: o.transport };
}

/** Read a hello envelope's public key + sender, tolerating a missing/foreign message. */
function readHello(payload) {
  if (!payload || payload.eventSubtype !== SUBTYPE.PAIR.HELLO) return null;
  const pub = payload.msg?.pub;
  if (typeof pub !== "string") return null;
  return { pub, deviceId: payload.senderId, senderName: payload.senderName };
}

/**
 * Laptop/extension side, PERSISTENT variant: keep listening for phone hellos and ACK EVERY one,
 * deriving a fresh session key per hello. Unlike `waitForPeer` (single-shot), this never stops
 * after the first pair, so a phone that re-scans, reloads, or reconnects always gets an ACK and
 * can re-pair. `onPeer` is invoked once per hello with the derived key + peer info; the laptop
 * uses it to (re)attach its encrypted relay. The ACK is sent BEFORE `onPeer` runs so the phone
 * confirms fast even if relay (re)attach is slow. `stop()` only unsubscribes — it does NOT close
 * the transport (the caller owns the transport lifecycle).
 *
 * @param {{ transport: import("./transport").Transport, keyPair: { privateKey: CryptoKey }, onPeer: (info: { key: CryptoKey, peer: { publicKeyB64: string, deviceId?: string, senderName?: string } }) => void | Promise<void>, onAck?: (result: { ok: boolean, error?: unknown, peer: { publicKeyB64: string, deviceId?: string, senderName?: string } }) => void, connect?: boolean, channelId?: string, senderId?: string, senderName?: string }} opts
 * @returns {Promise<{ stop: () => void }>}
 */
export async function listenForPeers({
  transport,
  keyPair,
  onPeer,
  onAck,
  connect = true,
  channelId,
  senderId = "copilot",
  senderName = "Copilot",
} = {}) {
  if (!transport) throw new Error("weft/pairing: transport is required");
  if (!keyPair?.privateKey) throw new Error("weft/pairing: keyPair is required");
  if (typeof onPeer !== "function") throw new Error("weft/pairing: onPeer is required");

  const unsub = transport.subscribe(EVENT_TYPE.PAIR, async (payload) => {
    const hello = readHello(payload);
    if (!hello) return;
    let key;
    try {
      key = await deriveSessionKey(keyPair.privateKey, hello.pub);
    } catch {
      return; // malformed/incompatible public key — ignore.
    }
    const peer = { publicKeyB64: hello.pub, deviceId: hello.deviceId, senderName: hello.senderName };
    // ACK first: the phone re-broadcasts HELLO until it hears this, so answer every hello fast.
    try {
      await transport.publish(
        EVENT_TYPE.PAIR,
        pairEnvelope(SUBTYPE.PAIR.ACK, { v: PAIR_VERSION, ok: true }, { channelId, senderId, senderName }),
      );
      onAck?.({ ok: true, peer });
    } catch (error) {
      onAck?.({ ok: false, error, peer });
    }
    try {
      await onPeer({ key, peer });
    } catch {
      /* the caller is responsible for surfacing its own (re)attach failures */
    }
  });

  if (connect) await transport.connect?.();
  return { stop: () => unsub?.() };
}

/**
 * Laptop/extension side: wait for the phone's hello, derive the shared session key.
 * @param {{ transport: import("./transport").Transport, keyPair: { privateKey: CryptoKey }, timeoutMs?: number, connect?: boolean, channelId?: string, senderId?: string, senderName?: string }} opts
 * @returns {Promise<{ key: CryptoKey, peer: { publicKeyB64: string, deviceId?: string, senderName?: string } }>}
 */
export async function waitForPeer({
  transport,
  keyPair,
  timeoutMs = 0,
  connect = true,
  channelId,
  senderId = "copilot",
  senderName = "Copilot",
} = {}) {
  if (!transport) throw new Error("weft/pairing: transport is required");
  if (!keyPair?.privateKey) throw new Error("weft/pairing: keyPair is required");

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

    const unsub = transport.subscribe(EVENT_TYPE.PAIR, async (payload) => {
      if (settled) return;
      const hello = readHello(payload);
      if (!hello) return;
      try {
        const key = await deriveSessionKey(keyPair.privateKey, hello.pub);
        // Best-effort ACK so the phone can confirm the laptop derived the key.
        try {
          await transport.publish(
            EVENT_TYPE.PAIR,
            pairEnvelope(SUBTYPE.PAIR.ACK, { v: PAIR_VERSION, ok: true }, { channelId, senderId, senderName }),
          );
        } catch {
          /* ack is optional */
        }
        finish(resolve, {
          key,
          peer: { publicKeyB64: hello.pub, deviceId: hello.deviceId, senderName: hello.senderName },
        });
      } catch (err) {
        finish(reject, err);
      }
    });

    if (connect) {
      Promise.resolve(transport.connect?.()).catch((err) => finish(reject, err));
    }
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => finish(reject, new Error("weft/pairing: timed out waiting for phone")),
        timeoutMs,
      );
      timer.unref?.();
    }
  });
}

/**
 * Phone side: derive the key from the scanned laptop public key, then announce our public key.
 *
 * When `waitForAck` is true we RE-BROADCAST the hello on an interval until the laptop ACKs (or we
 * hit `timeoutMs`). Supabase Broadcast has no replay, so a single hello is lost if the laptop's
 * channel finishes subscribing a moment after we publish. Re-announcing makes the handshake
 * self-healing — the laptop's persistent `listenForPeers` answers each hello and the phone resolves
 * on the first ACK.
 *
 * `deviceId` is the phone's stable id (stamped as `senderId`); `senderName` is its display label
 * ("App" | "WebApp"). Both ride the standardized hello envelope.
 *
 * @param {{ transport: import("./transport").Transport, keyPair: { privateKey: CryptoKey, publicKeyB64: string }, peerPublicKeyB64: string, deviceId?: string, senderName?: string, channelId?: string, waitForAck?: boolean, timeoutMs?: number, retryMs?: number }} opts
 * @returns {Promise<{ key: CryptoKey }>}
 */
export async function sayHello({
  transport,
  keyPair,
  peerPublicKeyB64,
  deviceId,
  senderName,
  channelId,
  waitForAck = false,
  timeoutMs = 20_000,
  retryMs = 1_200,
} = {}) {
  if (!transport) throw new Error("weft/pairing: transport is required");
  if (!keyPair?.privateKey || !keyPair.publicKeyB64) {
    throw new Error("weft/pairing: keyPair is required");
  }
  if (!peerPublicKeyB64) throw new Error("weft/pairing: peerPublicKeyB64 is required");

  const key = await deriveSessionKey(keyPair.privateKey, peerPublicKeyB64);
  const buildHello = () =>
    pairEnvelope(
      SUBTYPE.PAIR.HELLO,
      { v: PAIR_VERSION, pub: keyPair.publicKeyB64 },
      { channelId, senderId: deviceId, senderName },
    );
  const isAck = (payload) => payload && payload.eventSubtype === SUBTYPE.PAIR.ACK;

  // Fire-and-forget path (e.g. restoring a saved pairing): publish once, don't block on an ack.
  if (!waitForAck) {
    await transport.connect?.();
    await transport.publish(EVENT_TYPE.PAIR, buildHello());
    return { key };
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let interval;
    let timer;
    let unsub;

    const cleanup = () => {
      if (interval) clearInterval(interval);
      if (timer) clearTimeout(timer);
      unsub?.();
    };

    // Register the ACK listener BEFORE connecting so no ack can race ahead of us.
    unsub = transport.subscribe(EVENT_TYPE.PAIR, (payload) => {
      if (settled || !isAck(payload)) return;
      settled = true;
      cleanup();
      resolve({ key });
    });

    const announce = () => {
      Promise.resolve(transport.publish(EVENT_TYPE.PAIR, buildHello())).catch(() => {
        // Ignore transient publish failures; the interval will try again.
      });
    };

    timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error("weft/pairing: no ack from laptop"));
    }, timeoutMs);
    timer.unref?.();

    Promise.resolve(transport.connect?.())
      .then(() => {
        if (settled) return;
        announce();
        interval = setInterval(announce, retryMs);
        interval.unref?.();
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(err);
      });
  });
}

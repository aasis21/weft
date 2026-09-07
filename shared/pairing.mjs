// Weft pairing handshake.
//
// ECDH needs BOTH public keys. The laptop (extension) shows ITS public key + channelId in the
// QR code together with a short-lived bearer grant. The phone scans it, then sends ITS OWN public
// key and a fresh nonce. The laptop answers with a fresh challenge; the phone proves possession of
// its private key (and, for first enrollment, the bearer grant) in an encrypted response. Both sides
// then derive a challenge-scoped AES-256-GCM key and exchange an encrypted acknowledgement. A
// captured hello therefore cannot restore an old key. Everything after pairing flows through
// SecureChannel (fully encrypted).
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

import {
  decryptJSON,
  deriveSessionKey,
  encryptJSON,
  randomPairingToken,
} from "./crypto.mjs";
import { EVENT_TYPE, SUBTYPE } from "./messages.mjs";

export const PAIR_VERSION = 2;
const LEGACY_PAIR_VERSION = 1;
export const PAIRING_TTL_MS = 10 * 60 * 1000;
const PAIR_ACK_RETRY_GRACE_MS = 3_000;

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
 * Build the QR payload shown by the laptop. Carries the laptop public key, transport descriptor,
 * and a short-lived single-use bearer grant. The laptop is the single source of truth for
 * transport selection; the phone builds its transport straight from this, with no pre-baked
 * config of its own. `kind` marks whether this is a normal mirrored session ("session", default)
 * or a `weft` listener ("listener") the phone should register as a spawn-capable device.
 */
export function buildPairingPayload({
  channelId,
  publicKeyB64,
  transport,
  kind = PAIR_KIND.SESSION,
  appVersion,
  pairingToken = randomPairingToken(),
  expiresAt = Date.now() + PAIRING_TTL_MS,
}) {
  if (!channelId || !publicKeyB64) {
    throw new Error("weft/pairing: channelId and publicKeyB64 are required");
  }
  if (!isValidTransportDescriptor(transport)) {
    throw new Error(
      'weft/pairing: transport descriptor is required (kind: "local" | "supabase" | "devtunnel")',
    );
  }
  if (typeof pairingToken !== "string" || pairingToken.length < 32) {
    throw new Error("weft/pairing: pairingToken must be an unguessable bearer token");
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new Error("weft/pairing: expiresAt must be an epoch-millisecond timestamp");
  }
  const payload = {
    v: PAIR_VERSION,
    channelId,
    pub: publicKeyB64,
    transport,
    token: pairingToken,
    expiresAt,
  };
  // Only stamp non-default kinds so existing session QRs stay byte-identical (back-compat).
  if (kind && kind !== PAIR_KIND.SESSION) payload.kind = kind;
  // The laptop's Weft version, so the phone can show which extension build it's paired with.
  // Optional + only stamped when known — older laptops omit it and the phone just shows "unknown".
  if (typeof appVersion === "string" && appVersion) payload.appVersion = appVersion;
  return payload;
}

/** Parse + validate a scanned QR payload (string or object). `kind` defaults to "session". */
export function parsePairingPayload(input) {
  const o = typeof input === "string" ? JSON.parse(input) : input;
  if (
    !o ||
    (o.v !== PAIR_VERSION && o.v !== LEGACY_PAIR_VERSION) ||
    typeof o.channelId !== "string" ||
    typeof o.pub !== "string" ||
    !isValidTransportDescriptor(o.transport)
  ) {
    throw new Error("weft/pairing: invalid pairing payload");
  }
  const kind = o.kind === PAIR_KIND.LISTENER ? PAIR_KIND.LISTENER : PAIR_KIND.SESSION;
  const appVersion = typeof o.appVersion === "string" && o.appVersion ? o.appVersion : undefined;
  const pairingToken = typeof o.token === "string" && o.token.length >= 32 ? o.token : undefined;
  const expiresAt = Number.isSafeInteger(o.expiresAt) && o.expiresAt > 0 ? o.expiresAt : undefined;
  if ((pairingToken && !expiresAt) || (!pairingToken && expiresAt)) {
    throw new Error("weft/pairing: invalid pairing payload");
  }
  return {
    pairVersion: o.v,
    channelId: o.channelId,
    publicKeyB64: o.pub,
    kind,
    transport: o.transport,
    appVersion,
    pairingToken,
    expiresAt,
  };
}

/** Read a hello envelope's public key + sender, tolerating a missing/foreign message. */
function readHello(payload, channelId) {
  if (!payload || payload.eventSubtype !== SUBTYPE.PAIR.HELLO) return null;
  if (channelId && payload.channelId !== channelId) return null;
  const pub = payload.msg?.pub;
  if (typeof pub !== "string") return null;
  const version = payload.msg?.v;
  if (version !== PAIR_VERSION && version !== LEGACY_PAIR_VERSION) return null;
  const nonce = payload.msg?.nonce;
  if (nonce !== undefined && (typeof nonce !== "string" || nonce.length < 16)) return null;
  return {
    version,
    pub,
    nonce,
    supportsV2: payload.msg?.supportsV2 === true,
    auth: payload.msg?.auth,
    channelId: payload.channelId,
    deviceId: payload.senderId,
    senderName: payload.senderName,
  };
}

async function readPairingProof(key, sealedProof, { nonce, challenge }) {
  if (!nonce || !challenge || !sealedProof) return null;
  const proof = await decryptJSON(key, sealedProof);
  if (
    !proof ||
    typeof proof !== "object" ||
    proof.v !== PAIR_VERSION ||
    proof.nonce !== nonce ||
    proof.challenge !== challenge ||
    (proof.token !== undefined && typeof proof.token !== "string")
  ) {
    return null;
  }
  return proof;
}

/**
 * A pairing QR is a bearer credential. This gate gives that credential an expiry and an atomic
 * first-valid-peer claim while still allowing the already-bound persistent peer to reconnect.
 */
export function createPairingGate({
  pairingToken,
  expiresAt,
  trustedPeerPublicKeyB64 = null,
  now = () => Date.now(),
} = {}) {
  let claimedPeerPublicKeyB64 = trustedPeerPublicKeyB64 || null;
  return {
    authorize({ publicKeyB64, token }) {
      if (claimedPeerPublicKeyB64) return publicKeyB64 === claimedPeerPublicKeyB64;
      if (
        typeof pairingToken !== "string" ||
        typeof expiresAt !== "number" ||
        now() >= expiresAt ||
        token !== pairingToken
      ) {
        return false;
      }
      claimedPeerPublicKeyB64 = publicKeyB64;
      return true;
    },
    get claimedPeerPublicKeyB64() {
      return claimedPeerPublicKeyB64;
    },
  };
}

function pairingContext(nonce, challenge) {
  if (!nonce) return "";
  return challenge ? `pair:${nonce}:${challenge}` : `pair:${nonce}`;
}

async function publishAck({ transport, key, nonce, challenge, channelId, senderId, senderName }) {
  const ack = pairEnvelope(
    SUBTYPE.PAIR.ACK,
    { v: nonce ? PAIR_VERSION : LEGACY_PAIR_VERSION, ok: true, ...(nonce ? { nonce, challenge } : {}) },
    { channelId, senderId, senderName },
  );
  await transport.publish(
    EVENT_TYPE.PAIR,
    nonce ? await encryptJSON(key, ack) : ack,
  );
}

/**
 * Laptop/extension side, persistent variant: keep listening for phone hellos. With a pairing gate,
 * the first valid key claims the short-lived QR grant and only that key may reconnect afterward.
 * `onPeer` is invoked for each authorized hello with the derived key + peer info; the laptop uses
 * it to (re)attach its encrypted relay. The ACK is sent BEFORE `onPeer` runs so the phone confirms
 * fast even if relay (re)attach is slow. `stop()` only unsubscribes — it does not close the
 * transport (the caller owns the transport lifecycle).
 *
 * @param {{ transport: import("./transport").Transport, keyPair: { privateKey: CryptoKey }, onPeer: (info: { key: CryptoKey, peer: { publicKeyB64: string, deviceId?: string, senderName?: string } }) => void | Promise<void>, onAck?: (result: { ok: boolean, error?: unknown, peer: { publicKeyB64: string, deviceId?: string, senderName?: string } }) => void, connect?: boolean, channelId?: string, senderId?: string, senderName?: string }} opts
 * @returns {Promise<{ stop: () => void }>}
 */
export async function listenForPeers({
  transport,
  keyPair,
  onPeer,
  onAck,
  pairingGate = null,
  connect = true,
  channelId,
  senderId = "copilot",
  senderName = "Copilot",
} = {}) {
  if (!transport) throw new Error("weft/pairing: transport is required");
  if (!keyPair?.privateKey) throw new Error("weft/pairing: keyPair is required");
  if (typeof onPeer !== "function") throw new Error("weft/pairing: onPeer is required");

  const pending = new Map();
  let processing = Promise.resolve();
  const unsub = transport.subscribe(EVENT_TYPE.PAIR, (payload) => {
    processing = processing.then(async () => {
      const hello = readHello(payload, channelId);
      if (hello) {
        // Version 2 deliberately requires a laptop-generated challenge. Version-1 phones cannot
        // safely reconnect to a version-2 laptop because their captured hello is replayable.
        if (
          !hello.nonce ||
          (hello.version !== PAIR_VERSION && !hello.supportsV2)
        ) return;
        const id = `${hello.pub}:${hello.nonce}`;
        let entry = pending.get(id);
        if (!entry) {
          let provisionalKey;
          try {
            provisionalKey = await deriveSessionKey(
              keyPair.privateKey,
              hello.pub,
              hello.version === PAIR_VERSION ? pairingContext(hello.nonce) : "",
            );
          } catch {
            return;
          }
          entry = {
            hello,
            provisionalKey,
            challenge: randomPairingToken(),
            accepted: null,
          };
          pending.set(id, entry);
          if (pending.size > 32) pending.delete(pending.keys().next().value);
        }
        await transport.publish(
          EVENT_TYPE.PAIR,
          pairEnvelope(
            SUBTYPE.PAIR.CHALLENGE,
            {
              v: PAIR_VERSION,
              pub: hello.pub,
              nonce: hello.nonce,
              challenge: entry.challenge,
            },
            { channelId: channelId ?? hello.channelId, senderId, senderName },
          ),
        );
        return;
      }

      if (payload?.eventSubtype !== SUBTYPE.PAIR.PROOF || payload.channelId !== channelId) return;
      const pub = payload.msg?.pub;
      const nonce = payload.msg?.nonce;
      const id = typeof pub === "string" && typeof nonce === "string" ? `${pub}:${nonce}` : null;
      const entry = id ? pending.get(id) : null;
      if (!entry || payload.msg?.v !== PAIR_VERSION) return;
      const proof = await readPairingProof(entry.provisionalKey, payload.msg?.proof, {
        nonce,
        challenge: entry.challenge,
      }).catch(() => null);
      if (!proof) return;
      if (pairingGate && !pairingGate.authorize({ publicKeyB64: pub, token: proof.token })) return;
      const key =
        entry.accepted?.key ??
        await deriveSessionKey(keyPair.privateKey, pub, pairingContext(nonce, entry.challenge));
      const peer =
        entry.accepted?.peer ?? {
          publicKeyB64: pub,
          deviceId: entry.hello.deviceId,
          senderName: entry.hello.senderName,
          handshakeNonce: nonce,
        };
      try {
        await publishAck({
          transport,
          key,
          nonce,
          challenge: entry.challenge,
          channelId: channelId ?? entry.hello.channelId,
          senderId,
          senderName,
        });
        onAck?.({ ok: true, peer });
      } catch (error) {
        onAck?.({ ok: false, error, peer });
        return;
      }
      if (entry.accepted) return;
      entry.accepted = { key, peer };
      try {
        await onPeer({ key, peer });
      } catch {
        /* the caller is responsible for surfacing its own (re)attach failures */
      }
    }).catch(() => {});
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
  pairingGate = null,
} = {}) {
  if (!transport) throw new Error("weft/pairing: transport is required");
  if (!keyPair?.privateKey) throw new Error("weft/pairing: keyPair is required");

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    let handle = null;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      handle?.stop();
      reject(error);
    };
    void listenForPeers({
      transport,
      keyPair,
      connect,
      channelId,
      senderId,
      senderName,
      pairingGate,
      onPeer: (result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        resolve(result);
        // Keep answering retries briefly in case the first encrypted ACK was delivered
        // ambiguously; duplicate proofs are re-ACKed without invoking onPeer again.
        const retryTimer = setTimeout(() => handle?.stop(), PAIR_ACK_RETRY_GRACE_MS);
        retryTimer.unref?.();
      },
    }).then((started) => {
      handle = started;
      if (settled) {
        const retryTimer = setTimeout(() => handle?.stop(), PAIR_ACK_RETRY_GRACE_MS);
        retryTimer.unref?.();
      }
    }).catch(fail);
    if (timeoutMs > 0) {
      timer = setTimeout(
        () => fail(new Error("weft/pairing: timed out waiting for phone")),
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
  pairingToken,
  pairVersion = PAIR_VERSION,
} = {}) {
  if (!transport) throw new Error("weft/pairing: transport is required");
  if (!keyPair?.privateKey || !keyPair.publicKeyB64) {
    throw new Error("weft/pairing: keyPair is required");
  }
  if (!peerPublicKeyB64) throw new Error("weft/pairing: peerPublicKeyB64 is required");

  if (pairVersion !== PAIR_VERSION && pairVersion !== LEGACY_PAIR_VERSION) {
    throw new Error(`weft/pairing: unsupported pairing version ${pairVersion}`);
  }
  const nonce = randomPairingToken();
  const provisionalKey = await deriveSessionKey(
    keyPair.privateKey,
    peerPublicKeyB64,
    pairVersion === PAIR_VERSION ? pairingContext(nonce) : "",
  );
  const buildHello = () =>
    pairEnvelope(
      SUBTYPE.PAIR.HELLO,
      {
        v: pairVersion,
        pub: keyPair.publicKeyB64,
        nonce,
        ...(pairVersion === LEGACY_PAIR_VERSION ? { supportsV2: true } : {}),
      },
      { channelId, senderId: deviceId, senderName },
    );

  // Legacy version-1 laptops use a single plaintext hello/ack and a context-free key.
  if (pairVersion === LEGACY_PAIR_VERSION && !waitForAck) {
    await transport.connect?.();
    await transport.publish(EVENT_TYPE.PAIR, buildHello());
    return { key: provisionalKey };
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let interval;
    let timer;
    let unsub;
    let activeChallenge = null;
    let sessionKey = pairVersion === LEGACY_PAIR_VERSION ? provisionalKey : null;
    let protocolVersion = pairVersion;

    const cleanup = () => {
      if (interval) clearInterval(interval);
      if (timer) clearTimeout(timer);
      unsub?.();
    };

    // Register the ACK listener BEFORE connecting so no ack can race ahead of us.
    unsub = transport.subscribe(EVENT_TYPE.PAIR, (payload) => {
      if (settled) return;
      void (async () => {
        if (payload?.eventSubtype === SUBTYPE.PAIR.CHALLENGE) {
          if (
            payload.channelId !== channelId ||
            payload.msg?.v !== PAIR_VERSION ||
            payload.msg?.pub !== keyPair.publicKeyB64 ||
            payload.msg?.nonce !== nonce ||
            typeof payload.msg?.challenge !== "string" ||
            payload.msg.challenge.length < 16
          ) return;
          if (activeChallenge && activeChallenge !== payload.msg.challenge) return;
          activeChallenge = payload.msg.challenge;
          protocolVersion = PAIR_VERSION;
          sessionKey = await deriveSessionKey(
            keyPair.privateKey,
            peerPublicKeyB64,
            pairingContext(nonce, activeChallenge),
          );
          const proof = await encryptJSON(provisionalKey, {
            v: PAIR_VERSION,
            nonce,
            challenge: activeChallenge,
            ...(pairingToken ? { token: pairingToken } : {}),
          });
          await transport.publish(
            EVENT_TYPE.PAIR,
            pairEnvelope(
              SUBTYPE.PAIR.PROOF,
              { v: PAIR_VERSION, pub: keyPair.publicKeyB64, nonce, proof },
              { channelId, senderId: deviceId, senderName },
            ),
          );
          return;
        } else if (pairVersion === LEGACY_PAIR_VERSION && payload?.eventSubtype === SUBTYPE.PAIR.ACK) {
          if (payload.channelId !== channelId) return;
        } else {
          if (!sessionKey || !activeChallenge) return;
          let ack;
          try {
            ack = await decryptJSON(sessionKey, payload);
          } catch {
            return;
          }
          if (
            ack?.eventSubtype !== SUBTYPE.PAIR.ACK ||
            ack.channelId !== channelId ||
            ack.msg?.nonce !== nonce ||
            ack.msg?.challenge !== activeChallenge
          ) return;
        }
        if (settled || !sessionKey) return;
        settled = true;
        cleanup();
        resolve({ key: sessionKey, protocolVersion });
      })().catch(() => {
        // Ignore malformed or forged challenge/ack traffic; the retry loop continues.
      });
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

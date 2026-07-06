// Weft end-to-end crypto.
//
// ECDH (P-256) key agreement -> HKDF-SHA256 -> AES-256-GCM. P-256 is chosen for universal
// Web Crypto support in BOTH Node (>=18) and browsers; the pairing QR carries only a PUBLIC
// key, never a secret. Every message uses a fresh random 96-bit IV.
//
// Implemented against globalThis.crypto.subtle so the same module runs in the extension (Node)
// and the mobile app (browser/WebView). Zero dependencies.
//
const cryptoObj = globalThis.crypto;
const subtle = cryptoObj?.subtle;
if (!subtle) {
  throw new Error("weft/crypto: Web Crypto (globalThis.crypto.subtle) is unavailable.");
}
if (typeof cryptoObj.getRandomValues !== "function") {
  throw new Error("weft/crypto: Web Crypto getRandomValues is unavailable.");
}

const te = new TextEncoder();
const td = new TextDecoder();

const EC_PARAMS = { name: "ECDH", namedCurve: "P-256" };
const HKDF_SALT = te.encode("weft-v1");
const HKDF_INFO = te.encode("weft-session-key");
const P256_RAW_PUBLIC_KEY_BYTES = 65;
const AES_GCM_IV_BYTES = 12;
const AES_GCM_TAG_BYTES = 16;
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_CIPHERTEXT_BYTES = MAX_JSON_BYTES + AES_GCM_TAG_BYTES;
const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function cryptoError(message, cause) {
  return new Error(`weft/crypto: ${message}`, cause === undefined ? undefined : { cause });
}

function assertCryptoKey(key, label, expected) {
  if (!key || typeof key !== "object" || !key.algorithm || key.algorithm.name !== expected.name) {
    throw cryptoError(`${label} must be a ${expected.name} CryptoKey.`);
  }
  if (expected.type && key.type !== expected.type) {
    throw cryptoError(`${label} must be a ${expected.type} CryptoKey.`);
  }
  if (expected.namedCurve && key.algorithm.namedCurve !== expected.namedCurve) {
    throw cryptoError(`${label} must use ${expected.namedCurve}.`);
  }
}

// ---- base64 helpers (cross-platform: Node Buffer or browser btoa/atob) -----
function bytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (typeof Buffer !== "undefined") return Buffer.from(arr).toString("base64");
  let bin = "";
  for (let i = 0; i < arr.length; i += 0x8000) {
    const chunk = arr.subarray(i, i + 0x8000);
    for (let j = 0; j < chunk.length; j++) bin += String.fromCharCode(chunk[j]);
  }
  return btoa(bin);
}
function b64ToBytes(b64, { label = "base64 value", maxBytes = MAX_CIPHERTEXT_BYTES, allowEmpty = false } = {}) {
  if (typeof b64 !== "string") {
    throw cryptoError(`${label} must be a base64 string.`);
  }
  if (!allowEmpty && b64.length === 0) {
    throw cryptoError(`${label} must not be empty.`);
  }
  if (b64.length % 4 !== 0 || !BASE64_RE.test(b64)) {
    throw cryptoError(`${label} is not valid base64.`);
  }
  const expectedBytes = (b64.length / 4) * 3 - (b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0);
  if (expectedBytes > maxBytes) {
    throw cryptoError(`${label} is too large.`);
  }

  let arr;
  if (typeof Buffer !== "undefined") {
    arr = new Uint8Array(Buffer.from(b64, "base64"));
  } else {
    let bin;
    try {
      bin = atob(b64);
    } catch (err) {
      throw cryptoError(`${label} is not valid base64.`, err);
    }
    arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  }
  if (arr.length !== expectedBytes) {
    throw cryptoError(`${label} is not valid base64.`);
  }
  return arr;
}

function parsePublicKeyB64(b64) {
  const raw = b64ToBytes(b64, {
    label: "peer public key",
    maxBytes: P256_RAW_PUBLIC_KEY_BYTES,
  });
  if (raw.length !== P256_RAW_PUBLIC_KEY_BYTES || raw[0] !== 0x04) {
    throw cryptoError("peer public key must be a raw uncompressed P-256 point.");
  }
  return raw;
}

function validateEncryptedPayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw cryptoError("encrypted payload must be an object with iv and ciphertext.");
  }
  const iv = b64ToBytes(payload.iv, { label: "payload iv", maxBytes: AES_GCM_IV_BYTES });
  if (iv.length !== AES_GCM_IV_BYTES) {
    throw cryptoError("payload iv must decode to 12 bytes.");
  }
  const ct = b64ToBytes(payload.ciphertext, {
    label: "payload ciphertext",
    maxBytes: MAX_CIPHERTEXT_BYTES,
  });
  if (ct.length < AES_GCM_TAG_BYTES) {
    throw cryptoError("payload ciphertext is too short.");
  }
  return { iv, ct };
}

function stringifyJSON(data) {
  let json;
  try {
    json = JSON.stringify(data);
  } catch (err) {
    throw cryptoError("data must be JSON-serializable.", err);
  }
  if (typeof json !== "string") {
    throw cryptoError("data must be JSON-serializable.");
  }
  const pt = te.encode(json);
  if (pt.length > MAX_JSON_BYTES) {
    throw cryptoError("JSON plaintext is too large.");
  }
  return pt;
}

function parseJSON(bytes) {
  if (bytes.length > MAX_JSON_BYTES) {
    throw cryptoError("decrypted JSON plaintext is too large.");
  }
  try {
    return JSON.parse(td.decode(bytes));
  } catch (err) {
    throw cryptoError("decrypted plaintext is not valid JSON.", err);
  }
}

/** Generate an ephemeral ECDH (P-256) keypair. */
export async function generateKeyPair() {
  const pair = await subtle.generateKey(EC_PARAMS, true, ["deriveBits"]);
  const publicKeyB64 = await exportPublicKeyB64(pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, publicKeyB64 };
}

/**
 * Export an ECDH keypair to a portable, JSON-serializable identity. Used by the `weft-cli`
 * listener to pre-mint a session's identity and hand it to the spawned Copilot process via a
 * short-lived 0600 temp file (never on argv/env). The private key is exported as a JWK; keys are
 * generated extractable, so this is always possible.
 * @param {{ privateKey: CryptoKey, publicKeyB64: string }} keyPair
 * @returns {Promise<{ publicKeyB64: string, privateKeyJwk: JsonWebKey }>}
 */
export async function exportKeyPair(keyPair) {
  assertCryptoKey(keyPair?.privateKey, "privateKey", {
    name: "ECDH",
    type: "private",
    namedCurve: "P-256",
  });
  if (typeof keyPair.publicKeyB64 !== "string" || keyPair.publicKeyB64.length === 0) {
    throw cryptoError("keyPair.publicKeyB64 is required to export a keypair.");
  }
  try {
    const privateKeyJwk = await subtle.exportKey("jwk", keyPair.privateKey);
    return { publicKeyB64: keyPair.publicKeyB64, privateKeyJwk };
  } catch (err) {
    throw cryptoError("failed to export keypair.", err);
  }
}

/**
 * Re-import a keypair produced by exportKeyPair. Reconstructs the private key (deriveBits) and the
 * matching public key + its base64 form, so the spawned extension pairs on the pre-minted identity.
 * @param {{ privateKeyJwk: JsonWebKey }} material
 * @returns {Promise<{ privateKey: CryptoKey, publicKey: CryptoKey, publicKeyB64: string }>}
 */
export async function importKeyPair({ privateKeyJwk } = {}) {
  if (!privateKeyJwk || typeof privateKeyJwk !== "object") {
    throw cryptoError("privateKeyJwk is required to import a keypair.");
  }
  let privateKey;
  try {
    privateKey = await subtle.importKey("jwk", privateKeyJwk, EC_PARAMS, true, ["deriveBits"]);
  } catch (err) {
    throw cryptoError("failed to import private key.", err);
  }
  // Derive the public key from the private JWK's public components (drop `d`, clear key_ops/use).
  const { d: _d, key_ops: _ko, use: _use, ext: _ext, ...publicJwk } = privateKeyJwk;
  let publicKey;
  try {
    publicKey = await subtle.importKey("jwk", { ...publicJwk, key_ops: [] }, EC_PARAMS, true, []);
  } catch (err) {
    throw cryptoError("failed to derive public key from keypair.", err);
  }
  const publicKeyB64 = await exportPublicKeyB64(publicKey);
  return { privateKey, publicKey, publicKeyB64 };
}

/** Export a public CryptoKey to base64 (raw, uncompressed point). */
export async function exportPublicKeyB64(publicKey) {
  assertCryptoKey(publicKey, "publicKey", { name: "ECDH", type: "public", namedCurve: "P-256" });
  try {
    const raw = await subtle.exportKey("raw", publicKey);
    return bytesToB64(new Uint8Array(raw));
  } catch (err) {
    throw cryptoError("failed to export public key.", err);
  }
}

/** Import a peer public key from base64 (as produced by exportPublicKeyB64). */
export async function importPeerPublicKey(b64) {
  const raw = parsePublicKeyB64(b64);
  try {
    return await subtle.importKey("raw", raw, EC_PARAMS, true, []);
  } catch (err) {
    throw cryptoError("failed to import peer public key.", err);
  }
}

/**
 * Derive the shared AES-256-GCM session key from our private key + the peer's public key.
 * @param {CryptoKey} privateKey - our ECDH private key
 * @param {string} peerPublicKeyB64 - the peer's public key (base64)
 * @returns {Promise<CryptoKey>} an AES-GCM key usable with encryptJSON/decryptJSON
 */
export async function deriveSessionKey(privateKey, peerPublicKeyB64) {
  assertCryptoKey(privateKey, "privateKey", { name: "ECDH", type: "private", namedCurve: "P-256" });
  const peerPublic = await importPeerPublicKey(peerPublicKeyB64);
  try {
    const sharedBits = await subtle.deriveBits({ name: "ECDH", public: peerPublic }, privateKey, 256);
    const hkdfKey = await subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
    return await subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
      hkdfKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } catch (err) {
    throw cryptoError("failed to derive session key.", err);
  }
}

/** Encrypt a JSON-serializable value. Returns { iv, ciphertext } as base64 strings. */
export async function encryptJSON(key, data) {
  assertCryptoKey(key, "key", { name: "AES-GCM" });
  const iv = cryptoObj.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const pt = stringifyJSON(data);
  try {
    const ct = await subtle.encrypt({ name: "AES-GCM", iv }, key, pt);
    return { iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ct)) };
  } catch (err) {
    throw cryptoError("failed to encrypt JSON.", err);
  }
}

/** Decrypt a { iv, ciphertext } payload back into its JSON value. */
export async function decryptJSON(key, payload) {
  assertCryptoKey(key, "key", { name: "AES-GCM" });
  const { iv, ct } = validateEncryptedPayload(payload);
  let pt;
  try {
    pt = await subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  } catch (err) {
    throw cryptoError("failed to decrypt JSON payload.", err);
  }
  return parseJSON(new Uint8Array(pt));
}

/** Unguessable channel id (128 bits, hex) used to namespace the Broadcast channel. */
export function randomChannelId() {
  const b = cryptoObj.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export const _internal = { bytesToB64, b64ToBytes };

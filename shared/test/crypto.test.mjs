import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateKeyPair,
  exportPublicKeyB64,
  importPeerPublicKey,
  deriveSessionKey,
  encryptJSON,
  decryptJSON,
  randomChannelId,
  _internal,
} from "../crypto.mjs";

async function pairedSessionKeys() {
  const a = await generateKeyPair();
  const b = await generateKeyPair();
  const aKey = await deriveSessionKey(a.privateKey, b.publicKeyB64);
  const bKey = await deriveSessionKey(b.privateKey, a.publicKeyB64);
  return { a, b, aKey, bKey };
}

function flipCiphertextByte(payload) {
  const bytes = Buffer.from(payload.ciphertext, "base64");
  bytes[0] ^= 0xff;
  return { ...payload, ciphertext: bytes.toString("base64") };
}

test("two-party ECDH derives keys that decrypt each other's JSON", async () => {
  const { aKey, bKey } = await pairedSessionKeys();
  const value = {
    kind: "assistant.message",
    content: "hello from laptop",
    nested: { ok: true, count: 3 },
  };

  assert.deepEqual(await decryptJSON(bKey, await encryptJSON(aKey, value)), value);
  assert.deepEqual(await decryptJSON(aKey, await encryptJSON(bKey, value)), value);
});

test("encrypting the same plaintext twice uses unique IVs and ciphertexts", async () => {
  const { aKey } = await pairedSessionKeys();
  const first = await encryptJSON(aKey, { message: "same plaintext" });
  const second = await encryptJSON(aKey, { message: "same plaintext" });

  assert.notEqual(first.iv, second.iv);
  assert.notEqual(first.ciphertext, second.ciphertext);
});

test("tampered ciphertext and wrong keys are rejected", async () => {
  const { aKey, bKey } = await pairedSessionKeys();
  const attacker = await generateKeyPair();
  const wrongKey = await deriveSessionKey(attacker.privateKey, attacker.publicKeyB64);
  const payload = await encryptJSON(aKey, { secret: "relay only sees ciphertext" });

  await assert.rejects(() => decryptJSON(bKey, flipCiphertextByte(payload)), /helm\/crypto:/);
  await assert.rejects(() => decryptJSON(wrongKey, payload), /helm\/crypto:/);
});

test("randomChannelId returns unique 128-bit hex identifiers", () => {
  const ids = new Set(Array.from({ length: 64 }, () => randomChannelId()));

  assert.equal(ids.size, 64);
  for (const id of ids) {
    assert.match(id, /^[0-9a-f]{32}$/);
  }
});

test("varied JSON values round-trip", async () => {
  const { aKey, bKey } = await pairedSessionKeys();
  const values = [
    "unicode: café 東京 🔐🚀",
    { nested: { arr: [1, "two", false, null], emoji: "🛡️" } },
    ["array", { object: true }, 42, null],
    123.456,
    true,
    false,
    null,
  ];

  for (const value of values) {
    assert.deepEqual(await decryptJSON(bKey, await encryptJSON(aKey, value)), value);
  }
});

test("public key export/import round-trip remains derivable", async () => {
  const a = await generateKeyPair();
  const b = await generateKeyPair();

  const exported = await exportPublicKeyB64(a.publicKey);
  const imported = await importPeerPublicKey(exported);
  const reexported = await exportPublicKeyB64(imported);

  assert.equal(reexported, exported);

  const aKey = await deriveSessionKey(a.privateKey, b.publicKeyB64);
  const bKey = await deriveSessionKey(b.privateKey, reexported);
  const value = { roundTrip: "export/import" };

  assert.deepEqual(await decryptJSON(bKey, await encryptJSON(aKey, value)), value);
});

test("invalid payloads fail with helm/crypto-prefixed errors", async () => {
  const { aKey } = await pairedSessionKeys();

  await assert.rejects(() => importPeerPublicKey("not base64!"), /helm\/crypto:/);
  await assert.rejects(() => decryptJSON(aKey, null), /helm\/crypto:/);
  await assert.rejects(() => decryptJSON(aKey, { iv: "", ciphertext: "" }), /helm\/crypto:/);
});

test("base64 helpers preserve binary bytes in Node and browser fallback paths", () => {
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
  const nodeB64 = _internal.bytesToB64(bytes);

  assert.deepEqual(_internal.b64ToBytes(nodeB64), bytes);

  const originalBuffer = globalThis.Buffer;
  try {
    globalThis.Buffer = undefined;
    const browserB64 = _internal.bytesToB64(bytes);
    assert.equal(browserB64, nodeB64);
    assert.deepEqual(_internal.b64ToBytes(browserB64), bytes);
  } finally {
    globalThis.Buffer = originalBuffer;
  }
});

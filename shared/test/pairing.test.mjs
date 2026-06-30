// Pairing handshake test: phone delivers its public key to the laptop over the (unencrypted)
// pair.hello event; both sides derive the SAME AES-GCM key; an encrypted message round-trips.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair, encryptJSON, decryptJSON, randomChannelId } from "../crypto.mjs";
import { waitForPeer, sayHello, buildPairingPayload, parsePairingPayload } from "../pairing.mjs";
import { createLocalTransport, _resetLocalBus } from "../transport-local.mjs";

test("buildPairingPayload / parsePairingPayload round-trip", () => {
  const payload = buildPairingPayload({ channelId: "abc", publicKeyB64: "PUB" });
  const parsed = parsePairingPayload(JSON.stringify(payload));
  assert.equal(parsed.channelId, "abc");
  assert.equal(parsed.publicKeyB64, "PUB");
  assert.throws(() => parsePairingPayload({ v: 999, channelId: "x", pub: "y" }), /invalid pairing/);
});

test("handshake derives matching keys on both ends and round-trips encryption", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();

  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();

  const laptopT = createLocalTransport({ channelId });
  const phoneT = createLocalTransport({ channelId });

  // Laptop shows QR (its public key); start waiting for the phone.
  const qr = buildPairingPayload({ channelId, publicKeyB64: laptop.publicKeyB64 });
  const laptopPromise = waitForPeer({ transport: laptopT, keyPair: laptop, timeoutMs: 5000 });

  // Phone scans QR, derives key, says hello (and waits for the laptop ACK).
  const { channelId: scannedChannel, publicKeyB64: scannedPub } = parsePairingPayload(qr);
  assert.equal(scannedChannel, channelId);
  const phoneResult = await sayHello({
    transport: phoneT,
    keyPair: phone,
    peerPublicKeyB64: scannedPub,
    deviceId: "pixel",
    waitForAck: true,
  });

  const laptopResult = await laptopPromise;

  assert.equal(laptopResult.peer.publicKeyB64, phone.publicKeyB64);
  assert.equal(laptopResult.peer.deviceId, "pixel");

  // The two independently-derived keys must interoperate.
  const sealed = await encryptJSON(phoneResult.key, { hello: "from phone" });
  const opened = await decryptJSON(laptopResult.key, sealed);
  assert.deepEqual(opened, { hello: "from phone" });

  await laptopT.close();
  await phoneT.close();
});

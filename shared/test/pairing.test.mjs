// Pairing handshake test: phone delivers its public key to the laptop over the (unencrypted)
// pair.hello event; both sides derive the SAME AES-GCM key; an encrypted message round-trips.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair, encryptJSON, decryptJSON, randomChannelId } from "../crypto.mjs";
import { waitForPeer, sayHello, listenForPeers, buildPairingPayload, parsePairingPayload } from "../pairing.mjs";
import { createLocalTransport, _resetLocalBus } from "../transport-local.mjs";

test("buildPairingPayload / parsePairingPayload round-trip", () => {
  const payload = buildPairingPayload({ channelId: "abc", publicKeyB64: "PUB", transport: { kind: "local" } });
  const parsed = parsePairingPayload(JSON.stringify(payload));
  assert.equal(parsed.channelId, "abc");
  assert.equal(parsed.publicKeyB64, "PUB");
  assert.deepEqual(parsed.transport, { kind: "local" });
  assert.throws(() => parsePairingPayload({ v: 999, channelId: "x", pub: "y", transport: { kind: "local" } }), /invalid pairing/);
});

test("buildPairingPayload carries an optional appVersion; parse tolerates its absence", () => {
  const withVersion = buildPairingPayload({
    channelId: "abc",
    publicKeyB64: "PUB",
    transport: { kind: "local" },
    appVersion: "0.1.0",
  });
  assert.equal(withVersion.appVersion, "0.1.0");
  assert.equal(parsePairingPayload(JSON.stringify(withVersion)).appVersion, "0.1.0");

  // Omitted → the field is never stamped (keeps legacy QRs byte-identical) and parse returns undefined.
  const without = buildPairingPayload({ channelId: "abc", publicKeyB64: "PUB", transport: { kind: "local" } });
  assert.equal("appVersion" in without, false);
  assert.equal(parsePairingPayload(JSON.stringify(without)).appVersion, undefined);
});

test("buildPairingPayload accepts a devtunnel transport descriptor", () => {
  const payload = buildPairingPayload({
    channelId: "abc",
    publicKeyB64: "PUB",
    transport: { kind: "devtunnel", url: "wss://example.devtunnels.ms" },
  });
  const parsed = parsePairingPayload(JSON.stringify(payload));
  assert.deepEqual(parsed.transport, { kind: "devtunnel", url: "wss://example.devtunnels.ms" });
});

test("buildPairingPayload requires a valid transport descriptor", () => {
  assert.throws(() => buildPairingPayload({ channelId: "abc", publicKeyB64: "PUB" }), /transport descriptor is required/);
  assert.throws(
    () => buildPairingPayload({ channelId: "abc", publicKeyB64: "PUB", transport: { kind: "bogus" } }),
    /transport descriptor is required/,
  );
  assert.throws(
    () => buildPairingPayload({ channelId: "abc", publicKeyB64: "PUB", transport: { kind: "supabase" } }),
    /transport descriptor is required/,
  );
  assert.throws(
    () => buildPairingPayload({ channelId: "abc", publicKeyB64: "PUB", transport: { kind: "devtunnel" } }),
    /transport descriptor is required/,
  );
});

test("parsePairingPayload rejects a missing or malformed transport descriptor", () => {
  assert.throws(
    () => parsePairingPayload({ v: 1, channelId: "abc", pub: "PUB" }),
    /invalid pairing/,
  );
  assert.throws(
    () => parsePairingPayload({ v: 1, channelId: "abc", pub: "PUB", transport: { kind: "bogus" } }),
    /invalid pairing/,
  );
});

test("handshake derives matching keys on both ends and round-trips encryption", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();

  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();

  const laptopT = createLocalTransport({ channelId });
  const phoneT = createLocalTransport({ channelId });

  // Laptop shows QR (its public key); start waiting for the phone.
  const qr = buildPairingPayload({ channelId, publicKeyB64: laptop.publicKeyB64, transport: { kind: "local" } });
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

test("listenForPeers re-pairs across repeated scans (single-shot waitForPeer would not)", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptop = await generateKeyPair();
  const laptopT = createLocalTransport({ channelId });

  // The laptop keeps listening for the WHOLE session, acking every hello and deriving a fresh key.
  const peers = [];
  const acks = [];
  const listener = await listenForPeers({
    transport: laptopT,
    keyPair: laptop,
    onAck: (result) => acks.push(result),
    onPeer: (info) => {
      peers.push(info);
    },
  });

  // First phone pairs. retryMs is parked high so each sayHello emits exactly one deterministic hello.
  const phoneA = await generateKeyPair();
  const phoneAT = createLocalTransport({ channelId });
  const resA = await sayHello({
    transport: phoneAT,
    keyPair: phoneA,
    peerPublicKeyB64: laptop.publicKeyB64,
    deviceId: "phone-a",
    waitForAck: true,
    retryMs: 10_000,
  });

  // A SECOND scan / reload (a brand-new phone keypair) must also get an ack and re-pair.
  const phoneB = await generateKeyPair();
  const phoneBT = createLocalTransport({ channelId });
  const resB = await sayHello({
    transport: phoneBT,
    keyPair: phoneB,
    peerPublicKeyB64: laptop.publicKeyB64,
    deviceId: "phone-b",
    waitForAck: true,
    retryMs: 10_000,
  });

  assert.equal(peers.length, 2);
  assert.equal(acks.length, 2);
  assert.ok(acks.every((ack) => ack.ok));
  assert.equal(peers[0].peer.deviceId, "phone-a");
  assert.equal(peers[1].peer.deviceId, "phone-b");

  // Each independently-derived laptop key must interoperate with the matching phone key.
  const sealedA = await encryptJSON(resA.key, { from: "a" });
  assert.deepEqual(await decryptJSON(peers[0].key, sealedA), { from: "a" });
  const sealedB = await encryptJSON(resB.key, { from: "b" });
  assert.deepEqual(await decryptJSON(peers[1].key, sealedB), { from: "b" });

  listener.stop();
  await laptopT.close();
  await phoneAT.close();
  await phoneBT.close();
});

// Pairing handshake test: phone delivers its public key to the laptop over the (unencrypted)
// pair.hello event; both sides derive the SAME AES-GCM key; an encrypted message round-trips.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair, deriveSessionKey, encryptJSON, decryptJSON, randomChannelId } from "../crypto.mjs";
import {
  waitForPeer,
  sayHello,
  listenForPeers,
  buildPairingPayload,
  createPairingGate,
  parsePairingPayload,
} from "../pairing.mjs";
import { createLocalTransport, _resetLocalBus } from "../transport-local.mjs";

test("buildPairingPayload / parsePairingPayload round-trip", () => {
  const payload = buildPairingPayload({ channelId: "abc", publicKeyB64: "PUB", transport: { kind: "local" } });
  const parsed = parsePairingPayload(JSON.stringify(payload));
  assert.equal(parsed.channelId, "abc");
  assert.equal(parsed.publicKeyB64, "PUB");
  assert.deepEqual(parsed.transport, { kind: "local" });
  assert.equal(typeof parsed.pairingToken, "string");
  assert.ok(parsed.expiresAt > Date.now());
  assert.throws(() => parsePairingPayload({ v: 999, channelId: "x", pub: "y", transport: { kind: "local" } }), /invalid pairing/);
});

test("pairing gate expires unclaimed grants and permanently binds a claimed grant to one key", () => {
  const token = "a".repeat(43);
  const active = createPairingGate({ pairingToken: token, expiresAt: 2_000, now: () => 1_000 });
  assert.equal(active.authorize({ publicKeyB64: "phone-a", token: "wrong" }), false);
  assert.equal(active.authorize({ publicKeyB64: "phone-a", token }), true);
  assert.equal(active.authorize({ publicKeyB64: "phone-a" }), true, "the claimed phone may reconnect");
  assert.equal(active.authorize({ publicKeyB64: "phone-b", token }), false, "a second key cannot reuse the grant");

  const expired = createPairingGate({ pairingToken: token, expiresAt: 999, now: () => 1_000 });
  assert.equal(expired.authorize({ publicKeyB64: "phone-a", token }), false);

  const atBoundary = createPairingGate({ pairingToken: token, expiresAt: 1_000, now: () => 1_000 });
  assert.equal(atBoundary.authorize({ publicKeyB64: "phone-a", token }), false);
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

  // Omitted appVersion stays absent while the security grant remains present.
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
  const publishedByPhone = [];
  const publishFromPhone = phoneT.publish.bind(phoneT);
  phoneT.publish = async (event, payload) => {
    publishedByPhone.push(payload);
    return publishFromPhone(event, payload);
  };

  // Laptop shows QR (its public key); start waiting for the phone.
  const qr = buildPairingPayload({ channelId, publicKeyB64: laptop.publicKeyB64, transport: { kind: "local" } });
  const laptopPromise = waitForPeer({
    transport: laptopT,
    keyPair: laptop,
    timeoutMs: 5000,
    channelId,
    pairingGate: createPairingGate({
      pairingToken: qr.token,
      expiresAt: qr.expiresAt,
    }),
  });

  // Phone scans QR, derives key, says hello (and waits for the laptop ACK).
  const {
    channelId: scannedChannel,
    publicKeyB64: scannedPub,
    pairingToken,
  } = parsePairingPayload(qr);
  assert.equal(scannedChannel, channelId);
  const phoneResult = await sayHello({
    transport: phoneT,
    keyPair: phone,
    peerPublicKeyB64: scannedPub,
    deviceId: "pixel",
    channelId,
    waitForAck: true,
    pairingToken,
  });

  const laptopResult = await laptopPromise;

  assert.equal(laptopResult.peer.publicKeyB64, phone.publicKeyB64);
  assert.equal(laptopResult.peer.deviceId, "pixel");
  const publishedProof = publishedByPhone.find(
    (payload) => payload.eventSubtype === "proof",
  );
  assert.equal(publishedByPhone[0].msg.token, undefined);
  assert.equal(typeof publishedProof?.msg?.proof?.ciphertext, "string");
  assert.equal(JSON.stringify(publishedByPhone).includes(pairingToken), false);

  // The two independently-derived keys must interoperate.
  const sealed = await encryptJSON(phoneResult.key, { hello: "from phone" });
  const opened = await decryptJSON(laptopResult.key, sealed);
  assert.deepEqual(opened, { hello: "from phone" });

  await laptopT.close();
  await phoneT.close();
});

test("a captured reconnect hello and proof cannot recreate an old session key", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();
  const captured = [];
  const firstLaptop = createLocalTransport({ channelId });
  const firstPhone = createLocalTransport({ channelId });
  const publish = firstPhone.publish.bind(firstPhone);
  firstPhone.publish = async (event, payload) => {
    captured.push({ event, payload });
    return publish(event, payload);
  };
  const firstPeers = [];
  const firstListener = await listenForPeers({
    transport: firstLaptop,
    keyPair: laptop,
    channelId,
    pairingGate: createPairingGate({ trustedPeerPublicKeyB64: phone.publicKeyB64 }),
    onPeer: (info) => firstPeers.push(info),
  });
  await sayHello({
    transport: firstPhone,
    keyPair: phone,
    peerPublicKeyB64: laptop.publicKeyB64,
    channelId,
    waitForAck: true,
  });
  assert.equal(firstPeers.length, 1);
  firstListener.stop();
  await firstLaptop.close();
  await firstPhone.close();

  _resetLocalBus();
  const secondLaptop = createLocalTransport({ channelId });
  const attacker = createLocalTransport({ channelId });
  const replayedPeers = [];
  const secondListener = await listenForPeers({
    transport: secondLaptop,
    keyPair: laptop,
    channelId,
    pairingGate: createPairingGate({ trustedPeerPublicKeyB64: phone.publicKeyB64 }),
    onPeer: (info) => replayedPeers.push(info),
  });
  await attacker.connect();
  for (const item of captured) await attacker.publish(item.event, item.payload);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(replayedPeers.length, 0);

  secondListener.stop();
  await secondLaptop.close();
  await attacker.close();
});

test("a version-2 phone can still pair with a version-1 laptop QR during rollout", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();
  const laptopTransport = createLocalTransport({ channelId });
  const phoneTransport = createLocalTransport({ channelId });
  let laptopKey;
  laptopTransport.subscribe("pair", (payload) => {
    if (payload?.eventSubtype !== "hello") return;
    void (async () => {
      laptopKey = await deriveSessionKey(laptop.privateKey, payload.msg.pub);
      await laptopTransport.publish("pair", {
        eventType: "pair",
        eventSubtype: "ack",
        channelId,
        msg: { ok: true },
        ts: Date.now(),
      });
    })();
  });
  await laptopTransport.connect();

  const phoneResult = await sayHello({
    transport: phoneTransport,
    keyPair: phone,
    peerPublicKeyB64: laptop.publicKeyB64,
    channelId,
    waitForAck: true,
    pairVersion: 1,
  });
  assert.equal(phoneResult.protocolVersion, 1);
  const sealed = await encryptJSON(phoneResult.key, { compatible: true });
  assert.deepEqual(await decryptJSON(laptopKey, sealed), { compatible: true });

  await laptopTransport.close();
  await phoneTransport.close();
});

test("a stored version-1 phone identity upgrades securely when the laptop moves to version 2", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();
  const laptopTransport = createLocalTransport({ channelId });
  const phoneTransport = createLocalTransport({ channelId });
  const peers = [];
  const listener = await listenForPeers({
    transport: laptopTransport,
    keyPair: laptop,
    channelId,
    pairingGate: createPairingGate({ trustedPeerPublicKeyB64: phone.publicKeyB64 }),
    onPeer: (info) => peers.push(info),
  });

  const phoneResult = await sayHello({
    transport: phoneTransport,
    keyPair: phone,
    peerPublicKeyB64: laptop.publicKeyB64,
    channelId,
    waitForAck: true,
    pairVersion: 1,
  });
  assert.equal(peers.length, 1);
  assert.equal(phoneResult.protocolVersion, 2);
  const sealed = await encryptJSON(phoneResult.key, { upgraded: true });
  assert.deepEqual(await decryptJSON(peers[0].key, sealed), { upgraded: true });

  listener.stop();
  await laptopTransport.close();
  await phoneTransport.close();
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

test("a pairing bearer token is single-use even when two phones race it", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptop = await generateKeyPair();
  const pairing = buildPairingPayload({
    channelId,
    publicKeyB64: laptop.publicKeyB64,
    transport: { kind: "local" },
  });
  const laptopT = createLocalTransport({ channelId });
  const peers = [];
  const listener = await listenForPeers({
    transport: laptopT,
    keyPair: laptop,
    channelId,
    pairingGate: createPairingGate({
      pairingToken: pairing.token,
      expiresAt: pairing.expiresAt,
    }),
    onPeer: (info) => peers.push(info),
  });
  const phones = await Promise.all([generateKeyPair(), generateKeyPair()]);
  const transports = phones.map(() => createLocalTransport({ channelId }));

  const results = await Promise.allSettled(
    phones.map((phone, index) =>
      sayHello({
        transport: transports[index],
        keyPair: phone,
        peerPublicKeyB64: laptop.publicKeyB64,
        channelId,
        deviceId: `phone-${index}`,
        waitForAck: true,
        timeoutMs: 100,
        retryMs: 20,
        pairingToken: pairing.token,
      }),
    ),
  );

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.equal(new Set(peers.map((peer) => peer.peer.publicKeyB64)).size, 1);

  listener.stop();
  await laptopT.close();
  await Promise.all(transports.map((transport) => transport.close()));
});

test("each reconnect derives a fresh key even when both peers reuse persistent ECDH identities", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();
  const pairing = buildPairingPayload({
    channelId,
    publicKeyB64: laptop.publicKeyB64,
    transport: { kind: "local" },
  });
  const laptopT = createLocalTransport({ channelId });
  const peerKeys = [];
  const listener = await listenForPeers({
    transport: laptopT,
    keyPair: laptop,
    channelId,
    pairingGate: createPairingGate({
      pairingToken: pairing.token,
      expiresAt: pairing.expiresAt,
    }),
    onPeer: ({ key }) => peerKeys.push(key),
  });

  const firstTransport = createLocalTransport({ channelId });
  const first = await sayHello({
    transport: firstTransport,
    keyPair: phone,
    peerPublicKeyB64: laptop.publicKeyB64,
    channelId,
    waitForAck: true,
    pairingToken: pairing.token,
  });
  const secondTransport = createLocalTransport({ channelId });
  const second = await sayHello({
    transport: secondTransport,
    keyPair: phone,
    peerPublicKeyB64: laptop.publicKeyB64,
    channelId,
    waitForAck: true,
  });

  const firstCiphertext = await encryptJSON(first.key, { generation: 1 });
  assert.deepEqual(await decryptJSON(peerKeys[0], firstCiphertext), { generation: 1 });
  await assert.rejects(() => decryptJSON(second.key, firstCiphertext), /weft\/crypto:/);
  const secondCiphertext = await encryptJSON(second.key, { generation: 2 });
  assert.deepEqual(await decryptJSON(peerKeys[1], secondCiphertext), { generation: 2 });

  listener.stop();
  await laptopT.close();
  await firstTransport.close();
  await secondTransport.close();
});

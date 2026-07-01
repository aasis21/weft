// End-to-end glue smoke test: crypto (ECDH->AES-GCM) + SecureChannel + LocalTransport + messages.
// Proves the shared contracts work together. The `shared-crypto` task extends this with vectors.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  generateKeyPair,
  deriveSessionKey,
  randomChannelId,
} from "../crypto.mjs";
import { SecureChannel } from "../channel.mjs";
import { createLocalTransport, _resetLocalBus } from "../transport-local.mjs";
import { EVENTS, assistantMessage, prompt } from "../messages.mjs";

test("ECDH session keys match on both sides and round-trip an encrypted message", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();

  // ext = laptop side, phone = mobile side
  const ext = await generateKeyPair();
  const phone = await generateKeyPair();

  const extKey = await deriveSessionKey(ext.privateKey, phone.publicKeyB64);
  const phoneKey = await deriveSessionKey(phone.privateKey, ext.publicKeyB64);

  const extChan = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key: extKey,
    identity: { userId: "u1", deviceId: "laptop", sessionId: "s1" },
  });
  const phoneChan = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key: phoneKey,
    identity: { userId: "u1", deviceId: "phone", sessionId: "s1" },
  });

  // phone listens on STREAM; ext sends an assistant message
  const gotOnPhone = new Promise((resolve) => {
    phoneChan.onEvent(EVENTS.STREAM, resolve);
  });
  await extChan.send(assistantMessage("hello from laptop", "m1"));
  const streamMsg = await gotOnPhone;
  assert.equal(streamMsg.kind, "assistant.message");
  assert.equal(streamMsg.content, "hello from laptop");
  assert.equal(streamMsg.deviceId, "laptop");

  // ext listens on PROMPT; phone sends a prompt
  const gotOnExt = new Promise((resolve) => {
    extChan.onEvent(EVENTS.PROMPT, resolve);
  });
  await phoneChan.send(prompt("run the tests"));
  const promptMsg = await gotOnExt;
  assert.equal(promptMsg.kind, "prompt");
  assert.equal(promptMsg.text, "run the tests");
  assert.equal(promptMsg.deviceId, "phone");

  await extChan.close();
  await phoneChan.close();
});

test("a wrong key cannot decrypt (message is dropped, not thrown)", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const ext = await generateKeyPair();
  const phone = await generateKeyPair();
  const attacker = await generateKeyPair();

  const extKey = await deriveSessionKey(ext.privateKey, phone.publicKeyB64);
  const wrongKey = await deriveSessionKey(attacker.privateKey, attacker.publicKeyB64);

  const sender = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key: extKey,
    identity: {},
  });
  const eavesdropper = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key: wrongKey,
    identity: {},
  });

  let received = false;
  eavesdropper.onEvent(EVENTS.STREAM, () => {
    received = true;
  });
  await sender.send(assistantMessage("secret"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received, false);

  await sender.close();
  await eavesdropper.close();
});

test("SecureChannel.onStatus reports connected on connect and disconnected on close", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const ext = await generateKeyPair();
  const phone = await generateKeyPair();
  const key = await deriveSessionKey(ext.privateKey, phone.publicKeyB64);

  const chan = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key,
    identity: {},
  });

  const seen = [];
  chan.onStatus((status) => seen.push(status));

  await chan.connect();
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(seen, ["connected"]);

  await chan.close();
  assert.deepEqual(seen, ["connected", "disconnected"]);
});

test("SecureChannel.onStatus is a no-op when the transport can't report status", () => {
  const stub = {
    connect: async () => {},
    publish: async () => {},
    subscribe: () => () => {},
    close: async () => {},
  };
  const chan = new SecureChannel({ transport: stub, key: {}, identity: {} });
  const off = chan.onStatus(() => {
    throw new Error("should never be called");
  });
  assert.equal(typeof off, "function");
  off();
});

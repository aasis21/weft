// End-to-end glue smoke test: crypto (ECDH->AES-GCM) + SecureChannel + LocalTransport + messages.
// Proves the shared contracts work together with the standardized event envelope: the channel
// stamps identity (senderId/senderName/sessionId/channelId) onto each outgoing envelope, encrypts
// it, and the peer receives the decrypted envelope with its payload nested under `msg`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair, deriveSessionKey, decryptJSON, randomChannelId } from "../crypto.mjs";
import { SecureChannel } from "../channel.mjs";
import { createLocalTransport, _resetLocalBus } from "../transport-local.mjs";
import { EVENT_TYPE, assistantMessage, prompt } from "../messages.mjs";

test("ECDH session keys match on both sides and round-trip an encrypted envelope", async () => {
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
    identity: { senderId: "copilot", senderName: "Copilot", sessionId: "s1", channelId },
  });
  const phoneChan = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key: phoneKey,
    identity: { senderId: "phone-1", senderName: "App", sessionId: "s1", channelId },
  });

  // phone listens on STREAM; ext sends an assistant message
  const gotOnPhone = new Promise((resolve) => {
    phoneChan.onEvent(EVENT_TYPE.STREAM, resolve);
  });
  await extChan.send(assistantMessage("hello from laptop", "m1"));
  const streamMsg = await gotOnPhone;
  assert.equal(streamMsg.eventType, EVENT_TYPE.STREAM);
  assert.equal(streamMsg.eventSubtype, "assistant_message");
  assert.equal(streamMsg.msg.content, "hello from laptop");
  assert.equal(streamMsg.senderId, "copilot"); // identity stamped by the channel
  assert.equal(streamMsg.senderName, "Copilot");

  // ext listens on PROMPT; phone sends a prompt
  const gotOnExt = new Promise((resolve) => {
    extChan.onEvent(EVENT_TYPE.PROMPT, resolve);
  });
  await phoneChan.send(prompt("run the tests"));
  const promptMsg = await gotOnExt;
  assert.equal(promptMsg.eventType, EVENT_TYPE.PROMPT);
  assert.equal(promptMsg.msg.text, "run the tests");
  assert.equal(promptMsg.senderId, "phone-1");
  assert.equal(promptMsg.senderName, "App");

  await extChan.close();
  await phoneChan.close();
});

test("legacy protocol mode round-trips the version-1 direct message envelope", async () => {
  _resetLocalBus();
  const channelId = randomChannelId();
  const laptop = await generateKeyPair();
  const phone = await generateKeyPair();
  const laptopKey = await deriveSessionKey(laptop.privateKey, phone.publicKeyB64);
  const phoneKey = await deriveSessionKey(phone.privateKey, laptop.publicKeyB64);
  const laptopChannel = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key: laptopKey,
    identity: { senderId: "legacy-laptop", channelId },
    protocolVersion: 1,
  });
  const phoneChannel = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key: phoneKey,
    identity: { senderId: "current-phone", channelId },
    protocolVersion: 1,
  });

  const received = new Promise((resolve) => phoneChannel.onEvent(EVENT_TYPE.STREAM, resolve));
  await laptopChannel.send(assistantMessage("legacy-compatible"));
  assert.equal((await received).msg.content, "legacy-compatible");

  await laptopChannel.close();
  await phoneChannel.close();
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
  eavesdropper.onEvent(EVENT_TYPE.STREAM, () => {
    received = true;
  });
  await sender.send(assistantMessage("secret"));
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(received, false);

  await sender.close();
  await eavesdropper.close();
});

function createBufferedTransport() {
  const handlers = new Map();
  const published = [];
  return {
    published,
    connect: async () => {},
    publish: async (event, envelope) => {
      published.push({ event, envelope });
    },
    subscribe: (event, handler) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => handlers.set(event, list.filter((candidate) => candidate !== handler));
    },
    deliver: async (index) => {
      const item = published[index];
      await Promise.all((handlers.get(item.event) ?? []).map((handler) => handler(item.envelope)));
    },
    close: async () => {},
  };
}

test("SecureChannel authenticates monotonic sequence data and rejects replayed or out-of-order envelopes", async () => {
  const ext = await generateKeyPair();
  const phone = await generateKeyPair();
  const senderKey = await deriveSessionKey(ext.privateKey, phone.publicKeyB64);
  const receiverKey = await deriveSessionKey(phone.privateKey, ext.publicKeyB64);
  const transport = createBufferedTransport();
  const sender = new SecureChannel({ transport, key: senderKey });
  const receiver = new SecureChannel({ transport, key: receiverKey });
  const received = [];

  receiver.onEvent(EVENT_TYPE.STREAM, (message) => received.push(message.msg.content));
  await Promise.all([
    sender.send(assistantMessage("first", "m1")),
    sender.send(assistantMessage("second", "m2")),
  ]);

  const firstInner = await decryptJSON(receiverKey, transport.published[0].envelope);
  const secondInner = await decryptJSON(receiverKey, transport.published[1].envelope);
  assert.equal(firstInner.sequence, 1);
  assert.equal(secondInner.sequence, 2);
  assert.equal(firstInner.streamId, secondInner.streamId);

  await transport.deliver(0);
  await transport.deliver(0);
  await transport.deliver(1);
  assert.deepEqual(received, ["first", "second"]);

  const reorderedTransport = createBufferedTransport();
  const reorderedSender = new SecureChannel({ transport: reorderedTransport, key: senderKey });
  const reorderedReceiver = new SecureChannel({ transport: reorderedTransport, key: receiverKey });
  const reorderedReceived = [];
  reorderedReceiver.onEvent(EVENT_TYPE.STREAM, (message) => reorderedReceived.push(message.msg.content));
  await reorderedSender.send(assistantMessage("older", "m3"));
  await reorderedSender.send(assistantMessage("newer", "m4"));
  await reorderedTransport.deliver(1);
  await reorderedTransport.deliver(0);
  assert.deepEqual(reorderedReceived, ["newer"]);
});

test("SecureChannel permits a sequence reset only on a fresh stream and retires the prior stream", async () => {
  const ext = await generateKeyPair();
  const phone = await generateKeyPair();
  const senderKey = await deriveSessionKey(ext.privateKey, phone.publicKeyB64);
  const receiverKey = await deriveSessionKey(phone.privateKey, ext.publicKeyB64);
  const transport = createBufferedTransport();
  const firstSender = new SecureChannel({ transport, key: senderKey });
  const receiver = new SecureChannel({ transport, key: receiverKey });
  const received = [];

  receiver.onEvent(EVENT_TYPE.STREAM, (message) => received.push(message.msg.content));
  await firstSender.send(assistantMessage("old-one", "m1"));
  await firstSender.send(assistantMessage("old-two", "m2"));
  await transport.deliver(0);

  const reconnectedSender = new SecureChannel({ transport, key: senderKey });
  await reconnectedSender.send(assistantMessage("new-one", "m3"));
  await transport.deliver(2);
  await transport.deliver(1);

  assert.deepEqual(received, ["old-one", "new-one"]);
});

test("SecureChannel fans one accepted envelope out to every handler for its event type", async () => {
  const ext = await generateKeyPair();
  const phone = await generateKeyPair();
  const senderKey = await deriveSessionKey(ext.privateKey, phone.publicKeyB64);
  const receiverKey = await deriveSessionKey(phone.privateKey, ext.publicKeyB64);
  const transport = createBufferedTransport();
  const sender = new SecureChannel({ transport, key: senderKey });
  const receiver = new SecureChannel({ transport, key: receiverKey });
  const received = [];

  receiver.onEvent(EVENT_TYPE.STREAM, (message) => received.push(`first:${message.msg.content}`));
  receiver.onEvent(EVENT_TYPE.STREAM, (message) => received.push(`second:${message.msg.content}`));
  await sender.send(assistantMessage("fan-out", "m1"));
  await transport.deliver(0);

  assert.deepEqual(received, ["first:fan-out", "second:fan-out"]);
});

test("SecureChannel never reuses a sequence after an ambiguous publish failure", async () => {
  const ext = await generateKeyPair();
  const phone = await generateKeyPair();
  const key = await deriveSessionKey(ext.privateKey, phone.publicKeyB64);
  const transport = createBufferedTransport();
  let failNext = true;
  const publish = transport.publish;
  transport.publish = async (event, envelope) => {
    await publish(event, envelope);
    if (failNext) {
      failNext = false;
      throw new Error("acknowledgement timed out");
    }
  };
  const sender = new SecureChannel({ transport, key });

  await assert.rejects(sender.send(assistantMessage("maybe delivered", "m1")), /timed out/);
  await sender.send(assistantMessage("next", "m2"));

  const first = await decryptJSON(key, transport.published[0].envelope);
  const second = await decryptJSON(key, transport.published[1].envelope);
  assert.equal(first.sequence, 1);
  assert.equal(second.sequence, 2);
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

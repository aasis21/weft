import { test } from "node:test";
import assert from "node:assert/strict";

import { createWebPubSubTransport } from "../transport-webpubsub.mjs";

const envelope = Object.freeze({ iv: "iv", ciphertext: "ciphertext", ts: 1 });

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakeWebPubSubClient(bus = new Map()) {
  const client = {
    started: false,
    stopped: false,
    joinedGroups: new Set(),
    listeners: new Map(),
    sends: [],
    on(type, cb) {
      let handlers = this.listeners.get(type);
      if (!handlers) {
        handlers = new Set();
        this.listeners.set(type, handlers);
      }
      handlers.add(cb);
    },
    emit(type, e) {
      for (const cb of this.listeners.get(type) ?? []) cb(e);
    },
    async start() {
      this.started = true;
      queueMicrotask(() => this.emit("connected", { connectionId: "conn-1" }));
    },
    async joinGroup(group) {
      this.joinedGroups.add(group);
      if (!bus.has(group)) bus.set(group, new Set());
      bus.get(group).add(this);
    },
    async sendToGroup(group, content, dataType, options) {
      this.sends.push({ group, content, dataType, options });
      for (const target of bus.get(group) ?? []) {
        if (target === this && options?.noEcho) continue;
        target.emit("group-message", { message: { group, data: content, dataType } });
      }
    },
    async stop() {
      this.stopped = true;
      this.emit("stopped", {});
    },
  };
  return client;
}

test("connect starts the client and joins the weft group once", async () => {
  const client = createFakeWebPubSubClient();
  const transport = createWebPubSubTransport({ client, channelId: "pair-1" });

  await transport.connect();
  await transport.connect();

  assert.equal(client.started, true);
  assert.deepEqual([...client.joinedGroups], ["weft:pair-1"]);
});

test("publishes to a second transport on the same channel and event only", async () => {
  const bus = new Map();
  const sender = createWebPubSubTransport({
    client: createFakeWebPubSubClient(bus),
    channelId: "pair-2",
  });
  const receiver = createWebPubSubTransport({
    client: createFakeWebPubSubClient(bus),
    channelId: "pair-2",
  });

  const received = [];
  receiver.subscribe("stream", (msg) => received.push(["stream", msg]));
  receiver.subscribe("prompt", (msg) => received.push(["prompt", msg]));

  await Promise.all([sender.connect(), receiver.connect()]);
  await sender.publish("stream", envelope);
  await nextTick();

  assert.deepEqual(received, [["stream", envelope]]);
});

test("noEcho prevents a publisher from receiving its own broadcast", async () => {
  const transport = createWebPubSubTransport({
    client: createFakeWebPubSubClient(),
    channelId: "pair-3",
  });

  let received = false;
  transport.subscribe("stream", () => {
    received = true;
  });

  await transport.publish("stream", envelope);
  await nextTick();

  assert.equal(received, false);
});

test("unsubscribe stops delivery to that handler", async () => {
  const bus = new Map();
  const sender = createWebPubSubTransport({
    client: createFakeWebPubSubClient(bus),
    channelId: "pair-4",
  });
  const receiver = createWebPubSubTransport({
    client: createFakeWebPubSubClient(bus),
    channelId: "pair-4",
  });

  let count = 0;
  const unsubscribe = receiver.subscribe("stream", () => {
    count += 1;
  });

  await Promise.all([sender.connect(), receiver.connect()]);
  await sender.publish("stream", envelope);
  await nextTick();
  unsubscribe();
  await sender.publish("stream", envelope);
  await nextTick();

  assert.equal(count, 1);
});

test("publish after close throws", async () => {
  const transport = createWebPubSubTransport({
    client: createFakeWebPubSubClient(),
    channelId: "pair-5",
  });

  await transport.connect();
  await transport.close();

  await assert.rejects(
    () => transport.publish("stream", envelope),
    /weft\/transport-webpubsub: publish: transport is closed/
  );
});

test("onStatus reports connected after connect and disconnected on stop", async () => {
  const client = createFakeWebPubSubClient();
  const transport = createWebPubSubTransport({ client, channelId: "pair-status" });

  const seen = [];
  transport.onStatus((status) => seen.push(status));

  await transport.connect();
  await nextTick();
  assert.deepEqual(seen, ["connected"]);

  client.emit("disconnected", { message: "socket closed" });
  assert.deepEqual(seen, ["connected", "disconnected"]);
});

test("onStatus gives a late subscriber the current connected state", async () => {
  const client = createFakeWebPubSubClient();
  const transport = createWebPubSubTransport({ client, channelId: "pair-late" });

  await transport.connect();
  await nextTick();

  const seen = [];
  transport.onStatus((status) => seen.push(status));
  await nextTick();
  assert.deepEqual(seen, ["connected"]);
});

test("onStatus unsubscribe stops further status delivery", async () => {
  const client = createFakeWebPubSubClient();
  const transport = createWebPubSubTransport({ client, channelId: "pair-unsub" });

  const seen = [];
  const off = transport.onStatus((status) => seen.push(status));

  await transport.connect();
  await nextTick();
  off();
  client.emit("disconnected", {});
  assert.deepEqual(seen, ["connected"]);
});

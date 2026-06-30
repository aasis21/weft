import { test } from "node:test";
import assert from "node:assert/strict";

import { createSupabaseTransport } from "../transport-supabase.mjs";

const envelope = Object.freeze({ iv: "iv", ciphertext: "ciphertext", ts: 1 });

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createFakeSupabaseClient(bus = new Map()) {
  const client = {
    channels: [],
    removed: [],
    channel(name, opts) {
      const ch = {
        name,
        opts,
        handlers: [],
        sends: [],
        subscribeCalls: 0,
        subscribed: false,
        subscribe(cb) {
          this.subscribeCalls += 1;
          this.subscribed = true;
          if (!bus.has(name)) bus.set(name, new Set());
          bus.get(name).add(this);
          queueMicrotask(() => cb("SUBSCRIBED"));
          return this;
        },
        on(type, filter, cb) {
          this.handlers.push({ type, event: filter.event, cb });
          return this;
        },
        async send(message) {
          this.sends.push(message);
          const self = this.opts?.config?.broadcast?.self !== false;
          for (const target of bus.get(name) ?? []) {
            if (target === this && !self) continue;
            for (const handler of target.handlers) {
              if (handler.type !== message.type || handler.event !== message.event) continue;
              queueMicrotask(() => handler.cb(message));
            }
          }
          return "ok";
        },
      };
      this.channels.push(ch);
      return ch;
    },
    async removeChannel(ch) {
      this.removed.push(ch);
      bus.get(ch.name)?.delete(ch);
      return "ok";
    },
  };
  return client;
}

test("connect resolves after SUBSCRIBED and is idempotent", async () => {
  const client = createFakeSupabaseClient();
  const transport = createSupabaseTransport({ client, channelId: "pair-1" });

  await transport.connect();
  await transport.connect();

  assert.equal(client.channels.length, 1);
  assert.equal(client.channels[0].subscribeCalls, 1);
});

test("uses the expected private Helm channel name", () => {
  const client = createFakeSupabaseClient();
  createSupabaseTransport({ client, channelId: "abc123" });

  assert.equal(client.channels[0].name, "private:helm:abc123");
  assert.deepEqual(client.channels[0].opts, {
    config: { broadcast: { self: false, ack: true } },
  });
});

test("publishes to a second transport on the same channel and event only", async () => {
  const bus = new Map();
  const sender = createSupabaseTransport({
    client: createFakeSupabaseClient(bus),
    channelId: "pair-2",
  });
  const receiver = createSupabaseTransport({
    client: createFakeSupabaseClient(bus),
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

test("self:false prevents a publisher from receiving its own broadcast", async () => {
  const transport = createSupabaseTransport({
    client: createFakeSupabaseClient(),
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
  const sender = createSupabaseTransport({
    client: createFakeSupabaseClient(bus),
    channelId: "pair-4",
  });
  const receiver = createSupabaseTransport({
    client: createFakeSupabaseClient(bus),
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
  const transport = createSupabaseTransport({
    client: createFakeSupabaseClient(),
    channelId: "pair-5",
  });

  await transport.connect();
  await transport.close();

  await assert.rejects(
    () => transport.publish("stream", envelope),
    /helm\/transport-supabase: publish: transport is closed/
  );
});

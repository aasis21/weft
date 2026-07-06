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
          this.statusCb = cb;
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
              if (handler.type !== message.type) continue;
              // realtime-js delivers to bindings whose event is the message event or `*`.
              if (handler.event !== "*" && handler.event !== message.event) continue;
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

test("uses the expected private Weft channel name", () => {
  const client = createFakeSupabaseClient();
  createSupabaseTransport({ client, channelId: "abc123" });

  assert.equal(client.channels[0].name, "private:weft:abc123");
  assert.deepEqual(client.channels[0].opts, {
    config: { private: true, broadcast: { self: false, ack: true } },
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
    /weft\/transport-supabase: publish: transport is closed/
  );
});

test("onStatus reports connected on subscribe and disconnected on a live drop", async () => {
  const client = createFakeSupabaseClient();
  const transport = createSupabaseTransport({ client, channelId: "pair-status" });

  const seen = [];
  transport.onStatus((status) => seen.push(status));

  await transport.connect();
  await nextTick();
  assert.deepEqual(seen, ["connected"]);

  // Simulate a silent socket drop after we were live: realtime re-invokes the same status cb.
  client.channels[0].statusCb("CHANNEL_ERROR", new Error("socket closed"));
  assert.deepEqual(seen, ["connected", "disconnected"]);

  // And a rejoin restores connected.
  client.channels[0].statusCb("SUBSCRIBED");
  assert.deepEqual(seen, ["connected", "disconnected", "connected"]);
});

test("onStatus gives a late subscriber the current connected state", async () => {
  const client = createFakeSupabaseClient();
  const transport = createSupabaseTransport({ client, channelId: "pair-late" });

  await transport.connect();
  await nextTick();

  const seen = [];
  transport.onStatus((status) => seen.push(status));
  await nextTick();
  assert.deepEqual(seen, ["connected"]);
});

test("onStatus does not fire disconnected for a pre-subscribe failure", async () => {
  const client = createFakeSupabaseClient();
  // Make the first subscribe fail instead of succeeding.
  const realChannel = client.channel.bind(client);
  client.channel = (name, opts) => {
    const ch = realChannel(name, opts);
    ch.subscribe = function subscribe(cb) {
      this.subscribeCalls = (this.subscribeCalls ?? 0) + 1;
      this.statusCb = cb;
      queueMicrotask(() => cb("CHANNEL_ERROR", new Error("boom")));
      return this;
    };
    return ch;
  };
  const transport = createSupabaseTransport({ client, channelId: "pair-fail" });

  const seen = [];
  transport.onStatus((status) => seen.push(status));
  await assert.rejects(() => transport.connect());
  await nextTick();
  // Never became live, so there's no live-connection drop to report.
  assert.deepEqual(seen, []);
});

test("onStatus unsubscribe stops further status delivery", async () => {
  const client = createFakeSupabaseClient();
  const transport = createSupabaseTransport({ client, channelId: "pair-unsub" });

  const seen = [];
  const off = transport.onStatus((status) => seen.push(status));

  await transport.connect();
  await nextTick();
  off();
  client.channels[0].statusCb("CHANNEL_ERROR");
  assert.deepEqual(seen, ["connected"]);
});

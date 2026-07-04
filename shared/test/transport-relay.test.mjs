import { test } from "node:test";
import assert from "node:assert/strict";

import { createRelayTransport } from "../transport-relay.mjs";

const envelope = Object.freeze({ iv: "iv", ciphertext: "ciphertext", ts: 1 });

function nextTick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** A fake WebSocket-like object. `bus`, when shared between two fakes, lets sends on one
 * reach the other — simulating both ends of a relay/tunnel socket pair. */
function createFakeSocket(bus) {
  const socket = {
    readyState: 0, // CONNECTING
    listeners: new Map(),
    sent: [],
    peer: undefined,
    addEventListener(type, cb) {
      let handlers = this.listeners.get(type);
      if (!handlers) {
        handlers = new Set();
        this.listeners.set(type, handlers);
      }
      handlers.add(cb);
    },
    removeEventListener(type, cb) {
      this.listeners.get(type)?.delete(cb);
    },
    emit(type, e) {
      for (const cb of this.listeners.get(type) ?? []) cb(e);
    },
    send(data) {
      if (this.readyState !== 1) throw new Error("socket not open");
      this.sent.push(data);
      queueMicrotask(() => this.peer?.emit("message", { data }));
    },
    close() {
      if (this.readyState === 3) return;
      this.readyState = 3;
      this.emit("close", { reason: "closed" });
      this.peer?.emit("close", { reason: "peer closed" });
    },
    open() {
      this.readyState = 1;
      this.emit("open", {});
    },
  };
  if (bus) bus.push(socket);
  return socket;
}

function connectPair() {
  const a = createFakeSocket();
  const b = createFakeSocket();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

test("connect resolves once the socket reaches OPEN", async () => {
  const socket = createFakeSocket();
  const transport = createRelayTransport({ socket, channelId: "pair-1" });

  const connectPromise = transport.connect();
  socket.open();
  await connectPromise;

  assert.equal(socket.readyState, 1);
});

test("connect resolves immediately if the socket is already open", async () => {
  const socket = createFakeSocket();
  socket.open();
  const transport = createRelayTransport({ socket, channelId: "pair-1b" });

  await transport.connect();
});

test("publishes to a second transport on the same socket pair and event only", async () => {
  const [socketA, socketB] = connectPair();
  const sender = createRelayTransport({ socket: socketA, channelId: "pair-2" });
  const receiver = createRelayTransport({ socket: socketB, channelId: "pair-2" });

  const received = [];
  receiver.subscribe("stream", (msg) => received.push(["stream", msg]));
  receiver.subscribe("prompt", (msg) => received.push(["prompt", msg]));

  socketA.open();
  socketB.open();
  await Promise.all([sender.connect(), receiver.connect()]);
  await sender.publish("stream", envelope);
  await nextTick();

  assert.deepEqual(received, [["stream", envelope]]);
});

test("unsubscribe stops delivery to that handler", async () => {
  const [socketA, socketB] = connectPair();
  const sender = createRelayTransport({ socket: socketA, channelId: "pair-3" });
  const receiver = createRelayTransport({ socket: socketB, channelId: "pair-3" });

  let count = 0;
  const unsubscribe = receiver.subscribe("stream", () => {
    count += 1;
  });

  socketA.open();
  socketB.open();
  await Promise.all([sender.connect(), receiver.connect()]);
  await sender.publish("stream", envelope);
  await nextTick();
  unsubscribe();
  await sender.publish("stream", envelope);
  await nextTick();

  assert.equal(count, 1);
});

test("publish after close throws", async () => {
  const socket = createFakeSocket();
  socket.open();
  const transport = createRelayTransport({ socket, channelId: "pair-4" });

  await transport.connect();
  await transport.close();

  await assert.rejects(
    () => transport.publish("stream", envelope),
    /helm\/transport-relay: publish: transport is closed/
  );
});

test("onStatus reports connected after connect and disconnected on socket close", async () => {
  const socket = createFakeSocket();
  const transport = createRelayTransport({ socket, channelId: "pair-status" });

  const seen = [];
  transport.onStatus((status) => seen.push(status));

  const connectPromise = transport.connect();
  socket.open();
  await connectPromise;
  await nextTick();
  assert.deepEqual(seen, ["connected"]);

  socket.emit("close", { reason: "dropped" });
  assert.deepEqual(seen, ["connected", "disconnected"]);
});

test("onStatus gives a late subscriber the current connected state", async () => {
  const socket = createFakeSocket();
  socket.open();
  const transport = createRelayTransport({ socket, channelId: "pair-late" });

  await transport.connect();

  const seen = [];
  transport.onStatus((status) => seen.push(status));
  await nextTick();
  assert.deepEqual(seen, ["connected"]);
});

test("onStatus unsubscribe stops further status delivery", async () => {
  const socket = createFakeSocket();
  const transport = createRelayTransport({ socket, channelId: "pair-unsub" });

  const seen = [];
  const off = transport.onStatus((status) => seen.push(status));

  const connectPromise = transport.connect();
  socket.open();
  await connectPromise;
  off();
  socket.emit("close", {});
  assert.deepEqual(seen, ["connected"]);
});

test("connect rejects if the socket errors before opening", async () => {
  const socket = createFakeSocket();
  const transport = createRelayTransport({ socket, channelId: "pair-err" });

  const connectPromise = transport.connect();
  socket.emit("error", { message: "ECONNREFUSED" });

  await assert.rejects(
    () => connectPromise,
    /helm\/transport-relay: connect failed: ECONNREFUSED/
  );
});

test("throws when constructed without a valid socket", () => {
  assert.throws(
    () => createRelayTransport({ socket: {}, channelId: "pair-bad" }),
    /helm\/transport-relay: socket with send\(\)\/addEventListener\(\) is required/
  );
  assert.throws(
    () => createRelayTransport({ socket: { send() {}, addEventListener() {} } }),
    /helm\/transport-relay: channelId is required/
  );
});

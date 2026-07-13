// SPDX-License-Identifier: Apache-2.0
import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createReconnectingSocket } from "../src/reconnectingSocket.mjs";

// Minimal fake matching the `ws` addEventListener/send/close/readyState/ping surface the wrapper
// drives. Every instance records itself so a test can grab "the socket the wrapper just opened".
const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSED = 3;

let instances;

class FakeWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = WS_CONNECTING;
    this.sent = [];
    this.pings = 0;
    this.handlers = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
    instances.push(this);
  }
  addEventListener(type, handler) {
    this.handlers[type]?.add(handler);
  }
  removeEventListener(type, handler) {
    this.handlers[type]?.delete(handler);
  }
  send(data) {
    this.sent.push(data);
  }
  ping() {
    this.pings += 1;
  }
  close() {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSED;
    this._fire("close", { reason: "closed" });
  }
  _fire(type, event) {
    for (const h of this.handlers[type] ?? []) h(event);
  }
  // Test helpers
  _open() {
    this.readyState = WS_OPEN;
    this._fire("open", {});
  }
  _drop(reason = "idle") {
    this.readyState = WS_CLOSED;
    this._fire("close", { reason });
  }
}

beforeEach(() => {
  instances = [];
});

afterEach(() => {
  instances = [];
});

test("connects immediately and forwards open/message to registered listeners", () => {
  const sock = createReconnectingSocket("wss://relay/?channelId=abc", { WebSocketImpl: FakeWebSocket });
  assert.equal(instances.length, 1);
  assert.equal(instances[0].url, "wss://relay/?channelId=abc");

  let opened = false;
  const messages = [];
  sock.addEventListener("open", () => (opened = true));
  sock.addEventListener("message", (e) => messages.push(e.data));

  instances[0]._open();
  assert.equal(opened, true);
  assert.equal(sock.readyState, WS_OPEN);

  instances[0]._fire("message", { data: "hello" });
  assert.deepEqual(messages, ["hello"]);

  sock.close();
});

test("send throws when not open, delegates to the live socket when open", () => {
  const sock = createReconnectingSocket("wss://relay", { WebSocketImpl: FakeWebSocket });
  assert.throws(() => sock.send("x"), /not open/);

  instances[0]._open();
  sock.send("payload");
  assert.deepEqual(instances[0].sent, ["payload"]);

  sock.close();
});

test("reconnects with a fresh socket after the underlying connection drops", async () => {
  const sock = createReconnectingSocket("wss://relay/?channelId=abc", {
    WebSocketImpl: FakeWebSocket,
    minBackoffMs: 5,
    maxBackoffMs: 5,
  });

  const opens = [];
  sock.addEventListener("open", () => opens.push(Date.now()));

  instances[0]._open();
  assert.equal(opens.length, 1);

  // Tunnel/relay drops the idle socket — wrapper must schedule a reconnect and build a new socket.
  instances[0]._drop("idle timeout");
  assert.equal(instances.length, 1, "reconnect is scheduled, not synchronous");

  await new Promise((r) => setTimeout(r, 15));
  assert.equal(instances.length, 2, "a replacement socket was created");
  assert.equal(instances[1].url, "wss://relay/?channelId=abc", "reconnects to the same room URL");

  instances[1]._open();
  assert.equal(opens.length, 2, "re-emits open on the new socket so the transport self-heals");

  sock.close();
});

test("pings the live socket on the keepalive interval to keep the tunnel warm", async () => {
  const sock = createReconnectingSocket("wss://relay", {
    WebSocketImpl: FakeWebSocket,
    pingIntervalMs: 5,
  });
  instances[0]._open();

  await new Promise((r) => setTimeout(r, 18));
  assert.ok(instances[0].pings >= 2, `expected multiple keepalive pings, got ${instances[0].pings}`);

  sock.close();
});

test("close() stops reconnecting and pinging", async () => {
  const sock = createReconnectingSocket("wss://relay", {
    WebSocketImpl: FakeWebSocket,
    minBackoffMs: 5,
    maxBackoffMs: 5,
    pingIntervalMs: 5,
  });
  instances[0]._open();
  sock.close();

  const socketsAfterClose = instances.length;
  const pingsAfterClose = instances[0].pings;

  // A late close event from the (already user-closed) socket must NOT spawn a reconnect.
  instances[0]._drop("late");
  await new Promise((r) => setTimeout(r, 20));

  assert.equal(instances.length, socketsAfterClose, "no reconnect after close()");
  assert.equal(instances[0].pings, pingsAfterClose, "no pings after close()");
});

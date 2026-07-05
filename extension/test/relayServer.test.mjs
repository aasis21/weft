// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startRelayServer } from "../src/relayServer.mjs";

function connect(port, channelId) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/?channelId=${channelId}`);
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
}

function nextMessage(ws) {
  return new Promise((resolve) => ws.once("message", (data) => resolve(data.toString())));
}

test("relays a message from one peer to the other peer in the same channel", async () => {
  const relay = startRelayServer();
  await relay.ready;
  const a = await connect(relay.port, "chan-1");
  const b = await connect(relay.port, "chan-1");

  const received = nextMessage(b);
  a.send("hello");
  assert.equal(await received, "hello");

  a.close();
  b.close();
  await relay.close();
});

test("does not echo a message back to its own sender", async () => {
  const relay = startRelayServer();
  await relay.ready;
  const a = await connect(relay.port, "chan-echo");
  let echoed = false;
  a.on("message", () => {
    echoed = true;
  });
  a.send("ping");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(echoed, false);
  a.close();
  await relay.close();
});

test("isolates rooms by channelId", async () => {
  const relay = startRelayServer();
  await relay.ready;
  const a = await connect(relay.port, "room-a");
  const c = await connect(relay.port, "room-c");
  let received = false;
  c.on("message", () => {
    received = true;
  });
  a.send("should not cross rooms");
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(received, false);
  a.close();
  c.close();
  await relay.close();
});

test("rejects a connection with no channelId", async () => {
  const relay = startRelayServer();
  await relay.ready;
  const ws = new WebSocket(`ws://127.0.0.1:${relay.port}/`);
  const closeCode = await new Promise((resolve) => ws.once("close", (code) => resolve(code)));
  assert.equal(closeCode, 1008);
  await relay.close();
});

test("totalConnections reflects sockets across all rooms combined", async () => {
  const relay = startRelayServer();
  await relay.ready;
  assert.equal(relay.totalConnections(), 0);
  const a = await connect(relay.port, "room-x");
  const b = await connect(relay.port, "room-y");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.totalConnections(), 2);
  a.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.totalConnections(), 1);
  b.close();
  await relay.close();
});

test("roomSize tracks connect/disconnect and drops empty rooms", async () => {
  const relay = startRelayServer();
  await relay.ready;
  const a = await connect(relay.port, "chan-size");
  const b = await connect(relay.port, "chan-size");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.roomSize("chan-size"), 2);
  a.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.roomSize("chan-size"), 1);
  b.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(relay.roomSize("chan-size"), 0);
  await relay.close();
});

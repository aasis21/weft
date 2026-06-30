// E2E round-trip of the history-backfill protocol through the real SecureChannel +
// LocalTransport stack: a phone requests history on CONTROL, the ext answers on
// CONTROL, and a terminal user.message reaches the phone on STREAM — all encrypted.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair, deriveSessionKey, randomChannelId } from "../crypto.mjs";
import { SecureChannel } from "../channel.mjs";
import { createLocalTransport, _resetLocalBus } from "../transport-local.mjs";
import { EVENTS, historyRequest, history, userMessage } from "../messages.mjs";

async function pair() {
  _resetLocalBus();
  const channelId = randomChannelId();
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
  return { extChan, phoneChan };
}

test("history request/response round-trips over CONTROL", async () => {
  const { extChan, phoneChan } = await pair();

  // ext waits for the phone's request, then answers with a page.
  const gotReqOnExt = new Promise((resolve) => {
    extChan.onEvent(EVENTS.CONTROL, (msg) => {
      if (msg.kind === "control.history_request") resolve(msg);
    });
  });
  const gotHistoryOnPhone = new Promise((resolve) => {
    phoneChan.onEvent(EVENTS.CONTROL, (msg) => {
      if (msg.kind === "control.history") resolve(msg);
    });
  });

  await phoneChan.send(historyRequest(null, 50));
  const req = await gotReqOnExt;
  assert.equal(req.before, null);
  assert.equal(req.limit, 50);
  assert.equal(req.deviceId, "phone");

  const items = [
    { turnIndex: 0, role: "user", text: "first", ts: 1 },
    { turnIndex: 0, role: "assistant", text: "reply", ts: 2 },
  ];
  await extChan.send(history(items, null, false));
  const page = await gotHistoryOnPhone;
  assert.equal(page.kind, "control.history");
  assert.deepEqual(page.items, items);
  assert.equal(page.hasMore, false);
  assert.equal(page.deviceId, "laptop");

  await extChan.close();
  await phoneChan.close();
});

test("terminal user.message reaches the phone on STREAM with origin", async () => {
  const { extChan, phoneChan } = await pair();

  const gotOnPhone = new Promise((resolve) => {
    phoneChan.onEvent(EVENTS.STREAM, (msg) => {
      if (msg.kind === "stream.user_message") resolve(msg);
    });
  });

  await extChan.send(userMessage("typed at the laptop", "terminal", "evt-9"));
  const echo = await gotOnPhone;
  assert.equal(echo.text, "typed at the laptop");
  assert.equal(echo.origin, "terminal");
  assert.equal(echo.id, "evt-9");
  assert.equal(echo.deviceId, "laptop");

  await extChan.close();
  await phoneChan.close();
});

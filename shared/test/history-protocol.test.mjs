// E2E round-trip of the history-backfill protocol through the real SecureChannel +
// LocalTransport stack: a phone requests history on CONTROL, the ext answers on
// CONTROL, and a terminal user.message reaches the phone on STREAM — all encrypted.
// Messages are the standardized envelope: routed by (eventType, eventSubtype), payload under `msg`.

import { test } from "node:test";
import assert from "node:assert/strict";

import { generateKeyPair, deriveSessionKey, randomChannelId } from "../crypto.mjs";
import { SecureChannel } from "../channel.mjs";
import { createLocalTransport, _resetLocalBus } from "../transport-local.mjs";
import { EVENT_TYPE, SUBTYPE, historyRequest, history, userMessage } from "../messages.mjs";

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
    identity: { senderId: "copilot", senderName: "Copilot", sessionId: "s1", channelId },
  });
  const phoneChan = new SecureChannel({
    transport: createLocalTransport({ channelId }),
    key: phoneKey,
    identity: { senderId: "phone-1", senderName: "App", sessionId: "s1", channelId },
  });
  return { extChan, phoneChan };
}

test("history request/response round-trips over CONTROL", async () => {
  const { extChan, phoneChan } = await pair();

  // ext waits for the phone's request, then answers with a page.
  const gotReqOnExt = new Promise((resolve) => {
    extChan.onEvent(EVENT_TYPE.CONTROL, (msg) => {
      if (msg.eventSubtype === SUBTYPE.CONTROL.HISTORY_REQUEST) resolve(msg);
    });
  });
  const gotHistoryOnPhone = new Promise((resolve) => {
    phoneChan.onEvent(EVENT_TYPE.CONTROL, (msg) => {
      if (msg.eventSubtype === SUBTYPE.CONTROL.HISTORY) resolve(msg);
    });
  });

  await phoneChan.send(historyRequest(null, 50));
  const req = await gotReqOnExt;
  assert.equal(req.msg.before, null);
  assert.equal(req.msg.limit, 50);
  assert.equal(req.senderId, "phone-1");

  const items = [
    { turnIndex: 0, role: "user", text: "first", ts: 1 },
    { turnIndex: 0, role: "assistant", text: "reply", ts: 2 },
  ];
  await extChan.send(history(items, null, false));
  const page = await gotHistoryOnPhone;
  assert.equal(page.eventSubtype, SUBTYPE.CONTROL.HISTORY);
  assert.deepEqual(page.msg.items, items);
  assert.equal(page.msg.hasMore, false);
  assert.equal(page.senderId, "copilot");

  await extChan.close();
  await phoneChan.close();
});

test("terminal user.message reaches the phone on STREAM with origin", async () => {
  const { extChan, phoneChan } = await pair();

  const gotOnPhone = new Promise((resolve) => {
    phoneChan.onEvent(EVENT_TYPE.STREAM, (msg) => {
      if (msg.eventSubtype === SUBTYPE.STREAM.USER_MESSAGE) resolve(msg);
    });
  });

  await extChan.send(userMessage("typed at the laptop", "terminal", "evt-9"));
  const echo = await gotOnPhone;
  assert.equal(echo.msg.text, "typed at the laptop");
  assert.equal(echo.msg.origin, "terminal");
  assert.equal(echo.msg.id, "evt-9");
  assert.equal(echo.senderId, "copilot");

  await extChan.close();
  await phoneChan.close();
});

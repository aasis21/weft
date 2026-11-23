// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTrafficLog } from "../src/trafficLog.mjs";

function clock(start = 1_000_000) {
  let value = start;
  return { now: () => value, advance: (ms) => { value += ms; } };
}
const control = (eventSubtype, msg = {}) => ({ eventType: "control", eventSubtype, msg });

test("traffic keeps event identifiers, timing and size but never message content", () => {
  const time = clock();
  const log = createTrafficLog({ now: time.now, enabled: () => true });
  log.observe({ direction: "in", ok: true, payload: { iv: "abcd", ct: "x".repeat(96) },
    message: { eventType: "prompt", eventSubtype: "prompt", msg: { text: "private prompt C:\\secret\\path token=abc" } } });
  log.observe({ direction: "out", ok: true, payload: { ct: "y".repeat(20) },
    message: { eventType: "stream", eventSubtype: "assistant_message", msg: { text: "private answer" } } });
  log.observe({ direction: "in", ok: true, payload: { ct: "z" }, message: { eventType: "control", eventSubtype: "made_up", msg: { secret: "x" } } });
  const entries = log.snapshot();
  assert.deepEqual(entries.map((e) => [e.direction, e.event, e.bytes]), [
    ["in", "Prompt", 100], ["out", "Assistant reply", 20], ["in", "Other message", 1],
  ]);
  assert.ok(!JSON.stringify(entries).includes("private"));
  assert.ok(!JSON.stringify(entries).includes("secret"));
});

test("requests are paired with replies, and missing or failed replies are problems", () => {
  const time = clock();
  const log = createTrafficLog({ now: time.now, enabled: () => true });
  log.observe({ direction: "in", ok: true, message: control("session_list_request") });
  time.advance(6100);
  log.observe({ direction: "out", ok: true, message: control("session_list") });
  log.observe({ direction: "in", ok: true, message: control("open_session") });
  log.observe({ direction: "out", ok: true, message: control("lifecycle_status", { outcome: "failed", result: { message: "private reason" } }) });
  log.observe({ direction: "in", ok: true, message: control("history_request") });
  log.observe({ direction: "out", ok: false, message: control("project_list") });
  time.advance(61_000);
  const byEvent = Object.fromEntries(log.snapshot().map((e) => [e.event, e]));
  assert.equal(byEvent["Session list requested"].result, "replied");
  assert.equal(byEvent["Session list requested"].replyMs, 6100);
  assert.equal(byEvent["Open session"].result, "failed");
  assert.equal(byEvent["Launch status"].result, "failed");
  assert.equal(byEvent["History requested"].result, "no-reply");
  assert.equal(byEvent["Project list"].result, "failed");
  assert.ok(!JSON.stringify(log.snapshot()).includes("private"));
});

test("high-frequency events are grouped and the view is bounded to the newest entries", () => {
  const time = clock();
  const log = createTrafficLog({ now: time.now, capacity: 5, enabled: () => true });
  for (let i = 0; i < 12; i++) {
    log.observe({ direction: "out", ok: true, payload: { ct: "aa" }, message: control("device_heartbeat") });
    time.advance(1000);
  }
  let [heartbeat] = log.snapshot();
  assert.equal(heartbeat.count, 12);
  assert.equal(heartbeat.bytes, 24);
  assert.equal(heartbeat.heartbeat, true);
  for (let i = 0; i < 8; i++) log.observe({ direction: "in", ok: true, message: control("mode") });
  const entries = log.snapshot();
  assert.equal(entries.length, 5);
  assert.ok(entries.every((entry) => entry.event === "Mode change"));
  log.note("phone_disconnected");
  assert.equal(log.snapshot().at(-1).event, "Phone connection lost");
});

test("turning local diagnostics off stops recording without breaking delivery", () => {
  const time = clock();
  let enabled = true;
  const log = createTrafficLog({ now: time.now, enabled: () => enabled });
  log.observe({ direction: "in", ok: true, message: control("mode") });
  enabled = false;
  time.advance(6000);
  log.observe({ direction: "in", ok: true, message: control("interrupt") });
  log.observe({ direction: "out", ok: true, message: null });
  assert.deepEqual(log.snapshot().map((entry) => entry.event), ["Mode change"]);
  const failing = createTrafficLog({ now: time.now, enabled: () => { throw new Error("bad config"); } });
  failing.observe({ direction: "in", ok: true, message: control("mode") });
  assert.deepEqual(failing.snapshot(), []);
});

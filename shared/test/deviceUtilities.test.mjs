import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CLIPBOARD_MAX_BYTES, DEVICE_CAPABILITY, KEEP_AWAKE_MIN_MS, KEEP_AWAKE_MAX_MS,
  clipboardRead, clipboardWrite, clipboardResult, clipboardTextError,
  keepAwakeStart, keepAwakeStop, keepAwakeStatusRequest, keepAwakeStatus, deviceSnapshot, isValidEnvelope,
} from "../messages.mjs";

test("utilities advertise independent additive capabilities and correlated envelopes", () => {
  assert.equal(DEVICE_CAPABILITY.MONITOR_V1, "device-monitor-v1");
  assert.equal(DEVICE_CAPABILITY.CLIPBOARD_V1, "device-clipboard-v1");
  assert.equal(DEVICE_CAPABILITY.KEEP_AWAKE_V1, "device-keep-awake-v1");
  for (const message of [
    clipboardRead("r"), clipboardWrite("r", ""), clipboardResult("r", "read", "ok", ""),
    keepAwakeStart("r", "lease", KEEP_AWAKE_MIN_MS), keepAwakeStop("r", "lease"),
    keepAwakeStatusRequest("r"), keepAwakeStatus("r"),
  ]) {
    assert.equal(message.msg.requestId, "r");
    assert.equal(message.eventType, "control");
    assert.equal(isValidEnvelope(message), true);
  }
});

test("clipboard preserves exact plain text and bounds UTF-8 rather than characters", () => {
  const text = "\uFEFFline\r\n\u{1f600} '\" $() \0";
  assert.equal(clipboardWrite("r", text).msg.text, text);
  assert.equal(clipboardTextError("\u{1f600}".repeat(CLIPBOARD_MAX_BYTES / 4)), null);
  assert.equal(clipboardTextError("\u{1f600}".repeat(CLIPBOARD_MAX_BYTES / 4) + "x"), "too-large");
  assert.equal(clipboardTextError(null), "invalid-request");
  assert.throws(() => clipboardWrite("r", "x".repeat(CLIPBOARD_MAX_BYTES + 1)), /^RangeError: too-large$/);
});

test("results never echo writes, failed reads, unknown errors or oversized text", () => {
  assert.equal(clipboardResult("r", "write", "ok", "secret").msg.text, undefined);
  assert.equal(clipboardResult("r", "read", "unavailable", "secret").msg.text, undefined);
  assert.deepEqual(clipboardResult("r", "read", "raw secret error", "secret").msg, {
    requestId: "r", operation: "read", code: "unavailable",
  });
  assert.equal(clipboardResult("r", "read", "ok", "x".repeat(CLIPBOARD_MAX_BYTES + 1)).msg.code, "too-large");
  assert.equal(clipboardResult("r", "read", "ok", null).msg.code, "invalid-request");
});

test("Keep Awake durations clamp to 15 minutes through eight hours with invalid values rejected", () => {
  assert.equal(keepAwakeStart("r", "l", 1).msg.durationMs, KEEP_AWAKE_MIN_MS);
  assert.equal(keepAwakeStart("r", "l", KEEP_AWAKE_MAX_MS + 1).msg.durationMs, KEEP_AWAKE_MAX_MS);
  for (const value of [NaN, Infinity, -1, 0, "900000"]) {
    assert.throws(() => keepAwakeStart("r", "l", value), /^RangeError: invalid-request$/);
  }
  assert.deepEqual(keepAwakeStatus(null, { active: true, leaseId: "l", expiresAt: 123, revision: 2 }).msg, {
    requestId: null, leaseId: "l", active: true, expiresAt: 123, revision: 2, code: "ok",
  });
  assert.equal(keepAwakeStatus("r", { active: true, expiresAt: NaN }).msg.active, false);
});

test("power is additive, normalizes unknown states, and preserves uptime", () => {
  for (const [input, expected] of [[true, true], [false, false], [undefined, null], [1, null]]) {
    const snapshot = deviceSnapshot({ system: { uptimeSeconds: 100, onAcPower: input } });
    assert.equal(snapshot.msg.system.onAcPower, expected);
    assert.equal(snapshot.msg.system.uptimeSeconds, 100);
    assert.equal(snapshot.msg.schemaVersion, 1);
  }
});

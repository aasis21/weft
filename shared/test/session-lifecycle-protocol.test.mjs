import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEVICE_CAPABILITY,
  EVENT_TYPE,
  LIFECYCLE_MESSAGE_MAX_BYTES,
  PROTOCOL_VERSION,
  SUBTYPE,
  endpointUpdate,
  latestLifecycleStatus,
  lifecycleCancel,
  lifecycleStatus,
  lifecycleStatusRequest,
  openRequestFingerprint,
  openSession,
  sessionHealthMsg,
  sessionHealthRequest,
  takeoverConfirm,
  updateRequired,
} from "../messages.mjs";

test("Station advertises session activation under a frozen capability name", () => {
  assert.equal(DEVICE_CAPABILITY.SESSION_ACTIVATION_V1, "session-activation-v1");
  assert.ok(Object.isFrozen(DEVICE_CAPABILITY));
});

test("v3 openSession carries only a target and options; Station chooses the mechanism", () => {
  const existing = openSession({
    requestId: " req-1 ",
    target: { sessionId: " session-1 ", storeAuthority: " sha256:store ", project: "ignored" },
    options: { permissionMode: "allow-all", title: " weft updates " },
    action: "resume",
  });
  assert.equal(existing.eventType, EVENT_TYPE.CONTROL);
  assert.equal(existing.eventSubtype, SUBTYPE.CONTROL.OPEN_SESSION);
  assert.deepEqual(existing.msg, {
    requestId: "req-1",
    target: { sessionId: "session-1", storeAuthority: "sha256:store" },
    options: { permissionMode: "allow-all", title: "weft updates" },
  });

  assert.deepEqual(openSession({ requestId: "req-2", target: { project: " weft " } }).msg, {
    requestId: "req-2",
    target: { project: "weft" },
    options: { permissionMode: "default", title: null },
  });
  assert.deepEqual(openSession({ requestId: "req-3", target: { sessionId: "s" }, options: { permissionMode: "yolo" } }).msg, {
    requestId: "req-3",
    target: { sessionId: "s" },
    options: { permissionMode: "default", title: null },
  });
  assert.throws(
    () => openSession({ requestId: "big", target: { project: "x".repeat(LIFECYCLE_MESSAGE_MAX_BYTES) } }),
    /^RangeError: too-large$/,
  );
});

test("v3 request fingerprints ignore requestId and formatting but bind target, options and requester", async () => {
  const first = openSession({ requestId: "delivery-1", target: { project: " weft " }, options: { title: " feature " } });
  const redelivered = openSession({ requestId: "delivery-2", target: { project: "weft" }, options: { title: "feature" } });
  const fingerprint = await openRequestFingerprint(first, "phone:1");
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await openRequestFingerprint(redelivered.msg, "phone:1"), fingerprint);
  assert.notEqual(await openRequestFingerprint(first, "phone:2"), fingerprint);
  assert.notEqual(
    await openRequestFingerprint(openSession({ requestId: "delivery-1", target: { project: "weft" }, options: { permissionMode: "allow-all", title: "feature" } }), "phone:1"),
    fingerprint,
  );
});

test("v3 lifecycle status reports stage, outcome, reason and a whitelisted result", () => {
  const status = lifecycleStatus({
    requestId: "req-1",
    revision: 4,
    stage: "awaiting-confirmation",
    outcome: null,
    reason: "controller-conflict",
    result: {
      action: "takeover",
      sessionId: "session-1",
      runtimeId: "runtime-1",
      pid: 13972,
      challenge: { challengeId: "ch-1", runtimeId: "runtime-1", controllerRevision: 2, controllerName: "Pixel" },
      identityFile: "C:/secret/identity.json",
      capability: "secret",
    },
  });
  assert.equal(status.eventSubtype, SUBTYPE.CONTROL.LIFECYCLE_STATUS);
  assert.deepEqual(status.msg, {
    requestId: "req-1",
    revision: 4,
    stage: "awaiting-confirmation",
    outcome: null,
    reason: "controller-conflict",
    result: {
      action: "takeover",
      sessionId: "session-1",
      runtimeId: "runtime-1",
      pid: 13972,
      challenge: { challengeId: "ch-1", runtimeId: "runtime-1", controllerRevision: 2, controllerName: "Pixel" },
    },
  });

  const cancelled = lifecycleStatus({
    requestId: "req-2",
    stage: "awaiting-runtime",
    outcome: "cancelled",
    result: { mayBeRunning: true, action: "launch-anyway", challenge: { challengeId: "no-runtime" } },
  });
  assert.deepEqual(cancelled.msg, {
    requestId: "req-2",
    revision: 0,
    stage: "awaiting-runtime",
    outcome: "cancelled",
    reason: null,
    result: { mayBeRunning: true },
  });

  const malformed = lifecycleStatus({ requestId: "req-3", stage: "launching", outcome: "open", reason: "weird", result: {} });
  assert.deepEqual(
    [malformed.msg.stage, malformed.msg.outcome, malformed.msg.reason, malformed.msg.result],
    ["accepted", null, "internal-error", null],
  );
});

test("v3 request follow-ups are keyed by requestId and the newest revision wins", () => {
  assert.deepEqual(lifecycleStatusRequest(" req-1 ").msg, { requestId: "req-1" });
  assert.deepEqual(takeoverConfirm("req-1", "ch-1", 7).msg, { requestId: "req-1", challengeId: "ch-1", revision: 7 });
  assert.deepEqual(lifecycleCancel("req-1", 7).msg, { requestId: "req-1", revision: 7 });
  assert.deepEqual(lifecycleCancel("req-1", -1).msg, { requestId: "req-1" });

  const older = lifecycleStatus({ requestId: "req-1", revision: 1, stage: "resolving" });
  const newer = lifecycleStatus({ requestId: "req-1", revision: 2, stage: "dispatching" });
  const other = lifecycleStatus({ requestId: "req-2", revision: 0, stage: "accepted" });
  assert.equal(latestLifecycleStatus(newer, older), newer);
  assert.equal(latestLifecycleStatus(older, newer), newer);
  assert.equal(latestLifecycleStatus(newer, other), other);
});

test("session health, endpoint and version notices normalize to what the phone can render", () => {
  assert.deepEqual(sessionHealthRequest(" session-1 ").msg, { sessionId: "session-1" });
  const health = sessionHealthMsg({
    sessionId: "session-1",
    label: "stalled",
    reason: "link-stuck",
    freshAt: 123,
    runtimeId: "runtime-1",
  });
  assert.equal(health.eventSubtype, SUBTYPE.CONTROL.SESSION_HEALTH);
  assert.deepEqual(health.msg, {
    sessionId: "session-1",
    label: "stalled",
    reason: "link-stuck",
    freshAt: 123,
    observer: "station",
    runtimeId: "runtime-1",
  });
  assert.deepEqual(sessionHealthMsg({ sessionId: "s", label: "mystery", reason: "bad", freshAt: NaN, observer: "x" }).msg, {
    sessionId: "s",
    label: "stalled",
    reason: null,
    freshAt: null,
    observer: "station",
  });

  const descriptor = { kind: "devtunnel", url: "https://abc-8080.usw2.devtunnels.ms" };
  const endpoint = endpointUpdate({ endpointRevision: 3, descriptor });
  assert.equal(endpoint.eventSubtype, SUBTYPE.CONTROL.ENDPOINT_UPDATE);
  assert.deepEqual(endpoint.msg, { endpointRevision: 3, descriptor });
  assert.deepEqual(endpointUpdate({ endpointRevision: -2, descriptor: "nope" }).msg, { endpointRevision: 0, descriptor: null });

  const notice = updateRequired({ peerVersion: 2, side: "laptop" });
  assert.equal(notice.eventSubtype, SUBTYPE.CONTROL.UPDATE_REQUIRED);
  assert.deepEqual(notice.msg, { minVersion: PROTOCOL_VERSION, peerVersion: 2, side: "laptop" });
  assert.deepEqual(updateRequired({ minVersion: 0, side: "phone" }).msg, { minVersion: PROTOCOL_VERSION, peerVersion: null, side: "phone" });
});

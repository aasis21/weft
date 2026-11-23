import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEVICE_CAPABILITY,
  EVENT_TYPE,
  LIFECYCLE_ACTIONS,
  LIFECYCLE_FAILURE_CODES,
  LIFECYCLE_MESSAGE_MAX_BYTES,
  LIFECYCLE_RETENTION_MS,
  LIFECYCLE_STATES,
  PROTOCOL_VERSION,
  SESSION_ACTIVATION_CAPABILITY,
  SUBTYPE,
  endpointUpdate,
  latestLifecycleStatus,
  launchStatus,
  lifecycleCancel,
  lifecycleStatus,
  lifecycleStatusFromLegacy,
  lifecycleStatusRequest,
  lifecycleStatusToLegacy,
  openIntentFingerprint,
  openRequestFingerprint,
  openSession,
  openSessionFromLegacy,
  openSessionToLegacy,
  resumeSession,
  sessionHealthMsg,
  sessionHealthRequest,
  spawnSession,
  takeoverConfirm,
  updateRequired,
} from "../messages.mjs";

test("session activation publishes additive constants and structured lifecycle values", () => {
  assert.equal(SESSION_ACTIVATION_CAPABILITY, "session-activation-v1");
  assert.equal(DEVICE_CAPABILITY.SESSION_ACTIVATION_V1, SESSION_ACTIVATION_CAPABILITY);
  assert.equal(LIFECYCLE_RETENTION_MS, 3 * 24 * 60 * 60 * 1000);
  assert.ok(Object.isFrozen(DEVICE_CAPABILITY));
  assert.ok(LIFECYCLE_STATES.includes("activating"));
  assert.ok(LIFECYCLE_STATES.includes("pairing-ready"));
  assert.ok(LIFECYCLE_FAILURE_CODES.includes("ownership-unknown"));
  assert.ok(LIFECYCLE_FAILURE_CODES.includes("operation-stale"));
  assert.ok(LIFECYCLE_FAILURE_CODES.includes("target-reserved"));
  assert.ok(LIFECYCLE_FAILURE_CODES.includes("project-not-found"));
  assert.ok(LIFECYCLE_FAILURE_CODES.includes("identity-failed"));
  assert.ok(LIFECYCLE_FAILURE_CODES.includes("launch-outcome-unknown"));
  assert.ok(LIFECYCLE_FAILURE_CODES.includes("launch-not-recoverable"));
  assert.ok(LIFECYCLE_ACTIONS.includes("confirm-takeover"));
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

test("deprecated v2 intent fingerprints stay canonical for remaining legacy callers", async () => {
  const first = { operationId: "delivery-1", target: { kind: "new", projectName: " weft " }, mode: "allow-all", name: " feature " };
  const duplicate = { operationId: "delivery-2", target: { projectName: "weft", kind: "new" }, name: "feature", mode: "allow-all" };
  const conflicting = { ...first, target: { kind: "new", projectName: "other" } };

  const firstFingerprint = await openIntentFingerprint(first);
  assert.match(firstFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(await openIntentFingerprint(duplicate), firstFingerprint);
  assert.notEqual(await openIntentFingerprint(conflicting), firstFingerprint);
});
test("legacy Start and Resume messages round-trip through generic Open", () => {
  const legacyStart = spawnSession("start-1", "weft", "allow-all", "feature");
  const genericStart = openSessionFromLegacy(legacyStart);
  assert.equal(genericStart.eventSubtype, SUBTYPE.CONTROL.OPEN_SESSION);
  assert.deepEqual(genericStart.msg.target, { kind: "new", projectName: "weft" });
  assert.deepEqual(openSessionToLegacy(genericStart).msg, legacyStart.msg);

  const legacyResume = resumeSession("resume-1", "session-1", "default", true);
  const genericResume = openSessionFromLegacy(legacyResume);
  assert.deepEqual(genericResume.msg.target, {
    kind: "existing",
    storeAuthority: null,
    sessionId: "session-1",
  });
  assert.equal(genericResume.msg.takeoverRequested, true);
  assert.deepEqual(openSessionToLegacy(genericResume).msg, legacyResume.msg);
  assert.equal(openSessionFromLegacy({ eventType: "control", eventSubtype: "unknown", msg: {} }), null);
});

test("legacy launch replies project to monotonic lifecycle revisions and back", () => {
  const accepted = lifecycleStatusFromLegacy(launchStatus("op-1", "accepted", {
    operation: "resume",
    sessionId: "session-1",
    createdAt: 10,
  }));
  const ready = lifecycleStatusFromLegacy(launchStatus("op-1", "ready", {
    operation: "resume",
    sessionId: "session-1",
    readyAt: 20,
  }), accepted);

  assert.equal(accepted.msg.state, "accepted");
  assert.equal(accepted.msg.revision, 0);
  assert.equal(ready.msg.state, "pairing-ready");
  assert.equal(ready.msg.revision, 1);

  const projected = lifecycleStatusToLegacy({
    operationId: "op-1",
    state: "failed",
    revision: 2,
    target: { kind: "existing", storeAuthority: "copilot-cli", sessionId: "session-1" },
    failure: { code: "launch-failed", message: "could not launch", actions: ["retry"] },
  });
  assert.deepEqual(projected.map((message) => message.eventSubtype), [
    SUBTYPE.CONTROL.LAUNCH_STATUS,
    SUBTYPE.CONTROL.SPAWN_RESULT,
  ]);
  assert.equal(projected[0].msg.operation, "resume");
  assert.equal(projected[0].msg.state, "failed");
  assert.equal(projected[1].msg.ok, false);

  const activating = lifecycleStatusToLegacy({
    operationId: "op-activating",
    state: "activating",
    revision: 1,
    target: { kind: "existing", storeAuthority: "copilot-cli", sessionId: "session-1" },
  });
  assert.deepEqual(
    activating.map((message) => message.eventSubtype),
    [SUBTYPE.CONTROL.LAUNCH_STATUS],
    "an in-progress activation must not be projected as a successful legacy spawn result",
  );
});

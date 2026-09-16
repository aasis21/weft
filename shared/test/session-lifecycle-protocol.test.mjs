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
  SESSION_ACTIVATION_CAPABILITY,
  SUBTYPE,
  latestLifecycleStatus,
  launchStatus,
  lifecycleCancel,
  lifecycleStatus,
  lifecycleStatusFromLegacy,
  lifecycleStatusRequest,
  lifecycleStatusToLegacy,
  openIntentFingerprint,
  openSession,
  openSessionFromLegacy,
  openSessionToLegacy,
  resumeSession,
  spawnSession,
  takeoverConfirm,
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

test("coordinator failure codes survive lifecycle serialization", () => {
  for (const code of [
    "operation-stale",
    "target-reserved",
    "project-not-found",
    "identity-failed",
    "launch-outcome-unknown",
    "launch-not-recoverable",
  ]) {
    const message = lifecycleStatus({
      operationId: `failure-${code}`,
      state: "failed",
      revision: 2,
      failure: { code, actions: ["retry", "cancel"] },
    });
    assert.equal(message.msg.failure.code, code);
    assert.deepEqual(message.msg.failure.actions, ["retry", "cancel"]);
  }
});

test("generic lifecycle factories build bounded CONTROL envelopes", () => {
  const open = openSession("op-1", {
    kind: "existing",
    storeAuthority: " copilot-cli ",
    sessionId: " session-1 ",
  }, {
    mode: "allow-all",
    takeoverRequested: true,
  });
  assert.equal(open.eventType, EVENT_TYPE.CONTROL);
  assert.equal(open.eventSubtype, SUBTYPE.CONTROL.OPEN_SESSION);
  assert.deepEqual(open.msg, {
    operationId: "op-1",
    target: {
      kind: "existing",
      storeAuthority: "copilot-cli",
      sessionId: "session-1",
    },
    mode: "allow-all",
    name: null,
    takeoverRequested: true,
  });

  assert.deepEqual(lifecycleStatusRequest("op-1").msg, { operationId: "op-1" });
  assert.deepEqual(takeoverConfirm("op-1", "challenge-1", 7).msg, {
    operationId: "op-1",
    challengeId: "challenge-1",
    revision: 7,
  });
  assert.deepEqual(lifecycleCancel("op-1", 7).msg, {
    operationId: "op-1",
    revision: 7,
  });

  const status = lifecycleStatus({
    operationId: "op-1",
    fingerprint: "f".repeat(64),
    state: "failed",
    revision: 7,
    target: open.msg.target,
    failure: {
      code: "ownership-unknown",
      actions: ["retry", "confirm-takeover", "not-real"],
      retryable: false,
    },
    challenge: {
      challengeId: "challenge-1",
      sessionId: "session-1",
      storeAuthority: "copilot-cli",
      runtimeInstanceId: "runtime-1",
      generation: 3,
      pid: 123,
      processStartedAt: 456,
      responsive: true,
    },
  });
  assert.equal(status.eventSubtype, SUBTYPE.CONTROL.LIFECYCLE_STATUS);
  assert.deepEqual(status.msg.failure, {
    code: "ownership-unknown",
    actions: ["retry", "confirm-takeover"],
    retryable: false,
  });
  assert.deepEqual(status.msg.challenge, {
    challengeId: "challenge-1",
    operationId: "op-1",
    revision: 7,
    storeAuthority: "copilot-cli",
    sessionId: "session-1",
    runtimeInstanceId: "runtime-1",
    generation: 3,
    pid: 123,
    processStartedAt: 456,
    responsive: true,
  });

  assert.throws(
    () => openSession("op-large", { kind: "new", projectName: "x".repeat(LIFECYCLE_MESSAGE_MAX_BYTES) }),
    /^RangeError: too-large$/,
  );
});

test("operation fingerprints are canonical, normalized, and exclude the operation id", async () => {
  const first = openSession("delivery-1", { kind: "new", projectName: " weft " }, {
    mode: "allow-all",
    name: " feature ",
  });
  const duplicate = openSession("delivery-2", { projectName: "weft", kind: "new" }, {
    name: "feature",
    mode: "allow-all",
  });
  const conflicting = openSession("delivery-1", { kind: "new", projectName: "other" }, {
    mode: "allow-all",
    name: "feature",
  });

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
  const stale = lifecycleStatus({
    operationId: "op-1",
    state: "launching",
    revision: 0,
  });

  assert.equal(accepted.msg.state, "accepted");
  assert.equal(accepted.msg.revision, 0);
  assert.equal(ready.msg.state, "pairing-ready");
  assert.equal(ready.msg.revision, 1);
  assert.equal(latestLifecycleStatus(ready, stale), ready);
  assert.equal(latestLifecycleStatus(accepted, ready), ready);

  const projected = lifecycleStatusToLegacy(lifecycleStatus({
    operationId: "op-1",
    state: "failed",
    revision: 2,
    target: { kind: "existing", storeAuthority: "copilot-cli", sessionId: "session-1" },
    failure: { code: "launch-failed", message: "could not launch", actions: ["retry"] },
  }));
  assert.deepEqual(projected.map((message) => message.eventSubtype), [
    SUBTYPE.CONTROL.LAUNCH_STATUS,
    SUBTYPE.CONTROL.SPAWN_RESULT,
  ]);
  assert.equal(projected[0].msg.operation, "resume");
  assert.equal(projected[0].msg.state, "failed");
  assert.equal(projected[1].msg.ok, false);

  const activating = lifecycleStatusToLegacy(lifecycleStatus({
    operationId: "op-activating",
    state: "activating",
    revision: 1,
    target: { kind: "existing", storeAuthority: "copilot-cli", sessionId: "session-1" },
  }));
  assert.deepEqual(
    activating.map((message) => message.eventSubtype),
    [SUBTYPE.CONTROL.LAUNCH_STATUS],
    "an in-progress activation must not be projected as a successful legacy spawn result",
  );
});

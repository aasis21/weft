// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import {
  activationControllerDecision,
  isAuthenticatedTakeoverConfirmation,
} from "../src/activeRuntime.mjs";

test("activation distinguishes the current phone from a takeover requester", () => {
  assert.deepEqual(
    activationControllerDecision({
      controllerDeviceId: "phone-a",
      controllerPublicKey: "pub-a",
      requesterId: "phone-a",
    }),
    { kind: "current-controller" },
  );
  assert.deepEqual(
    activationControllerDecision({
      controllerDeviceId: "phone-a",
      controllerPublicKey: "pub-a",
      requesterId: "phone-b",
      controllerName: "Ashish's phone",
    }),
    { kind: "conflict", controllerName: "Ashish's phone" },
  );
  assert.deepEqual(
    activationControllerDecision({
      controllerPublicKey: "legacy-pub",
      requesterId: "phone-a",
    }),
    { kind: "conflict", controllerName: null },
  );
  assert.deepEqual(
    activationControllerDecision({ requesterId: "phone-a" }),
    { kind: "activate" },
  );
});

test("controller rotation requires the operation-bound confirmed takeover fields", () => {
  assert.equal(isAuthenticatedTakeoverConfirmation({
    operationId: "takeover-a",
    requesterId: "phone-b",
    challengeId: "challenge-a",
    expectedRevision: 4,
  }), true);
  assert.equal(isAuthenticatedTakeoverConfirmation({
    operationId: "takeover-a",
    requesterId: "phone-b",
    expectedRevision: 4,
  }), false);
  assert.equal(isAuthenticatedTakeoverConfirmation({
    operationId: "takeover-a",
    requesterId: "phone-b",
    challengeId: "challenge-a",
    expectedRevision: -1,
  }), false);
});

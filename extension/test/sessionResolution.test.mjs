// SPDX-License-Identifier: Apache-2.0
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeOpenIntent, resolveSessionOpen } from "../src/sessionResolution.mjs";

const existing = normalizeOpenIntent({
  operationId: "open-1",
  target: { kind: "existing", storeAuthority: "cli", sessionId: "session-a" },
});

test("resolution ladder selects open, reconnect, activate, conflict, resume, and fail-closed in order", () => {
  assert.equal(resolveSessionOpen({ intent: existing, healthyCard: { id: "card" } }).outcome, "open-existing");
  assert.equal(
    resolveSessionOpen({ intent: existing, reconnect: { status: "confirmed" } }).outcome,
    "reconnect",
  );
  assert.equal(
    resolveSessionOpen({
      intent: existing,
      runtimes: { status: "single", runtime: { runtimeId: "runtime-a" } },
    }).outcome,
    "activate-live",
  );
  assert.equal(
    resolveSessionOpen({ intent: existing, runtimes: { status: "multiple" } }).failure.code,
    "writer-conflict",
  );
  assert.equal(
    resolveSessionOpen({
      intent: existing,
      runtimes: { status: "none" },
      savedSession: { directoryExists: true, writerState: "stopped" },
    }).outcome,
    "resume",
  );
  assert.equal(
    resolveSessionOpen({
      intent: existing,
      runtimes: { status: "unknown" },
      savedSession: { directoryExists: true, writerState: "stopped" },
    }).failure.code,
    "ownership-unknown",
  );
});

test("new-session resolution starts only from a valid project directory", () => {
  const intent = normalizeOpenIntent({
    operationId: "start-1",
    target: { kind: "new", projectName: "weft" },
  });
  assert.equal(
    resolveSessionOpen({ intent, project: { name: "weft", path: "C:\\weft", directoryExists: true } }).outcome,
    "start",
  );
  assert.equal(resolveSessionOpen({ intent, project: null }).failure.code, "project-not-found");
  assert.equal(
    resolveSessionOpen({ intent, project: { name: "weft", directoryExists: false } }).failure.code,
    "directory-not-found",
  );
});

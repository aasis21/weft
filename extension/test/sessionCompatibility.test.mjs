// SPDX-License-Identifier: Apache-2.0
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVENT_TYPE,
  SUBTYPE,
  openSession,
  openSessionToLegacy,
  resumeSession,
  spawnSession,
} from "@aasis21/weft-shared";
import {
  coordinatorIntentFromLegacy,
  legacyEnvelopesFromSnapshot,
  lifecycleEnvelopeFromSnapshot,
  lifecycleSnapshotFromLaunchRecord,
  readPositiveLegacyEvidence,
} from "../src/sessionCompatibility.mjs";
import { createStationSessionCoordinator } from "../src/stationSessionCoordinator.mjs";
import * as launchApi from "../src/launchOperations.mjs";

test("old phone and new Station adapt Start and Resume into coordinator intents", () => {
  assert.deepEqual(
    coordinatorIntentFromLegacy(spawnSession("start-1", "weft", "allow-all", "feature"), "phone-a"),
    {
      operationId: "start-1",
      target: { kind: "new", projectName: "weft" },
      mode: "allow-all",
      name: "feature",
      takeoverRequested: false,
      requesterId: "phone-a",
    },
  );
  assert.deepEqual(
    coordinatorIntentFromLegacy(resumeSession("resume-1", "session-a", "default", true), "phone-a"),
    {
      operationId: "resume-1",
      target: { kind: "existing", storeAuthority: null, sessionId: "session-a" },
      mode: "default",
      name: null,
      takeoverRequested: true,
      requesterId: "phone-a",
    },
  );
});

test("new phone and old Station project Open to the supported legacy request", () => {
  const generic = openSession("resume-1", {
    kind: "existing",
    storeAuthority: "copilot-cli",
    sessionId: "session-a",
  }, { takeoverRequested: true });
  const legacy = openSessionToLegacy(generic);
  assert.equal(legacy.eventSubtype, SUBTYPE.CONTROL.RESUME_SESSION);
  assert.equal(legacy.msg.force, true);
});

test("new Station emits only the downgrade messages an old phone needs", () => {
  const snapshot = lifecycleSnapshotFromLaunchRecord({
    requestId: "start-1",
    operation: "new",
    projectName: "weft",
    state: "pairing-ready",
    revision: 3,
    pairingPayload: { v: 1, channelId: "session-a", pub: "pub", transport: { kind: "local" } },
  });
  const modern = lifecycleEnvelopeFromSnapshot(snapshot);
  const legacy = legacyEnvelopesFromSnapshot(snapshot);

  assert.equal(modern.eventSubtype, SUBTYPE.CONTROL.LIFECYCLE_STATUS);
  assert.deepEqual(legacy.map((message) => message.eventSubtype), [
    SUBTYPE.CONTROL.LAUNCH_STATUS,
    SUBTYPE.CONTROL.SPAWN_PAIRING,
    SUBTYPE.CONTROL.SPAWN_RESULT,
  ]);
  assert.equal(legacy.at(-1).msg.ok, true);
});

test("new Station dual-reads only positive old-extension writer and offer evidence", () => {
  const attachedApi = {
    findAttachedSession(sessionId) {
      return sessionId === "live-session" ? { sessionId, pid: 42, healthy: true } : null;
    },
  };
  const pendingApi = {
    listPendingSessions() {
      return [{ channelId: "offer-a", payload: { v: 1, channelId: "offer-a" } }];
    },
  };

  assert.deepEqual(
    readPositiveLegacyEvidence(
      { kind: "existing", storeAuthority: "default", sessionId: "live-session" },
      { attachedApi, pendingApi },
    ),
    { kind: "writer", writer: { sessionId: "live-session", pid: 42, healthy: true } },
  );
  assert.equal(
    readPositiveLegacyEvidence(
      { kind: "existing", storeAuthority: "default", sessionId: "missing" },
      { attachedApi, pendingApi },
    ),
    null,
  );
  assert.deepEqual(
    readPositiveLegacyEvidence(
      { kind: "existing", storeAuthority: "legacy-offer", sessionId: "offer-a" },
      { attachedApi, pendingApi },
    ),
    { kind: "offer", offer: { channelId: "offer-a", payload: { v: 1, channelId: "offer-a" } } },
  );
});

test("legacy compatibility distinguishes proven stopped ownership from unknown absence", () => {
  const stoppedApi = {
    inspectAttachedSessionOwnership() {
      return { state: "stopped", writer: { sessionId: "stopped", pid: 42 } };
    },
  };
  const unknownApi = {
    inspectAttachedSessionOwnership() {
      return { state: "unknown" };
    },
  };
  const target = { kind: "existing", storeAuthority: "default", sessionId: "stopped" };

  assert.deepEqual(
    readPositiveLegacyEvidence(target, { attachedApi: stoppedApi }),
    { kind: "stopped", writer: { sessionId: "stopped", pid: 42 } },
  );
  assert.equal(readPositiveLegacyEvidence(target, { attachedApi: unknownApi }), null);
});

test("new Station activates a positive old-extension offer without spawning", async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-compat-offer-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const payload = { v: 1, channelId: "offer-a", pub: "pub", transport: { kind: "local" } };
  let spawns = 0;
  const coordinator = createStationSessionCoordinator({
    baseDir,
    sessionsApi: { readSession: () => null, readSessionCwd: () => null },
    projectsApi: { listProjects: () => [] },
    attachedApi: { findAttachedSession: () => null },
    pendingApi: { listPendingSessions: () => [{ channelId: "offer-a", payload }] },
    launchApi,
    spawnFn() {
      spawns += 1;
      throw new Error("legacy offer activation must not spawn");
    },
    getTransportDescriptor: () => ({ kind: "local" }),
  });

  test("new Station fails closed when legacy ownership cannot be proven stopped", async (t) => {
    const baseDir = mkdtempSync(join(tmpdir(), "weft-compat-unknown-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "weft-compat-session-"));
    t.after(() => {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    });
    let spawns = 0;
    const coordinator = createStationSessionCoordinator({
      baseDir,
      sessionsApi: { readSessionCwd: () => sessionDir },
      projectsApi: { listProjects: () => [] },
      attachedApi: {
        inspectAttachedSessionOwnership: () => ({ state: "unknown" }),
        findAttachedSession: () => null,
      },
      pendingApi: { listPendingSessions: () => [] },
      launchApi,
      spawnFn() {
        spawns += 1;
        return { unref() {} };
      },
      getTransportDescriptor: () => ({ kind: "local" }),
    });

    const result = await coordinator.open({
      operationId: "legacy-unknown",
      target: { kind: "existing", storeAuthority: "default", sessionId: "session-a" },
    });

    assert.equal(result.failure.code, "ownership-unknown");
    assert.equal(spawns, 0);
  });

  test("new Station resumes when legacy evidence positively proves the prior process absent", async (t) => {
    const baseDir = mkdtempSync(join(tmpdir(), "weft-compat-stopped-"));
    const sessionDir = mkdtempSync(join(tmpdir(), "weft-compat-stopped-session-"));
    t.after(() => {
      rmSync(baseDir, { recursive: true, force: true });
      rmSync(sessionDir, { recursive: true, force: true });
    });
    let spawns = 0;
    const coordinator = createStationSessionCoordinator({
      baseDir,
      sessionsApi: { readSessionCwd: () => sessionDir },
      projectsApi: { listProjects: () => [] },
      attachedApi: {
        inspectAttachedSessionOwnership: () => ({
          state: "stopped",
          writer: { sessionId: "session-a", pid: 42 },
        }),
        findAttachedSession: () => null,
      },
      pendingApi: { listPendingSessions: () => [] },
      launchApi,
      spawnFn() {
        spawns += 1;
        return { pid: 101, unref() {} };
      },
      getTransportDescriptor: () => ({ kind: "local" }),
    });

    const result = await coordinator.open({
      operationId: "legacy-stopped",
      target: { kind: "existing", storeAuthority: "default", sessionId: "session-a" },
    });

    assert.equal(result.state, "launching");
    assert.equal(spawns, 1);
  });

  const result = await coordinator.open({
    operationId: "offer-open",
    target: { kind: "existing", storeAuthority: "legacy-offer", sessionId: "offer-a" },
    requesterId: "new-phone",
  });

  assert.equal(result.state, "pairing-ready");
  assert.deepEqual(result.pairingPayload, payload);
  assert.equal(spawns, 0);
});

test("compatibility envelopes remain ordinary control messages", () => {
  const [status] = legacyEnvelopesFromSnapshot({
    operationId: "failed-1",
    state: "failed",
    revision: 1,
    target: { kind: "new", projectName: "weft" },
    failure: { code: "launch-failed", message: "failed", actions: ["retry"] },
  });
  assert.equal(status.eventType, EVENT_TYPE.CONTROL);
});

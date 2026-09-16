// SPDX-License-Identifier: Apache-2.0
import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCoordinator } from "../src/sessionCoordinator.mjs";
import { createLaunchOperationJournal } from "../src/sessionOperationJournal.mjs";
import {
  LIFECYCLE_RETENTION_MS,
  beginLaunchOperation,
  launchIdentityPath,
  launchOperationPath,
  readLaunchOperation,
  updateLaunchOperation,
} from "../src/launchOperations.mjs";

const dirs = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function home() {
  const dir = mkdtempSync(join(tmpdir(), "weft-session-coordinator-"));
  dirs.push(dir);
  return dir;
}

function intent(operationId = "open-a") {
  return {
    operationId,
    target: { kind: "existing", storeAuthority: "cli", sessionId: "session-a" },
    requesterId: "phone-a",
  };
}

function ports({
  journal,
  counters = {},
  locateTarget = async () => ({ status: "none" }),
  locateOperation = async () => ({ status: "none" }),
  processState = "alive",
  launchState = "launching",
  activate,
  status,
  replaceController,
  quiesce,
  revalidate,
  terminate,
  confirmExit,
  terminateLegacy,
  sessionResolve,
  resume,
} = {}) {
  return {
    journal,
    connections: {
      findHealthyCard: async () => null,
      reconnect: async () => ({ status: "not-found" }),
    },
    runtimeDirectory: { locateTarget, locateOperation },
    runtimeControl: {
      activate: activate ?? (async (runtime) => {
        counters.activations = (counters.activations ?? 0) + 1;
        return { state: "pairing-ready", runtimeId: runtime.runtimeId };
      }),
      status: status ?? (async () => ({ state: "open" })),
      replaceController: replaceController ?? (async () => ({ state: "pairing-ready" })),
      quiesce: quiesce ?? (async () => ({ state: "degraded" })),
    },
    sessions: {
      resolve: sessionResolve ?? (async () => ({
        sessionId: "session-a",
        cwd: "C:\\repo",
        directoryExists: true,
        writerState: "stopped",
      })),
    },
    projects: {
      resolve: async (projectName) => ({ name: projectName, path: "C:\\repo", directoryExists: true }),
    },
    identities: {
      create: async ({ operationId }) => {
        counters.identities = (counters.identities ?? 0) + 1;
        return { identityRef: `identity:${operationId}` };
      },
    },
    launcher: {
      start: async () => {
        counters.launches = (counters.launches ?? 0) + 1;
        return { state: launchState, pid: 101 };
      },
      resume: resume ?? (async () => {
        counters.launches = (counters.launches ?? 0) + 1;
        return { state: launchState, pid: 101 };
      }),
    },
    processes: {
      inspect: async () => ({ state: processState }),
      revalidate: revalidate ?? (async () => true),
      terminate: terminate ?? (async () => ({ ok: true })),
      confirmExit: confirmExit ?? (async () => ({ ok: true })),
      terminateLegacy: terminateLegacy ?? (async () => ({ ok: true })),
    },
    clock: { now: () => 1_000 },
  };
}

test("duplicate delivery replays one operation and launches once", async () => {
  const counters = {};
  const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
  const coordinator = new SessionCoordinator(ports({ journal, counters }));

  const [first, duplicate] = await Promise.all([coordinator.open(intent()), coordinator.open(intent())]);
  const replay = await coordinator.open(intent());

  assert.equal(counters.launches, 1);
  assert.equal(counters.identities, 1);
  assert.equal(first.operationId, "open-a");
  assert.equal(duplicate.revision, first.revision);
  assert.equal(replay.state, "launching");
});

function liveRuntime(overrides = {}) {
  return {
    runtimeId: "runtime-a",
    runtimeInstanceId: "runtime-a",
    storeAuthority: "cli",
    sessionId: "session-a",
    generation: 3,
    pid: 4321,
    processStartedAt: 100,
    ...overrides,
  };
}

test("responsive takeover replaces the controller in the existing runtime without launch", async () => {
  const counters = {};
  const runtime = liveRuntime();
  const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
  const coordinator = new SessionCoordinator(ports({
    journal,
    counters,
    locateTarget: async () => ({ status: "single", runtime }),
    activate: async () => ({ state: "active", controllerName: "Phone B" }),
    replaceController: async () => {
      counters.replacements = (counters.replacements ?? 0) + 1;
      return { state: "pairing-ready", pairingPayload: { channelId: "replacement" } };
    },
  }));

  const challenged = await coordinator.open(intent("takeover-responsive"));
  assert.equal(challenged.failure.code, "controller-conflict");
  const completed = await coordinator.confirmTakeover({
    operationId: challenged.operationId,
    challengeId: challenged.challenge.challengeId,
    revision: challenged.revision,
  });

  assert.equal(completed.state, "pairing-ready");
  assert.equal(completed.action, "takeover");
  assert.equal(counters.replacements, 1);
  assert.equal(counters.launches ?? 0, 0);
});

test("responsive controller replacement failure never escalates to process termination", async () => {
  const runtime = liveRuntime();
  let terminated = 0;
  const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
  const coordinator = new SessionCoordinator(ports({
    journal,
    locateTarget: async () => ({ status: "single", runtime }),
    activate: async () => ({ state: "active" }),
    replaceController: async () => { throw new Error("replacement rejected"); },
    terminate: async () => {
      terminated += 1;
      return { ok: true };
    },
  }));
  const challenged = await coordinator.open(intent("takeover-replace-failed"));
  const completed = await coordinator.confirmTakeover({
    operationId: challenged.operationId,
    challengeId: challenged.challenge.challengeId,
    revision: challenged.revision,
  });

  assert.equal(completed.failure.code, "takeover-failed");
  assert.equal(terminated, 0);
});

test("stale cancellation is rejected without mutating the operation", async () => {
  const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
  const coordinator = new SessionCoordinator(ports({ journal }));
  const opened = await coordinator.open(intent("cancel-stale"));

  const rejected = await coordinator.cancel(opened.operationId, opened.revision - 1);
  const current = await coordinator.inspect(opened.operationId);

  assert.equal(rejected.failure.code, "operation-stale");
  assert.equal(rejected.revision, opened.revision);
  assert.equal(current.state, "launching");
  assert.equal(current.failure, null);
});

test("current cancellation revision produces a durable acknowledgement", async () => {
  const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
  const coordinator = new SessionCoordinator(ports({ journal }));
  const opened = await coordinator.open(intent("cancel-current"));

  const cancelled = await coordinator.cancel(opened.operationId, opened.revision);

  assert.equal(cancelled.state, "cancelled");
  assert.equal(cancelled.revision, opened.revision + 1);
});

test("legacy forced takeover validates the saved session before journaling termination", async () => {
  let terminated = 0;
  const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
  const coordinator = new SessionCoordinator(ports({
    journal,
    locateTarget: async () => ({
      status: "legacy-writer",
      writer: { sessionId: "session-a", pid: 42, channelId: "legacy-channel" },
    }),
    sessionResolve: async () => null,
    terminateLegacy: async () => {
      terminated += 1;
      return { ok: true };
    },
  }));

  const result = await coordinator.open({ ...intent("legacy-missing"), takeoverRequested: true });

  assert.equal(result.failure.code, "session-not-found");
  assert.equal(terminated, 0);
});

test("legacy forced takeover journals the exact writer before terminating it", async () => {
  let journaledBoundary = null;
  const durable = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
  const journal = {
    ...durable,
    update: async (operationId, updates, options) => {
      const result = await durable.update(operationId, updates, options);
      if (updates.legacyWriter) journaledBoundary = result;
      return result;
    },
  };
  const coordinator = new SessionCoordinator(ports({
    journal,
    locateTarget: async () => ({
      status: "legacy-writer",
      writer: { sessionId: "session-a", pid: 42, channelId: "legacy-channel" },
    }),
    terminateLegacy: async () => {
      assert.deepEqual(journaledBoundary?.legacyWriter, {
        sessionId: "session-a",
        pid: 42,
        channelId: "legacy-channel",
      });
      return { ok: true };
    },
  }));

  const result = await coordinator.open({ ...intent("legacy-boundary"), takeoverRequested: true });

  assert.equal(result.state, "launching");
});

test("takeover fails closed when generation changes or a PID is reused after the challenge", async (t) => {
  for (const changed of [
    { name: "generation", patch: { generation: 4 } },
    { name: "process-start", patch: { processStartedAt: 101 } },
  ]) {
    await t.test(changed.name, async () => {
      let runtime = liveRuntime();
      let terminated = 0;
      const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
      const coordinator = new SessionCoordinator(ports({
        journal,
        locateTarget: async () => ({ status: "single", runtime }),
        activate: async () => ({ state: "active" }),
        terminate: async () => {
          terminated += 1;
          return { ok: true };
        },
      }));
      const challenged = await coordinator.open(intent(`takeover-stale-${changed.name}`));
      runtime = liveRuntime(changed.patch);
      const completed = await coordinator.confirmTakeover({
        operationId: challenged.operationId,
        challengeId: challenged.challenge.challengeId,
        revision: challenged.revision,
      });
      assert.equal(completed.failure.code, "takeover-stale");
      assert.equal(terminated, 0);
    });
  }
});

test("unresponsive takeover quiesces, terminates, confirms exit, then resumes once", async () => {
  const calls = [];
  const runtime = liveRuntime();
  const counters = {};
  const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
  const coordinator = new SessionCoordinator(ports({
    journal,
    counters,
    locateTarget: async () => ({ status: "single", runtime }),
    activate: async () => ({ state: "active" }),
    status: async () => { throw new Error("unresponsive"); },
    quiesce: async () => { calls.push("quiesce"); throw new Error("endpoint unavailable"); },
    revalidate: async () => { calls.push("revalidate"); return true; },
    terminate: async () => { calls.push("terminate"); return { ok: true }; },
    confirmExit: async () => { calls.push("confirm-exit"); return { ok: true }; },
  }));
  const challenged = await coordinator.open(intent("takeover-unresponsive"));
  const completed = await coordinator.confirmTakeover({
    operationId: challenged.operationId,
    challengeId: challenged.challenge.challengeId,
    revision: challenged.revision,
  });

  assert.equal(completed.state, "launching");
  assert.deepEqual(calls, ["revalidate", "quiesce", "terminate", "confirm-exit"]);
  assert.equal(counters.launches, 1);
});

test("forced takeover records outcome-unknown from the latest identity revision and reconciles", async () => {
  const runtime = liveRuntime();
  const baseDir = home();
  const journal = createLaunchOperationJournal({ baseDir, clock: { now: () => 1_000 } });
  const coordinator = new SessionCoordinator(ports({
    journal,
    locateTarget: async () => ({ status: "single", runtime }),
    locateOperation: async (operation) => operation.failure?.code === "launch-outcome-unknown"
      ? { status: "single", runtime: liveRuntime({ runtimeId: "replacement", runtimeInstanceId: "replacement" }) }
      : { status: "none" },
    activate: async () => ({ state: "active" }),
    status: async (candidate) => {
      if (candidate.runtimeId === "replacement") return { state: "open" };
      throw new Error("unresponsive");
    },
    quiesce: async () => { throw new Error("endpoint unavailable"); },
    resume: async () => {
      throw new Error("station crashed after resume");
    },
  }));
  const challenged = await coordinator.open(intent("takeover-crash"));
  const interrupted = await coordinator.confirmTakeover({
    operationId: challenged.operationId,
    challengeId: challenged.challenge.challengeId,
    revision: challenged.revision,
  });

  assert.equal(interrupted.state, "launching");
  assert.equal(interrupted.failure.code, "launch-outcome-unknown");
  assert.ok(interrupted.identityRef);

  const [reconciled] = await coordinator.reconcile();
  assert.equal(reconciled.state, "open");
  assert.equal(reconciled.runtimeId, "replacement");
});

test("takeover does not terminate after explicit quiescence refusal or resume after unconfirmed exit", async (t) => {
  for (const scenario of ["quiesce-refused", "exit-unconfirmed"]) {
    await t.test(scenario, async () => {
      const runtime = liveRuntime();
      const counters = {};
      let terminated = 0;
      const journal = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
      const coordinator = new SessionCoordinator(ports({
        journal,
        counters,
        locateTarget: async () => ({ status: "single", runtime }),
        activate: async () => ({ state: "active" }),
        status: async () => { throw new Error("unresponsive"); },
        quiesce: scenario === "quiesce-refused"
          ? async () => {
              const error = new Error("runtime refused");
              error.code = "COMMAND_FAILED";
              throw error;
            }
          : async () => ({ state: "degraded" }),
        terminate: async () => {
          terminated += 1;
          return { ok: true };
        },
        confirmExit: async () => scenario === "exit-unconfirmed"
          ? { ok: false, error: "still alive" }
          : { ok: true },
      }));
      const challenged = await coordinator.open(intent(`takeover-${scenario}`));
      const completed = await coordinator.confirmTakeover({
        operationId: challenged.operationId,
        challengeId: challenged.challenge.challengeId,
        revision: challenged.revision,
      });
      assert.equal(completed.state, "failed");
      assert.equal(counters.launches ?? 0, 0);
      assert.equal(terminated, scenario === "quiesce-refused" ? 0 : 1);
    });
  }
});

test("a takeover challenge keeps the target reserved against a concurrent phone", async () => {
  const runtime = liveRuntime();
  const baseDir = home();
  const first = new SessionCoordinator(ports({
    journal: createLaunchOperationJournal({ baseDir, clock: { now: () => 1_000 } }),
    locateTarget: async () => ({ status: "single", runtime }),
    activate: async () => ({ state: "active" }),
  }));
  const second = new SessionCoordinator(ports({
    journal: createLaunchOperationJournal({ baseDir, clock: { now: () => 1_000 } }),
    locateTarget: async () => ({ status: "single", runtime }),
  }));
  const challenged = await first.open(intent("phone-a"));
  const contender = await second.open({ ...intent("phone-b"), requesterId: "phone-b" });
  assert.equal(challenged.failure.code, "controller-conflict");
  assert.equal(contender.failure.code, "target-reserved");
});

test("concurrent operations for one existing target preserve the one-writer invariant", async () => {
  const counters = {};
  const baseDir = home();
  const journalA = createLaunchOperationJournal({ baseDir, clock: { now: () => 1_000 } });
  const journalB = createLaunchOperationJournal({ baseDir, clock: { now: () => 1_000 } });
  const coordinatorA = new SessionCoordinator(ports({ journal: journalA, counters }));
  const coordinatorB = new SessionCoordinator(ports({ journal: journalB, counters }));

  const results = await Promise.all([coordinatorA.open(intent("open-a")), coordinatorB.open(intent("open-b"))]);

  assert.equal(counters.launches, 1);
  assert.equal(results.filter((result) => result.failure?.code === "target-reserved").length, 1);
  assert.equal(results.filter((result) => result.state === "launching").length, 1);
});

test("storage failure before the effect boundary prevents activation and launch", async (t) => {
  for (const path of ["launching", "activating"]) {
    await t.test(path, async () => {
      const counters = {};
      const durable = createLaunchOperationJournal({ baseDir: home(), clock: { now: () => 1_000 } });
      const journal = {
        ...durable,
        update: async (operationId, updates, options) => {
          if (updates.state === path) throw new Error("disk unavailable");
          return durable.update(operationId, updates, options);
        },
      };
      const coordinator = new SessionCoordinator(
        ports({
          journal,
          counters,
          ...(path === "activating"
            ? { locateTarget: async () => ({ status: "single", runtime: { runtimeId: "runtime-a" } }) }
            : {}),
        }),
      );

      await assert.rejects(coordinator.open(intent(`open-${path}`)), /disk unavailable/);
      assert.equal(counters.launches ?? 0, 0);
      assert.equal(counters.activations ?? 0, 0);
    });
  }
});

test("restart reconciliation crosses the post-launch crash boundary without launching twice", async () => {
  const counters = {};
  const baseDir = home();
  const durable = createLaunchOperationJournal({ baseDir, clock: { now: () => 1_000 } });
  let losePostLaunchWrite = true;
  const crashingJournal = {
    ...durable,
    update: async (operationId, updates, options) => {
      if (losePostLaunchWrite && Number.isInteger(updates.pid)) {
        losePostLaunchWrite = false;
        throw new Error("station crashed after spawn");
      }
      return durable.update(operationId, updates, options);
    },
  };
  const first = new SessionCoordinator(ports({ journal: crashingJournal, counters }));
  const interrupted = await first.open(intent());
  assert.equal(interrupted.state, "launching");
  assert.equal(interrupted.failure.code, "launch-outcome-unknown");
  assert.equal(counters.launches, 1);

  const restarted = new SessionCoordinator(
    ports({
      journal: durable,
      counters,
      locateOperation: async () => ({ status: "single", runtime: { runtimeId: "runtime-a" } }),
    }),
  );
  const [reconciled] = await restarted.reconcile();

  assert.equal(reconciled.state, "open");
  assert.equal(reconciled.runtimeId, "runtime-a");
  assert.equal(counters.launches, 1);
});

test("journal revisions are monotonic and terminal tombstones cannot regress", async () => {
  const baseDir = home();
  const created = await beginLaunchOperation(
    {
      requestId: "monotonic",
      operation: "resume",
      storeAuthority: "cli",
      sessionId: "session-a",
    },
    { baseDir, now: 10 },
  );
  const launching = await updateLaunchOperation(
    "monotonic",
    { action: "resume", state: "launching" },
    { baseDir, expectedRevision: 0, now: 20 },
  );
  const stale = await updateLaunchOperation(
    "monotonic",
    { state: "reserved" },
    { baseDir, expectedRevision: 0, now: 30 },
  );
  const terminal = await updateLaunchOperation(
    "monotonic",
    { state: "failed", failure: { code: "launch-failed" } },
    { baseDir, expectedRevision: 1, now: 40 },
  );
  const regression = await updateLaunchOperation(
    "monotonic",
    { state: "open" },
    { baseDir, expectedRevision: 2, now: 50 },
  );

  assert.equal(created.record.revision, 0);
  assert.equal(launching.revision, 1);
  assert.equal(stale.revision, 1);
  assert.equal(terminal.revision, 2);
  assert.equal(regression.state, "failed");
  assert.equal(regression.revision, 2);
});

test("three-day cleanup removes expired tombstones but preserves live and unresolved references", async () => {
  const baseDir = home();
  const clock = { now: () => 1 };
  const createTerminal = async (requestId, updates = {}) => {
    const begun = await beginLaunchOperation(
      { requestId, operation: "new", projectName: requestId },
      { baseDir, now: 1 },
    );
    return updateLaunchOperation(
      requestId,
      { state: "failed", ...updates },
      { baseDir, ownerToken: begun.record.ownerToken, now: 2 },
    );
  };
  const expiredIdentity = launchIdentityPath("expired", { baseDir });
  const liveIdentity = launchIdentityPath("live-runtime", { baseDir });
  const sharedIdentity = launchIdentityPath("shared-identity", { baseDir });
  const orphanIdentity = launchIdentityPath("orphan", { baseDir });
  for (const file of [expiredIdentity, liveIdentity, sharedIdentity, orphanIdentity]) {
    writeFileSync(file, "{}");
    utimesSync(file, new Date(0), new Date(0));
  }
  await createTerminal("expired", { identityRef: expiredIdentity });
  await createTerminal("live-runtime", { runtimeId: "runtime-live", identityRef: liveIdentity });
  await createTerminal("shared-identity", { identityRef: sharedIdentity });
  const unresolved = await beginLaunchOperation(
    { requestId: "unresolved", operation: "new", projectName: "app" },
    { baseDir, now: 3 },
  );
  await updateLaunchOperation(
    "unresolved",
    { identityRef: sharedIdentity },
    { baseDir, ownerToken: unresolved.record.ownerToken, now: 4 },
  );

  const journal = createLaunchOperationJournal({
    baseDir,
    clock,
    liveReferences: {
      isRuntimeLive: (record) => record.runtimeId === "runtime-live",
    },
  });
  await journal.cleanup({ now: LIFECYCLE_RETENTION_MS + 10 });

  assert.equal(existsSync(launchOperationPath("expired", { baseDir })), false);
  assert.equal(existsSync(expiredIdentity), false);
  assert.equal(existsSync(orphanIdentity), false);
  assert.ok(readLaunchOperation("live-runtime", { baseDir }));
  assert.equal(existsSync(liveIdentity), true);
  assert.ok(readLaunchOperation("shared-identity", { baseDir }));
  assert.equal(existsSync(sharedIdentity), true);
  assert.ok(readLaunchOperation("unresolved", { baseDir }));
});

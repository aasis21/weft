// SPDX-License-Identifier: Apache-2.0
// openSession: resolve a target, pick the mechanism, keep one writer. Acceptance A2, A3, A5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenRequests } from "../src/openRequests.mjs";
import { UNCERTAIN_LAUNCH_HOLD_MS, createOpenSession } from "../src/openSession.mjs";

const STORE = "sha256:store";
const waitFor = async (predicate, message = "condition", timeoutMs = 3_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail(`Timed out waiting for ${message}`);
};

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function runtime(runtimeId, { sessionId = "session-a", state = "dormant", generation = 1, controllerRevision = 0, requestId = null, deadlineAt = null, pid = 500 } = {}) {
  return {
    schema: 1,
    session: { storeAuthority: STORE, sessionId },
    run: { runtimeId, generation: 1, pid, processStartedAt: 99, openedBy: requestId ? { kind: "station", requestId } : { kind: "user", requestId: null } },
    control: { pipe: `pipe-${runtimeId}` },
    link: { generation, state, attempt: 0, deadlineAt, lastError: null, controllerRevision, lastPhoneContactAt: null, phoneWatching: null, endpointRevision: 0 },
    offer: null,
    updatedAt: 1,
  };
}

/** A laptop model: live records, their command behavior, the saved sessions and the launcher. */
function world(t, { now = () => Date.now() } = {}) {
  const baseDir = mkdtempSync(join(tmpdir(), "weft-open-session-"));
  t.after(() => rmSync(baseDir, { recursive: true, force: true }));
  const state = {
    live: [],
    unverified: [],
    legacy: [],
    saved: new Map([["session-a", { sessionId: "session-a", cwd: baseDir, title: "Work" }]]),
    behaviors: new Map(),
    commands: [],
    launches: [],
    launchGate: null,
    statuses: [],
    terminated: [],
  };
  const scan = async () => ({
    live: [...state.live],
    foreign: [],
    unverified: [...state.unverified],
    legacyOwners: [...state.legacy],
    sessions: Object.values(state.live.reduce((groups, record) => {
      const key = record.session.sessionId;
      groups[key] ??= { key: record.session, runtimes: [], ownerConflict: false };
      groups[key].runtimes.push(record);
      groups[key].ownerConflict = groups[key].runtimes.length > 1;
      return groups;
    }, {})),
  });
  const control = (record) => ({
    async command(name, payload) {
      state.commands.push([record.run.runtimeId, name, payload]);
      const behavior = state.behaviors.get(record.run.runtimeId) ?? {};
      if (behavior.unresponsive) throw Object.assign(new Error("timed out"), { timeout: true, code: "timeout" });
      const handler = behavior[name];
      if (handler) return handler(payload, record);
      if (name === "probe") return { runtimeId: record.run.runtimeId, link: record.link, controllerDeviceId: behavior.controller ?? null };
      if (name === "activate") {
        record.link = { ...record.link, state: "waiting", generation: record.link.generation + 1 };
        return { state: "waiting", pairingPayload: { token: `grant-${record.run.runtimeId}` } };
      }
      if (name === "resetLink") {
        record.link = { ...record.link, state: "connecting", generation: record.link.generation + 1, deadlineAt: Date.now() + 30_000 };
        return { result: "reset", generation: record.link.generation };
      }
      return {};
    },
  });
  const make = (overrides = {}) => createOpenSession({
    requests: createOpenRequests({ baseDir, now }),
    scan,
    control,
    storeAuthority: STORE,
    now,
    pollMs: 5,
    runtimeDeadlineMs: 2_000,
    linkDeadlineMs: 2_000,
    randomId: (() => { let n = 0; return () => `challenge-${++n}`; })(),
    isPidAlive: (pid) => (state.alivePids ? state.alivePids.has(pid) : null),
    sessions: { resolve: async (sessionId) => state.saved.get(sessionId) ?? null },
    projects: { resolve: async (name) => (name === "app" ? { name: "app", path: baseDir } : null) },
    identities: { create: async ({ requestId }) => ({ channelId: `chan-${requestId}`, pairingPayload: { token: `token-${requestId}` } }) },
    launcher: {
      async launch(launch) {
        state.launches.push(launch);
        if (state.launchGate) await state.launchGate.promise;
        return { ok: true, pid: null };
      },
    },
    processes: {
      terminate: async (record) => { state.terminated.push(record.run.runtimeId); return { ok: true }; },
      confirmExit: async (record) => { state.live = state.live.filter((item) => item !== record); return { ok: true }; },
    },
    onStatus: (status) => state.statuses.push(status),
    ...overrides,
  });
  return { baseDir, state, make };
}

const openExisting = (opener, requestId, requester = "phone-1", sessionId = "session-a") =>
  opener.open({ requestId, target: { sessionId }, options: { permissionMode: "default" } }, { requester });

test("a new session is started once and is done when its runtime's link is waiting", async (t) => {
  const { state, make } = world(t);
  const opener = make();
  const first = await opener.open({ requestId: "new-1", target: { project: "app" }, options: { title: "Fix" } }, { requester: "phone-1" });
  assert.equal(first.stage, "awaiting-runtime");
  assert.equal(first.result.action, "start");
  assert.equal(first.result.payload.token, "token-new-1", "the phone gets the pairing payload to join");
  assert.equal(state.launches.length, 1);
  assert.equal(state.launches[0].resumeSessionId, null);
  assert.equal(state.launches[0].title, "Fix");
  const duplicate = await opener.open({ requestId: "new-1", target: { project: "app" }, options: { title: "Fix" } }, { requester: "phone-1" });
  assert.equal(duplicate.requestId, "new-1");
  assert.equal(state.launches.length, 1, "a duplicate delivery never launches again");
  const launched = runtime("rt-new", { sessionId: "session-new", requestId: "new-1", state: "connecting" });
  state.live.push(launched);
  await waitFor(() => state.statuses.some((status) => status.requestId === "new-1" && status.stage === "preparing-link"), "preparing-link");
  launched.link = { ...launched.link, state: "waiting" };
  const done = await waitFor(() => state.statuses.find((status) => status.requestId === "new-1" && status.outcome === "done"), "done");
  assert.equal(done.result.runtimeId, "rt-new");
  const reused = await opener.open({ requestId: "new-1", target: { project: "other" } }, { requester: "phone-1" });
  assert.equal(reused.reason, "invalid-request", "a reused id with other fields is rejected");
  await opener.idle();
});

test("an existing session with no proven writer is resumed once; a missing one is not-found", async (t) => {
  const { state, make } = world(t);
  const opener = make();
  const resumed = await openExisting(opener, "open-1");
  assert.equal(resumed.result.action, "resume");
  assert.equal(state.launches[0].resumeSessionId, "session-a");
  const missing = await openExisting(opener, "open-2", "phone-1", "session-gone");
  assert.equal(missing.outcome, "failed");
  assert.equal(missing.reason, "not-found");
  opener.stop();
});

test("an owner that cannot be proven is never resumed next to (owner-unknown)", async (t) => {
  const { state, make } = world(t);
  state.unverified.push({ sessionId: "session-a", storeAuthority: STORE, pid: 9 });
  const unverifiable = await openExisting(make(), "open-1");
  assert.equal(unverifiable.reason, "owner-unknown");
  state.unverified = [];
  state.legacy.push({ sessionId: "session-a", storeAuthority: null, pid: 10 });
  assert.equal((await openExisting(make(), "open-2")).reason, "owner-unknown", "a live old-version owner blocks too");
  state.legacy = [];
  state.live.push(runtime("rt-1"), runtime("rt-2", { pid: 501 }));
  assert.equal((await openExisting(make(), "open-3")).reason, "owner-unknown", "two writers fail closed");
  assert.equal(state.launches.length, 0);
});

test("a live dormant session is activated in place; a linked one is done; a stuck one is repaired", async (t) => {
  const { state, make } = world(t);
  const dormant = runtime("rt-1");
  state.live.push(dormant);
  const opener = make();
  const activated = await openExisting(opener, "open-1");
  assert.equal(activated.outcome, "done");
  assert.equal(activated.result.action, "activate");
  assert.equal(activated.result.payload.token, "grant-rt-1");
  assert.deepEqual(state.commands.filter(([, name]) => name === "activate").map(([, , payload]) => payload),
    [{ requestId: "open-1", requesterId: "phone-1" }]);

  dormant.link = { ...dormant.link, state: "linked" };
  const linked = await openExisting(opener, "open-2");
  assert.equal(linked.outcome, "done");

  dormant.link = { ...dormant.link, state: "connecting", deadlineAt: Date.now() - 1, generation: 7 };
  const repaired = await openExisting(opener, "open-3");
  assert.equal(repaired.result.action, "repair");
  assert.deepEqual(state.commands.find(([, name]) => name === "resetLink")[2], { opId: "open-3", expectGeneration: 7, by: "station" });
  assert.equal(state.launches.length, 0, "a live runtime is never resumed next to");
  await opener.idle();
});

test("A5: a takeover confirmed after the controller changed is rejected as stale", async (t) => {
  const { state, make } = world(t);
  const live = runtime("rt-1", { state: "linked", controllerRevision: 2 });
  state.live.push(live);
  state.behaviors.set("rt-1", { controller: "phone-a" });
  const opener = make();
  const challenged = await openExisting(opener, "take-1", "phone-b");
  assert.equal(challenged.stage, "awaiting-confirmation");
  assert.equal(challenged.reason, "controller-conflict");
  assert.deepEqual(challenged.result.challenge, { challengeId: "challenge-1", runtimeId: "rt-1", controllerRevision: 2 });
  assert.equal(challenged.result.challengeProof, undefined, "private proof never reaches the phone");

  live.link = { ...live.link, controllerRevision: 3 };
  const stale = await opener.confirmTakeover({ requestId: "take-1", challengeId: "challenge-1", revision: challenged.revision });
  assert.equal(stale.outcome, "failed");
  assert.equal(stale.reason, "takeover-stale");
  assert.equal(state.commands.filter(([, name]) => name === "replaceController").length, 0);

  const again = await openExisting(opener, "take-2", "phone-b");
  const wrong = await opener.confirmTakeover({ requestId: "take-2", challengeId: "forged", revision: again.revision });
  assert.equal(wrong.reason, "takeover-stale");
  const third = await openExisting(opener, "take-3", "phone-b");
  const old = await opener.confirmTakeover({ requestId: "take-3", challengeId: third.result.challenge.challengeId, revision: third.revision - 1 });
  assert.equal(old.reason, "takeover-stale", "a stale revision cannot confirm");
});

test("a current takeover replaces the controller in the running session, never relaunching it", async (t) => {
  const { state, make } = world(t);
  const live = runtime("rt-1", { state: "linked", controllerRevision: 4 });
  state.live.push(live);
  state.behaviors.set("rt-1", {
    controller: "phone-a",
    replaceController: ({ expectControllerRevision }) => {
      assert.equal(expectControllerRevision, 4);
      live.link = { ...live.link, controllerRevision: 5, state: "waiting" };
      return { pairingPayload: { token: "fresh-grant" }, controllerRevision: 5 };
    },
  });
  const opener = make();
  const challenged = await openExisting(opener, "take-1", "phone-b");
  const confirmed = await opener.confirmTakeover({ requestId: "take-1", challengeId: challenged.result.challenge.challengeId, revision: challenged.revision });
  assert.equal(confirmed.stage, "preparing-link");
  assert.equal(confirmed.result.action, "takeover");
  assert.equal(confirmed.result.payload.token, "fresh-grant");
  assert.equal(confirmed.result.challenge, undefined);
  await waitFor(() => state.statuses.find((status) => status.requestId === "take-1" && status.outcome === "done"), "done");
  assert.equal(state.launches.length, 0);
});

test("an unresponsive session is only restarted after confirmation and proof that it exited", async (t) => {
  const { state, make } = world(t);
  state.live.push(runtime("rt-1", { state: "linked" }));
  state.behaviors.set("rt-1", { unresponsive: true });
  const opener = make();
  const challenged = await openExisting(opener, "restart-1");
  assert.equal(challenged.stage, "awaiting-confirmation");
  assert.equal(challenged.reason, "runtime-unavailable");
  assert.equal(state.launches.length, 0, "an unresponsive runtime is reported, not replaced");
  const confirmed = await opener.confirmTakeover({ requestId: "restart-1", challengeId: challenged.result.challenge.challengeId, revision: challenged.revision });
  assert.deepEqual(state.terminated, ["rt-1"]);
  assert.equal(confirmed.result.action, "resume");
  assert.equal(state.launches.length, 1);
  opener.stop();
});

test("A3: a cancel that races dispatch ends cancelled with mayBeRunning and the late runtime is never relaunched", async (t) => {
  const { state, make } = world(t);
  state.launchGate = deferred();
  const opener = make();
  const opening = openExisting(opener, "open-1");
  await waitFor(() => state.launches.length === 1, "launch in flight");
  const dispatching = await opener.inspect("open-1");
  assert.equal(dispatching.stage, "dispatching");
  const cancelled = await opener.cancel("open-1", dispatching.revision);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.result.mayBeRunning, true);
  state.launchGate.resolve();
  const settled = await opening;
  assert.equal(settled.outcome, "cancelled", "the launch result cannot resurrect a cancelled request");

  const again = await openExisting(opener, "open-2");
  assert.equal(again.reason, "owner-unknown", "a launch that may be running blocks a second writer");
  state.live.push(runtime("rt-late", { requestId: "open-1", state: "waiting" }));
  const later = await openExisting(opener, "open-3");
  assert.equal(later.outcome, "done");
  assert.equal(later.result.action, "activate");
  assert.equal((await opener.inspect("open-1")).outcome, "cancelled");
  assert.equal(state.launches.length, 1, "no relaunch");
  await opener.idle();
});

test("a cancel before dispatch never launches; a stale cancel revision changes nothing", async (t) => {
  const { state, make } = world(t);
  const live = runtime("rt-1", { state: "linked", controllerRevision: 1 });
  state.live.push(live);
  state.behaviors.set("rt-1", { controller: "phone-a" });
  const opener = make();
  const challenged = await openExisting(opener, "take-1", "phone-b");
  const stale = await opener.cancel("take-1", challenged.revision - 1);
  assert.equal(stale.outcome, null);
  const cancelled = await opener.cancel("take-1", challenged.revision);
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(cancelled.result.mayBeRunning, undefined);
});

test("A2: two open requests for one session across a reload and a Station restart yield one writer", async (t) => {
  const { state, make } = world(t);
  state.launchGate = deferred();
  const stationA = make();
  const first = openExisting(stationA, "open-1", "phone-1");
  await waitFor(() => state.launches.length === 1, "first resume dispatched");
  const second = await openExisting(stationA, "open-2", "phone-2");
  assert.equal(second.requestId, "open-2");
  assert.equal(second.stage, "dispatching", "the second request follows the first instead of launching");
  state.launchGate.resolve();
  await first;
  stationA.stop();

  // Station restarts while the resumed session is still loading Weft (and then reloads it).
  const stationB = make();
  const third = await openExisting(stationB, "open-3", "phone-1");
  assert.equal(third.stage, "awaiting-runtime", "a request after the restart joins too");
  await stationB.reconcile();
  const resumed = runtime("rt-resumed", { requestId: "open-1", state: "connecting" });
  state.live.push(resumed);
  resumed.run = { ...resumed.run, generation: 2 };
  resumed.link = { ...resumed.link, state: "waiting", generation: 3 };
  for (const id of ["open-1", "open-2", "open-3"]) {
    await waitFor(async () => (await stationB.inspect(id))?.outcome === "done", `${id} done`);
  }
  assert.equal(state.launches.length, 1, "exactly one writer was ever launched");
  assert.equal(state.live.filter((record) => record.session.sessionId === "session-a").length, 1);
  await stationB.idle();
});

test("Station restart mid-dispatch reports outcome-unknown and holds the session for a while", async (t) => {
  let clock = Date.now();
  const { state, make } = world(t, { now: () => clock });
  const stationA = make();
  state.launchGate = deferred();
  void openExisting(stationA, "open-1");
  await waitFor(() => state.launches.length === 1, "dispatching");
  stationA.stop();
  const stationB = make();
  const [recovered] = await stationB.reconcile();
  assert.equal(recovered.outcome, "outcome-unknown");
  assert.equal(recovered.result.mayBeRunning, true);
  assert.equal((await openExisting(stationB, "open-2")).reason, "owner-unknown");
  state.launchGate.resolve();
  state.launchGate = null;
  clock += UNCERTAIN_LAUNCH_HOLD_MS + 1;
  const later = await openExisting(stationB, "open-3");
  assert.equal(later.result.action, "resume", "after the hold, a proven-empty session can be resumed");
  assert.equal((await stationB.inspect("open-1")).outcome, "outcome-unknown", "the late launch result changes nothing");
  stationB.stop();
});

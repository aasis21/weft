import { test } from "node:test";
import assert from "node:assert/strict";

import { LABELS, REASONS, sessionHealth } from "../sessionHealth.mjs";

const NOW = 1_800_000_000_000;

function record(link = {}, extra = {}) {
  return {
    schema: 1,
    session: { storeAuthority: "sha256:store", sessionId: "session-1" },
    run: { runtimeId: "runtime-1", generation: 1, pid: 42, processStartedAt: 1, version: "0.2.75" },
    link: { state: "linked", generation: 3, controllerRevision: 2, endpointRevision: 1, phoneWatching: true, ...link },
    updatedAt: NOW - 1_000,
    ...extra,
  };
}

const station = (facts = {}) => ({ observer: "station", processAlive: true, ...facts });
const health = (rec, obs) => {
  const { label, reason } = sessionHealth(rec, obs, NOW);
  assert.ok(LABELS.includes(label) && (reason === null || REASONS.includes(reason)));
  return [label, reason];
};

test("written link states project to themselves when nothing is wrong", () => {
  for (const state of ["dormant", "waiting", "linked", "ending"]) {
    assert.deepEqual(health(record({ state }), station()), [state, null]);
  }
  assert.deepEqual(health(record({ state: "connecting", deadlineAt: NOW + 1 }), station()), ["connecting", null]);
  assert.deepEqual(health(record({ state: "connecting", deadlineAt: NOW }), station()), ["connecting", null]);
  assert.deepEqual(health(record({ state: "connecting" }), station()), ["connecting", null]);
});

test("a missing record is gone unless a live process might still own the session", () => {
  assert.deepEqual(health(null, station({ processAlive: false })), ["gone", null]);
  assert.deepEqual(health(null, null), ["gone", null]);
  assert.deepEqual(health(null, station({ processAlive: true })), ["stalled", "owner-unknown"]);
  assert.deepEqual(health(null, station({ processAlive: null, ownerUnknown: true })), ["stalled", "owner-unknown"]);
});

test("a proven-dead process makes even a linked record gone", () => {
  assert.deepEqual(health(record(), station({ processAlive: false, probe: { ok: false, at: NOW, misses: 5 } })), [
    "gone",
    null,
  ]);
});

test("records this build cannot read ask for an update", () => {
  assert.deepEqual(health(record({}, { schema: 2 }), station()), ["stalled", "update-required"]);
  assert.deepEqual(health(record({ state: "stalled" }), station()), ["stalled", "update-required"]);
});

test("unprovable or conflicting ownership is owner-unknown and outranks link state", () => {
  assert.deepEqual(health(record(), station({ ownerConflict: true })), ["stalled", "owner-unknown"]);
  assert.deepEqual(health(record({ state: "ending" }), station({ ownerUnknown: true })), ["stalled", "owner-unknown"]);
});

test("an ending session stays ending even when its pipe stops answering", () => {
  assert.deepEqual(health(record({ state: "ending" }), station({ probe: { ok: false, at: NOW, misses: 3 } })), [
    "ending",
    null,
  ]);
});

test("two consecutive probe misses mean unresponsive, one does not", () => {
  const probe = (misses) => station({ probe: { ok: misses === 0, at: NOW, misses } });
  assert.deepEqual(health(record(), probe(1)), ["linked", null]);
  assert.deepEqual(health(record({ phoneWatching: false }), probe(2)), ["stalled", "unresponsive"]);
  assert.deepEqual(
    health(record({ state: "connecting", deadlineAt: NOW - 1 }), { ...probe(2), episode: { attempts: 2, exhausted: true } }),
    ["stalled", "unresponsive"],
  );
});

test("an exhausted repair episode needs attention ahead of link-stuck", () => {
  const stuck = record({ state: "connecting", deadlineAt: NOW - 1 });
  assert.deepEqual(health(stuck, station({ episode: { attempts: 1, exhausted: false } })), ["stalled", "link-stuck"]);
  assert.deepEqual(health(stuck, station({ episode: { attempts: 2, exhausted: true }, sharedOutage: true })), [
    "stalled",
    "needs-attention",
  ]);
});

test("configuration errors surface while connecting or dormant, regardless of deadline or outage", () => {
  const lastError = { code: "auth-failed", at: NOW - 5 };
  assert.deepEqual(
    health(record({ state: "connecting", deadlineAt: NOW + 10_000, lastError }), station({ sharedOutage: true })),
    ["stalled", "config-error"],
  );
  assert.deepEqual(health(record({ state: "dormant", lastError }), station()), ["stalled", "config-error"]);
  assert.deepEqual(health(record({ state: "linked", lastError }), station()), ["linked", null], "a past error is history");
  assert.deepEqual(
    health(record({ state: "connecting", deadlineAt: NOW + 1, lastError: { code: "subscribe-timeout", at: NOW } }), station()),
    ["connecting", null],
  );
});

test("connecting past its deadline is link-stuck, or shared-outage when every session is stuck", () => {
  const stuck = record({ state: "connecting", deadlineAt: NOW - 1 });
  assert.deepEqual(health(stuck, station()), ["stalled", "link-stuck"]);
  assert.deepEqual(health(stuck, station({ sharedOutage: true })), ["stalled", "shared-outage"]);
  assert.deepEqual(health(record(), station({ sharedOutage: true })), ["linked", null]);
});

test("a background phone is phone-away, never stalled", () => {
  const quiet = record({ phoneWatching: false, lastPhoneContactAt: NOW - 60 * 60_000 });
  assert.deepEqual(health(quiet, station()), ["linked", "phone-away"]);
  assert.deepEqual(health(quiet, { observer: "phone", phone: { lastTrafficAt: NOW - 60 * 60_000 } }), [
    "linked",
    "phone-away",
  ]);
});

test("a phone behind on controller or endpoint revision is told why", () => {
  const phone = (facts) => ({ observer: "phone", phone: facts });
  assert.deepEqual(health(record(), phone({ controllerRevision: 1 })), ["stalled", "controller-conflict"]);
  assert.deepEqual(health(record(), phone({ controllerRevision: 2, endpointRevision: 0 })), [
    "stalled",
    "endpoint-changed",
  ]);
  assert.deepEqual(health(record(), phone({ controllerRevision: 3, endpointRevision: 1 })), ["linked", null]);
});

test("a handshake failure newer than phone traffic marks a waiting or linked link stuck", () => {
  const phone = (facts, extra = {}) => ({ observer: "phone", phone: facts, ...extra });
  assert.deepEqual(health(record({ state: "waiting" }), phone({ handshakeFailedAt: NOW - 10 })), ["stalled", "link-stuck"]);
  assert.deepEqual(health(record(), phone({ handshakeFailedAt: NOW - 10, lastTrafficAt: NOW - 5 })), ["linked", null]);
  assert.deepEqual(
    health(record(), phone({ handshakeFailedAt: NOW - 5, lastTrafficAt: NOW - 10 }, { sharedOutage: true })),
    ["stalled", "shared-outage"],
  );
});

test("output names the observer and the freshest fact behind the verdict", () => {
  assert.deepEqual(sessionHealth(record(), null, NOW), {
    label: "linked",
    reason: null,
    observer: "session",
    freshAt: NOW - 1_000,
  });
  assert.deepEqual(
    sessionHealth(record(), { observer: "station", probe: { ok: true, at: NOW - 10, misses: 0 } }, NOW),
    { label: "linked", reason: null, observer: "station", freshAt: NOW - 10 },
  );
  assert.equal(sessionHealth(null, { observer: "phone", phone: { lastTrafficAt: NOW - 3 } }, NOW).freshAt, NOW - 3);
  assert.equal(sessionHealth(null, null, NOW).freshAt, null);
});

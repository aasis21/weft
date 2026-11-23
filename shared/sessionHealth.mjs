// SPDX-License-Identifier: Apache-2.0
// Weft session health — one pure projection shared by the phone, Station and Control Center.
//
// A session writes facts about itself (`~/.weft/sessions-live/<runtimeId>.json`); Station and the
// phone observe it from outside. Health is DERIVED from both: a wedged session cannot report that
// it is wedged, so this function never trusts a self-reported "healthy" over an outside fact.
//
// Precedence (first match wins) is documented in sessionHealth.d.ts and pinned by
// shared/test/sessionHealth.test.mjs.

export const LABELS = Object.freeze([
  "dormant",
  "connecting",
  "waiting",
  "linked",
  "stalled",
  "ending",
  "gone",
]);

export const REASONS = Object.freeze([
  "phone-away",
  "link-stuck",
  "unresponsive",
  "owner-unknown",
  "controller-conflict",
  "endpoint-changed",
  "config-error",
  "shared-outage",
  "needs-attention",
  "update-required",
]);

/**
 * `link.lastError.code` values that retrying cannot fix: the session needs a configuration or
 * credential change, so the supervisor surfaces them instead of repairing.
 */
export const CONFIG_ERROR_CODES = Object.freeze([
  "auth-failed",
  "forbidden",
  "invalid-config",
  "missing-config",
  "unsupported-transport",
  "identity-invalid",
]);

/** The live-record schema this projection understands (LLD §3.1). */
export const SESSION_RECORD_SCHEMA = 1;

/** Consecutive missed pipe probes before a live runtime counts as unresponsive. */
export const UNRESPONSIVE_PROBE_MISSES = 2;

const LINK_STATES = new Set(["dormant", "connecting", "waiting", "linked", "ending"]);
const OBSERVERS = new Set(["station", "phone"]);

const finite = (value) => (Number.isFinite(value) ? value : null);

function freshestFact(record, observation) {
  const times = [
    record?.updatedAt,
    observation?.probe?.at,
    observation?.phone?.lastTrafficAt,
    observation?.phone?.handshakeFailedAt,
  ].filter(Number.isFinite);
  return times.length > 0 ? Math.max(...times) : null;
}

// The phone (or Station on its behalf) last saw an older revision than the session now holds.
const behind = (known, current) =>
  Number.isFinite(known) && Number.isFinite(current) && known < current;

function classify(record, observation, now) {
  if (!record) {
    return observation?.processAlive === true || observation?.ownerUnknown || observation?.ownerConflict
      ? ["stalled", "owner-unknown"]
      : ["gone", null];
  }
  if (observation?.processAlive === false) return ["gone", null];

  const link = record.link ?? { state: "dormant" };
  if (record.schema !== SESSION_RECORD_SCHEMA || !LINK_STATES.has(link.state)) {
    return ["stalled", "update-required"];
  }
  if (observation?.ownerConflict || observation?.ownerUnknown) return ["stalled", "owner-unknown"];
  if (link.state === "ending") return ["ending", null];
  if ((observation?.probe?.misses ?? 0) >= UNRESPONSIVE_PROBE_MISSES) return ["stalled", "unresponsive"];
  if (observation?.episode?.exhausted) return ["stalled", "needs-attention"];
  if (
    (link.state === "connecting" || link.state === "dormant") &&
    CONFIG_ERROR_CODES.includes(link.lastError?.code)
  ) {
    return ["stalled", "config-error"];
  }

  const phone = observation?.phone;
  if (behind(phone?.controllerRevision, link.controllerRevision)) return ["stalled", "controller-conflict"];
  if (behind(phone?.endpointRevision, link.endpointRevision)) return ["stalled", "endpoint-changed"];

  const stuckReason = observation?.sharedOutage ? "shared-outage" : "link-stuck";
  if (link.state === "connecting") {
    const deadlineAt = finite(link.deadlineAt);
    return deadlineAt !== null && now > deadlineAt ? ["stalled", stuckReason] : ["connecting", null];
  }
  if (
    (link.state === "waiting" || link.state === "linked") &&
    Number.isFinite(phone?.handshakeFailedAt) &&
    phone.handshakeFailedAt > (finite(phone.lastTrafficAt) ?? -Infinity)
  ) {
    return ["stalled", stuckReason];
  }
  if (link.state === "linked") return ["linked", link.phoneWatching === false ? "phone-away" : null];
  return [link.state, null];
}

/**
 * Derive `{ label, reason, observer, freshAt }` for one session.
 *
 * @param {object | null} record       the session's live record, or null when the observer looked
 *                                     and found none.
 * @param {object | null} [observation] outside facts from Station or the phone.
 * @param {number} [now]               epoch ms; injected for determinism.
 */
export function sessionHealth(record, observation = null, now = Date.now()) {
  const [label, reason] = classify(record ?? null, observation ?? null, now);
  return {
    label,
    reason,
    observer: OBSERVERS.has(observation?.observer) ? observation.observer : "session",
    freshAt: freshestFact(record, observation),
  };
}

// SPDX-License-Identifier: Apache-2.0
//
// Open a session for the phone (LLD §4.2). The phone names a TARGET — a project for a new session
// or a saved sessionId — and Station decides the mechanism:
//
//   accepted → resolving ─┬─ live runtime, responsive ─────────► activate | repair → done
//                         ├─ live runtime, other controller ───► awaiting-confirmation ─confirm→ takeover
//                         ├─ live runtime, unresponsive ───────► awaiting-confirmation ─confirm→ restart
//                         ├─ owner cannot be proven ───────────► failed(owner-unknown)
//                         ├─ no live writer (proven) ──────────► dispatching → awaiting-runtime
//                         │                                       → preparing-link → done
//                         └─ target missing ───────────────────► failed(not-found)
//   cancel before dispatch → cancelled; after → cancelled + result.mayBeRunning (never relaunched)
//
// `done` means a responsive runtime exists for the target AND its link reached waiting or linked.
import { normalizeOpenRequest, openRequestFingerprint, lifecycleStatus } from "@aasis21/weft-shared";
import { isTerminal, wasDispatched } from "./openRequests.mjs";
import { ownerOf } from "./sessionRegistry.mjs";

const READY_LINK_STATES = new Set(["waiting", "linked"]);
export const RUNTIME_DEADLINE_MS = 3 * 60_000;
export const LINK_DEADLINE_MS = 60_000;
/** A launch whose outcome is unknown blocks a second launch of the same session for this long. */
export const UNCERTAIN_LAUNCH_HOLD_MS = 10 * 60_000;

/** The public (phone-safe) snapshot of a request. Private fields never leave Station. */
export function requestSnapshot(record) {
  if (!record) return null;
  const { challengeProof: _proof, ...rest } = record.result ?? {};
  const result = Object.fromEntries(Object.entries(rest).filter(([, value]) => value !== null && value !== undefined));
  return {
    requestId: record.requestId,
    revision: record.revision,
    stage: record.stage,
    outcome: record.outcome ?? null,
    reason: record.reason ?? null,
    result: Object.keys(result).length ? result : null,
  };
}

export function createOpenSession({
  requests,
  scan,
  control,
  sessions,
  projects,
  identities,
  launcher,
  processes = {},
  storeAuthority,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  randomId = () => globalThis.crypto.randomUUID(),
  isPidAlive = () => null,
  onStatus = () => {},
  log = () => {},
  runtimeDeadlineMs = RUNTIME_DEADLINE_MS,
  linkDeadlineMs = LINK_DEADLINE_MS,
  pollMs = 1_000,
  commandTimeoutMs = 5_000,
} = {}) {
  const inflight = new Map();
  const watchers = new Map();
  let stopped = false;

  // ---- status fan-out -------------------------------------------------------------------------

  function joinedSnapshot(record) {
    const holder = requests.read(record.joinedRequestId);
    if (!holder || isTerminal(record)) return requestSnapshot(record);
    const view = requestSnapshot(holder);
    return { ...view, requestId: record.requestId, revision: holder.revision + record.revision };
  }

  function snapshot(record) {
    if (!record) return null;
    return record.joinedRequestId ? joinedSnapshot(record) : requestSnapshot(record);
  }

  async function emit(record) {
    if (!record) return record;
    log("open.stage", { requestId: record.requestId, stage: record.stage, outcome: record.outcome, reason: record.reason });
    try { await onStatus(snapshot(record)); } catch { /* the phone re-requests status */ }
    // Requests that joined this one follow its progress, and its outcome when it ends.
    for (const joiner of requests.list({ nonTerminal: true }).filter((item) => item.joinedRequestId === record.requestId)) {
      if (isTerminal(record)) {
        const { record: ended } = await requests.update(joiner.requestId, {
          outcome: record.outcome, reason: record.reason, result: record.result,
        });
        if (ended) try { await onStatus(snapshot(ended)); } catch { /* best effort */ }
      } else {
        try { await onStatus(snapshot(joiner)); } catch { /* best effort */ }
      }
    }
    return record;
  }

  async function transition(record, patch, { fenced = true } = {}) {
    const { applied, record: next } = await requests.update(record.requestId, patch,
      fenced ? { expectRevision: record.revision } : {});
    if (applied) await emit(next);
    return { applied, record: next };
  }

  const fail = (record, reason, message, extra = {}) =>
    transition(record, { outcome: "failed", reason, result: { ...(message ? { message } : {}), ...extra } }, { fenced: false });

  // ---- helpers --------------------------------------------------------------------------------

  async function command(record, name, payload) {
    return control(record).command(name, payload, { timeoutMs: commandTimeoutMs });
  }

  async function probe(record, attempts = 2) {
    let lastError = null;
    for (let index = 0; index < attempts; index += 1) {
      try {
        return { ok: true, result: await command(record, "probe") };
      } catch (error) {
        lastError = error;
      }
    }
    return { ok: false, error: lastError };
  }

  function keyOf(target) {
    return target?.sessionId ? { storeAuthority: target.storeAuthority ?? storeAuthority, sessionId: target.sessionId } : null;
  }

  /** Launches that may still be starting for this session (they block a second launch). */
  function pendingLaunches(key, current, scanned) {
    const referenced = new Set(scanned.live.map((record) => record.run.openedBy?.requestId).filter(Boolean));
    return requests.list()
      .filter((item) => item.requestId !== current && item.lockKey?.sessionId === key.sessionId &&
        (item.lockKey?.storeAuthority ?? storeAuthority) === key.storeAuthority)
      .filter((item) => !referenced.has(item.requestId))
      .filter((item) => {
        const pid = item.result?.pid;
        if (Number.isSafeInteger(pid) && pid > 0 && isPidAlive(pid) === true) return true;
        if (!isTerminal(item)) return wasDispatched(item);
        return item.result?.mayBeRunning === true && now() - (item.finishedAt ?? 0) < UNCERTAIN_LAUNCH_HOLD_MS;
      })
      .map((item) => ({ ...key, requestId: item.requestId, alive: true }));
  }

  // ---- resolution -----------------------------------------------------------------------------

  async function drive(record) {
    let current = record;
    if (current.stage === "accepted") {
      const moved = await transition(current, { stage: "resolving" });
      if (!moved.applied) return moved.record;
      current = moved.record;
    }
    if (current.target?.project !== undefined && !current.target?.sessionId) {
      const project = await projects.resolve(current.target.project);
      if (!project) return (await fail(current, "not-found", `Unknown project: ${current.target.project}`)).record;
      return dispatch(current, { action: "start", project, resumeSessionId: null });
    }
    const key = keyOf(current.target);
    const scanned = await scan();
    const owner = ownerOf(scanned, key, { launches: pendingLaunches(key, current.requestId, scanned) });
    if (owner.state === "conflict") {
      return (await fail(current, "owner-unknown", "More than one Copilot process writes this session.")).record;
    }
    if (owner.state === "unknown") {
      return (await fail(current, "owner-unknown", "A Copilot process may still hold this session; Weft cannot prove which.")).record;
    }
    if (owner.state === "live") return handleLive(current, owner.runtime);
    const saved = await sessions.resolve(key.sessionId);
    if (!saved) return (await fail(current, "not-found", "That session is no longer in the Copilot session store.")).record;
    if (saved.directoryExists === false) {
      return (await fail(current, "not-found", "The session's working folder is unavailable.")).record;
    }
    return dispatch(current, {
      action: "resume",
      project: { name: saved.title ?? "resume", path: saved.cwd },
      resumeSessionId: key.sessionId,
    });
  }

  async function challenge(record, runtime, { kind, controllerRevision, controllerName = null }) {
    return (await transition(record, {
      stage: "awaiting-confirmation",
      reason: kind === "restart" ? "runtime-unavailable" : "controller-conflict",
      result: {
        runtimeId: runtime.run.runtimeId,
        challenge: {
          challengeId: randomId(),
          runtimeId: runtime.run.runtimeId,
          controllerRevision,
          ...(controllerName ? { controllerName } : {}),
        },
        challengeProof: {
          kind,
          pid: runtime.run.pid,
          processStartedAt: runtime.run.processStartedAt,
          generation: runtime.run.generation,
        },
      },
    })).record;
  }

  async function handleLive(record, runtime) {
    const probed = await probe(runtime);
    if (!probed.ok) {
      return challenge(record, runtime, { kind: "restart", controllerRevision: runtime.link.controllerRevision });
    }
    const facts = probed.result ?? {};
    const link = facts.link ?? runtime.link;
    if (facts.controllerDeviceId && record.requester && facts.controllerDeviceId !== record.requester) {
      return challenge(record, runtime, {
        kind: "takeover", controllerRevision: link.controllerRevision ?? 0, controllerName: facts.controllerName,
      });
    }
    if (link.state === "linked") {
      return (await transition(record, {
        outcome: "done", reason: null, result: { action: "activate", runtimeId: runtime.run.runtimeId, sessionId: runtime.session.sessionId },
      })).record;
    }
    const stuck = link.state === "connecting" && Number.isFinite(link.deadlineAt) && now() > link.deadlineAt;
    let payload = null;
    let action = "activate";
    try {
      if (stuck) {
        action = "repair";
        await command(runtime, "resetLink", { opId: record.requestId, expectGeneration: link.generation, by: "station" });
      }
      const activated = await command(runtime, "activate", { requestId: record.requestId, requesterId: record.requester });
      if (activated?.controllerConflict) {
        return challenge(record, runtime, {
          kind: "takeover", controllerRevision: activated.controllerRevision ?? 0, controllerName: activated.phoneName,
        });
      }
      payload = activated?.pairingPayload ?? null;
    } catch (error) {
      if (error?.timeout) {
        return (await transition(record, {
          outcome: "outcome-unknown", reason: "timeout",
          result: { action, runtimeId: runtime.run.runtimeId, message: "The session did not answer in time; it may still be connecting." },
        }, { fenced: false })).record;
      }
      return (await fail(record, "runtime-unavailable", error?.message ?? "The session refused activation.")).record;
    }
    const moved = await transition(record, {
      stage: "preparing-link",
      result: { action, runtimeId: runtime.run.runtimeId, sessionId: runtime.session.sessionId, ...(payload ? { payload } : {}) },
    });
    if (!moved.applied) return moved.record;
    return watchLink(moved.record, runtime);
  }

  /** Poll the session (fresh probe facts) until its link is waiting/linked or the deadline passes. */
  async function watchLink(record, runtime) {
    const deadline = now() + linkDeadlineMs;
    let current = record;
    while (!stopped) {
      current = requests.read(current.requestId) ?? current;
      if (isTerminal(current)) return current;
      const probed = await probe(runtime, 1);
      if (probed.ok && READY_LINK_STATES.has(probed.result?.link?.state)) {
        return (await transition(current, { outcome: "done", reason: null }, { fenced: false })).record;
      }
      if (now() >= deadline) {
        return (await fail(current, "link-failed", "The session is running but its phone link is not ready yet. It keeps retrying.")).record;
      }
      await sleep(pollMs);
    }
    return current;
  }

  // ---- dispatch (start / resume) ----------------------------------------------------------------

  async function dispatch(record, { action, project, resumeSessionId }) {
    let identity;
    try {
      identity = await identities.create({ requestId: record.requestId });
    } catch (error) {
      return (await fail(record, "internal-error", error?.message ?? "Could not prepare the session identity.")).record;
    }
    // The effect boundary: once `dispatching` is committed a launch may happen, so a later cancel
    // reports `mayBeRunning`. A cancel that won the race leaves this update unapplied: no launch.
    const committed = await transition(record, {
      stage: "dispatching",
      reason: null,
      result: { action, ...(identity.pairingPayload ? { payload: identity.pairingPayload } : {}) },
    });
    if (!committed.applied) return committed.record;
    let launched;
    try {
      launched = await launcher.launch({
        requestId: record.requestId,
        project,
        resumeSessionId,
        mode: record.options?.permissionMode ?? "default",
        title: record.options?.title ?? null,
        identity,
        identityFile: requests.identityPath(record.requestId),
      });
    } catch (error) {
      return (await transition(committed.record, {
        outcome: "outcome-unknown", reason: "launch-failed",
        result: { mayBeRunning: true, message: error?.message ?? "The launch outcome is unknown." },
      }, { fenced: false })).record;
    }
    if (launched?.ok === false) {
      return (await fail(committed.record, "launch-failed", launched.error ?? "Copilot could not be started.")).record;
    }
    const waiting = await transition(committed.record, {
      stage: "awaiting-runtime",
      result: Number.isSafeInteger(launched?.pid) && launched.pid > 0 ? { pid: launched.pid } : {},
    }, { fenced: false });
    if (!waiting.applied) return waiting.record;
    watchRuntime(waiting.record.requestId);
    return waiting.record;
  }

  /** Background: follow a launched request until its session runtime and link are ready. */
  function watchRuntime(requestId) {
    if (watchers.has(requestId)) return watchers.get(requestId);
    const running = (async () => {
      for (;;) {
        if (stopped) return null;
        let current = requests.read(requestId);
        if (!current || isTerminal(current)) return current;
        const scanned = await scan();
        const runtime = scanned.live.find((item) => item.run.openedBy?.requestId === requestId);
        if (runtime) {
          if (current.stage !== "preparing-link") {
            const moved = await transition(current, {
              stage: "preparing-link",
              result: { runtimeId: runtime.run.runtimeId, sessionId: runtime.session.sessionId },
            }, { fenced: false });
            current = moved.record;
          }
          // A handoff session refreshes its one-time grant into its own record's offer.
          const offered = runtime.offer?.payload;
          if (offered && offered.token !== current.result?.payload?.token) {
            current = (await transition(current, { result: { payload: offered } }, { fenced: false })).record;
          }
          if (READY_LINK_STATES.has(runtime.link.state)) {
            const probed = await probe(runtime, 1);
            if (probed.ok) return (await transition(current, { outcome: "done", reason: null }, { fenced: false })).record;
          }
        } else {
          const pid = current.result?.pid;
          if (Number.isSafeInteger(pid) && isPidAlive(pid) === false) {
            return (await fail(current, "launch-failed", "Copilot exited before Weft started in it.")).record;
          }
        }
        const started = current.dispatchedAt ?? current.createdAt ?? now();
        if (now() - started >= runtimeDeadlineMs + (runtime ? linkDeadlineMs : 0)) {
          return (await transition(current, {
            outcome: runtime ? "failed" : "outcome-unknown",
            reason: runtime ? "link-failed" : "runtime-unavailable",
            result: runtime ? { message: "The session started but its phone link is not ready." }
              : { mayBeRunning: true, message: "The session did not report in. It may still be starting." },
          }, { fenced: false })).record;
        }
        await sleep(pollMs);
      }
    })().catch((error) => {
      log("open.watch_failed", { requestId, error: error?.name }, { level: "warn" });
      return null;
    }).finally(() => watchers.delete(requestId));
    watchers.set(requestId, running);
    return running;
  }

  // ---- public operations --------------------------------------------------------------------------

  function invalid(requestId, message) {
    return {
      requestId: requestId ?? "",
      revision: 0,
      stage: "accepted",
      outcome: "failed",
      reason: "invalid-request",
      result: { message },
    };
  }

  async function open(request, { requester = null } = {}) {
    const normalized = normalizeOpenRequest(request);
    if (!normalized.requestId) return invalid("", "A requestId is required.");
    const target = normalized.target.sessionId
      ? { sessionId: normalized.target.sessionId, storeAuthority: normalized.target.storeAuthority ?? storeAuthority }
      : { project: normalized.target.project };
    if (!target.sessionId && !target.project) return invalid(normalized.requestId, "Choose a project or a session.");
    const fingerprint = await openRequestFingerprint(normalized, requester);
    const begun = await requests.begin({
      requestId: normalized.requestId,
      fingerprint,
      requester,
      target,
      options: normalized.options,
      lockKey: keyOf(target),
    });
    if (begun.kind === "conflict") {
      return { ...invalid(normalized.requestId, "That requestId was already used for a different request."),
        revision: begun.record.revision };
    }
    if (begun.kind === "joined") {
      log("open.joined", { requestId: normalized.requestId, holder: begun.record.joinedRequestId });
      await emit(begun.record);
      return snapshot(begun.record);
    }
    if (begun.kind === "duplicate") {
      if (!isTerminal(begun.record) && !inflight.has(normalized.requestId) && !begun.record.joinedRequestId) {
        void resumeRequest(begun.record);
      }
      return snapshot(requests.read(normalized.requestId));
    }
    await emit(begun.record);
    const running = drive(begun.record)
      .catch(async (error) => (await fail(requests.read(normalized.requestId), "internal-error", error?.message)).record)
      .finally(() => inflight.delete(normalized.requestId));
    inflight.set(normalized.requestId, running);
    return snapshot(await running);
  }

  async function inspect(requestId) {
    return snapshot(requests.read(requestId));
  }

  async function cancel(requestId, revision = null) {
    const current = requests.read(requestId);
    if (!current || isTerminal(current)) return snapshot(current);
    if (Number.isSafeInteger(revision) && revision !== current.revision && !current.joinedRequestId) {
      return snapshot(current);
    }
    const mayBeRunning = wasDispatched(current);
    const { record } = await transition(current, {
      outcome: "cancelled",
      reason: null,
      ...(mayBeRunning ? { result: { mayBeRunning: true, message: "Cancelled. The session may already be starting on the laptop." } } : {}),
    });
    return snapshot(record);
  }

  async function confirmTakeover({ requestId, challengeId, revision } = {}) {
    const current = requests.read(requestId);
    if (!current || isTerminal(current)) return snapshot(current);
    const pending = current.result?.challenge;
    if (current.stage !== "awaiting-confirmation" || !pending || pending.challengeId !== challengeId || current.revision !== revision) {
      return snapshot((await fail(current, "takeover-stale", "The takeover prompt is out of date. Try again.")).record);
    }
    const proof = current.result.challengeProof ?? {};
    const scanned = await scan();
    const owner = ownerOf(scanned, keyOf(current.target), {});
    const runtime = owner.state === "live" && owner.runtime.run.runtimeId === pending.runtimeId ? owner.runtime : null;
    if (proof.kind === "restart") return snapshot(await confirmRestart(current, runtime, proof, owner));
    if (!runtime) return snapshot((await fail(current, "takeover-stale", "The session changed before the takeover.")).record);
    const probed = await probe(runtime);
    if (!probed.ok) return snapshot((await fail(current, "runtime-unavailable", "The session stopped answering.")).record);
    if ((probed.result?.link?.controllerRevision ?? 0) !== pending.controllerRevision) {
      return snapshot((await fail(current, "takeover-stale", "Another phone took control first. Try again.")).record);
    }
    let replaced;
    try {
      replaced = await command(runtime, "replaceController", {
        opId: requestId, expectControllerRevision: pending.controllerRevision, requesterId: current.requester,
      });
    } catch (error) {
      if (error?.code === "stale") {
        return snapshot((await fail(current, "takeover-stale", "Another phone took control first. Try again.")).record);
      }
      return snapshot((await transition(current, {
        outcome: error?.timeout ? "outcome-unknown" : "failed",
        reason: error?.timeout ? "timeout" : "runtime-unavailable",
        result: { message: error?.message ?? "The takeover did not complete." },
      }, { fenced: false })).record);
    }
    const moved = await transition(current, {
      stage: "preparing-link",
      reason: null,
      result: {
        action: "takeover",
        challenge: null,
        ...(replaced?.pairingPayload ? { payload: replaced.pairingPayload } : {}),
      },
    });
    if (!moved.applied) return snapshot(moved.record);
    void watchLink(moved.record, runtime);
    return snapshot(moved.record);
  }

  /** Confirmed restart of an unresponsive runtime: prove its exact process exits, then resume. */
  async function confirmRestart(current, runtime, proof, owner) {
    if (owner.state === "unknown" || owner.state === "conflict" || (owner.state === "live" && !runtime)) {
      return (await fail(current, "takeover-stale", "The session changed before the restart.")).record;
    }
    if (runtime) {
      if (runtime.run.pid !== proof.pid || runtime.run.processStartedAt !== proof.processStartedAt) {
        return (await fail(current, "takeover-stale", "The session changed before the restart.")).record;
      }
      try { await command(runtime, "quiesce", { opId: current.requestId, reason: "restart" }); } catch { /* it is unresponsive */ }
      const terminated = await processes.terminate?.(runtime);
      if (!terminated?.ok) return (await fail(current, "owner-unknown", terminated?.error ?? "Could not stop the unresponsive session.")).record;
      const exited = await processes.confirmExit?.(runtime);
      if (!exited?.ok) return (await fail(current, "owner-unknown", exited?.error ?? "Could not prove the old session stopped.")).record;
    }
    const saved = await sessions.resolve(current.target.sessionId);
    if (!saved || saved.directoryExists === false) {
      return (await fail(current, "not-found", "That session can no longer be resumed.")).record;
    }
    return dispatch(current, {
      action: "resume",
      project: { name: saved.title ?? "resume", path: saved.cwd },
      resumeSessionId: current.target.sessionId,
    });
  }

  /**
   * Continue a non-terminal request found on disk (Station restart or a duplicate delivery).
   * Returns promptly: waiting for a launched runtime continues in the background.
   */
  async function resumeRequest(record) {
    if (inflight.has(record.requestId)) return inflight.get(record.requestId);
    const running = (async () => {
      if (record.joinedRequestId) {
        const holder = requests.read(record.joinedRequestId);
        if (!holder || isTerminal(holder)) {
          return (await requests.update(record.requestId, {
            outcome: holder?.outcome ?? "outcome-unknown", reason: holder?.reason ?? null, result: holder?.result ?? null,
          })).record;
        }
        return record;
      }
      if (record.stage === "accepted" || record.stage === "resolving") return drive(record);
      if (record.stage === "awaiting-confirmation") return record;
      if (record.stage === "dispatching") {
        const scanned = await scan();
        if (scanned.live.some((item) => item.run.openedBy?.requestId === record.requestId)) {
          const moved = await transition(record, { stage: "awaiting-runtime" }, { fenced: false });
          watchRuntime(record.requestId);
          return moved.record;
        }
        return (await transition(record, {
          outcome: "outcome-unknown", reason: "runtime-unavailable",
          result: { mayBeRunning: true, message: "Station restarted while opening this session; it may be running." },
        }, { fenced: false })).record;
      }
      watchRuntime(record.requestId);
      return record;
    })().finally(() => inflight.delete(record.requestId));
    inflight.set(record.requestId, running);
    return running;
  }

  /** Station start: recover locks, continue unfinished requests, prune old ones. */
  async function reconcile() {
    requests.recoverLocks();
    const results = [];
    for (const record of requests.list({ nonTerminal: true })) {
      results.push(snapshot(await resumeRequest(record) ?? requests.read(record.requestId)));
    }
    try {
      const scanned = await scan();
      const referenced = new Set(scanned.live.map((item) => item.run.openedBy?.requestId).filter(Boolean));
      requests.prune({ at: now(), isReferenced: (id) => referenced.has(id) });
    } catch {
      // Retention is best effort; the next start retries.
    }
    return results;
  }

  return Object.freeze({
    open,
    inspect,
    cancel,
    confirmTakeover,
    reconcile,
    storeAuthority,
    /** For tests and shutdown: wait for background watchers. */
    async idle() {
      await Promise.allSettled([...inflight.values(), ...watchers.values()]);
    },
    stop() {
      stopped = true;
    },
    toMessage: (status) => lifecycleStatus(status),
  });
}

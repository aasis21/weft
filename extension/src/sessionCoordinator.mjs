// SPDX-License-Identifier: Apache-2.0
import { assertSessionCoordinatorPorts, createNoopDiagnostics } from "./sessionCoordinatorPorts.mjs";
import { normalizeOpenIntent, resolveSessionOpen } from "./sessionResolution.mjs";
import { isTerminalLaunchState } from "./launchOperations.mjs";

function publicSnapshot(record) {
  if (!record) return null;
  const {
    ownerToken: _ownerToken,
    identityFile: _identityFile,
    targetKey: _targetKey,
    ...safe
  } = record;
  return safe;
}

function failure(code, message, retryable = false, actions = []) {
  return { code, message, retryable, actions };
}

function intentFromOperation(operation) {
  return {
    operationId: operation.operationId,
    target: operation.target,
    mode: operation.mode,
    name: operation.name,
    requesterId: operation.requesterId,
    takeoverRequested: operation.takeoverRequested === true,
  };
}

export class SessionCoordinator {
  #ports;
  #diagnostics;
  #inflight = new Map();

  constructor(ports) {
    this.#ports = assertSessionCoordinatorPorts(ports);
    this.#diagnostics = ports.diagnostics ?? createNoopDiagnostics();
  }

  open(intent) {
    const normalized = normalizeOpenIntent(intent);
    const current = this.#inflight.get(normalized.operationId);
    if (current) return current;
    const pending = this.#open(normalized).finally(() => this.#inflight.delete(normalized.operationId));
    this.#inflight.set(normalized.operationId, pending);
    return pending;
  }

  async inspect(operationId) {
    return publicSnapshot(await this.#ports.journal.read(operationId));
  }

  async cancel(operationId, revision) {
    const current = await this.#ports.journal.read(operationId);
    if (!current || isTerminalLaunchState(current.state)) return publicSnapshot(current);
    if (!Number.isSafeInteger(revision) || revision !== current.revision) {
      return {
        ...publicSnapshot(current),
        failure: failure(
          "operation-stale",
          "The operation changed before cancellation was confirmed.",
          true,
          ["retry", "cancel"],
        ),
      };
    }
    return publicSnapshot(
      await this.#ports.journal.update(
        operationId,
        { state: "cancelled", failure: failure("cancelled", "The operation was cancelled.") },
        { expectedRevision: current.revision },
      ),
    );
  }

  async confirmTakeover(operationOrChallenge, challengeId, revision) {
    const request = typeof operationOrChallenge === "object"
      ? operationOrChallenge
      : { challengeId: operationOrChallenge };
    const operation = request.operationId
      ? await this.#ports.journal.read(request.operationId)
      : (await this.#ports.journal.listUnresolved()).find(
          (candidate) => candidate.challenge?.challengeId === request.challengeId,
        );
    const expectedChallengeId = challengeId ?? request.challengeId;
    const expectedRevision = revision ?? request.revision;
    if (
      !operation?.challenge ||
      operation.challenge.challengeId !== expectedChallengeId ||
      operation.revision !== expectedRevision
    ) {
      return operation
        ? publicSnapshot(await this.#transition(operation, {
            state: "failed",
            failure: failure("takeover-stale", "The takeover challenge is stale."),
          }))
        : null;
    }
    const located = await this.#ports.runtimeDirectory.locateTarget(operation.target);
    if (
      located?.status !== "single" ||
      !this.#sameRuntime(located.runtime, operation.challenge)
    ) {
      return publicSnapshot(await this.#transition(operation, {
        state: "failed",
        failure: failure("takeover-stale", "Runtime ownership changed before takeover."),
      }));
    }
    const targetRuntime = located.runtime;
    try {
      await this.#ports.runtimeControl.status(targetRuntime, {
        operationId: operation.operationId,
        expectedRevision: operation.revision,
      });
    } catch (statusError) {
      return publicSnapshot(await this.#forceTakeover(operation, targetRuntime, statusError));
    }
    try {
      const result = await this.#ports.runtimeControl.replaceController(targetRuntime, {
        operationId: operation.operationId,
        requesterId: operation.requesterId,
        challengeId: expectedChallengeId,
        expectedRevision: operation.revision,
      });
      return publicSnapshot(await this.#transition(operation, {
        action: "takeover",
        state: result?.state === "open" || result?.state === "active" ? "open" : "pairing-ready",
        pairingPayload: result?.pairingPayload ?? operation.pairingPayload ?? null,
        challenge: null,
        failure: null,
      }));
    } catch (error) {
      return publicSnapshot(await this.#transition(operation, {
        state: "failed",
        failure: failure("takeover-failed", error?.message ?? "Controller replacement failed."),
      }));
    }
  }

  async reconcile() {
    const operations = await this.#ports.journal.listUnresolved();
    const results = [];
    for (const operation of operations) {
      results.push(publicSnapshot(await this.#reconcileOperation(operation)));
    }
    await this.#ports.journal.cleanup({ now: this.#ports.clock.now() });
    return results;
  }

  async #open(intent) {
    let begin;
    try {
      begin = await this.#ports.journal.begin(intent);
    } catch (error) {
      this.#diagnostics.record("session-coordinator.storage-failed", { operationId: intent.operationId });
      throw error;
    }
    if (begin.kind === "conflict") {
      return {
        operationId: intent.operationId,
        state: "failed",
        revision: begin.record.revision,
        action: "undecided",
        target: intent.target,
        failure: failure("operation-conflict", "That requestId was already used with different launch fields."),
      };
    }
    if (begin.kind === "reserved" || isTerminalLaunchState(begin.record.state)) {
      return publicSnapshot(begin.record);
    }
    if (begin.kind === "duplicate" && begin.record.action !== "undecided") {
      return publicSnapshot(begin.record);
    }
    return publicSnapshot(await this.#resolveAndExecute(begin.record, intent));
  }

  async #resolveAndExecute(operation, intent) {
    if (intent.target.kind === "new") {
      const project = await this.#ports.projects.resolve(intent.target.projectName);
      return this.#executeDecision(operation, intent, resolveSessionOpen({ intent, project }));
    }

    const healthyCard = await this.#ports.connections.findHealthyCard(intent);
    if (healthyCard) {
      return this.#executeDecision(operation, intent, resolveSessionOpen({ intent, healthyCard }));
    }
    const reconnect = await this.#ports.connections.reconnect(intent);
    if (reconnect?.status === "confirmed") {
      return this.#executeDecision(operation, intent, resolveSessionOpen({ intent, reconnect }));
    }
    const runtimes = await this.#ports.runtimeDirectory.locateTarget(intent.target);
    const savedSession = await this.#ports.sessions.resolve(intent.target);
    return this.#executeDecision(operation, intent, resolveSessionOpen({ intent, reconnect, runtimes, savedSession }));
  }

  async #executeDecision(operation, intent, decision) {
    if (decision.outcome === "fail-closed") {
      return this.#transition(operation, {
        state: "failed",
        failure: decision.failure,
      });
    }
    if (decision.outcome === "open-existing" || decision.outcome === "reconnect") {
      return this.#transition(operation, {
        action: "reconnect",
        resolution: decision.outcome,
        state: "open",
      });
    }
    if (decision.outcome === "activate-live") {
      const claimed = await this.#claimEffect(operation, "activate", "activating", {
        runtimeId: decision.runtime.runtimeId,
      });
      if (!claimed.applied) return this.#reconcileOperation(claimed.record);
      try {
        const result = await this.#ports.runtimeControl.activate(decision.runtime, {
          operationId: operation.operationId,
          requesterId: intent.requesterId,
        });
        if (
          result?.controllerConflict === true ||
          result?.state === "controller-conflict" ||
          (result?.state === "active" && result?.requesterConfirmed !== true)
        ) {
          const nextRevision = claimed.record.revision + 1;
          return await this.#transition(claimed.record, {
            challenge: {
              challengeId: this.#ports.randomId?.() ?? `${operation.operationId}:${nextRevision}`,
              operationId: operation.operationId,
              revision: nextRevision,
              storeAuthority: decision.runtime.storeAuthority,
              sessionId: decision.runtime.sessionId,
              runtimeInstanceId: decision.runtime.runtimeInstanceId ?? decision.runtime.runtimeId,
              generation: decision.runtime.generation,
              pid: decision.runtime.pid,
              processStartedAt: decision.runtime.processStartedAt,
              responsive: true,
              controllerName: result?.controllerName ?? null,
            },
            failure: failure(
              "controller-conflict",
              "Another phone controls this live session.",
              false,
              ["confirm-takeover", "cancel"],
            ),
          });
        }
        return await this.#transition(claimed.record, {
          runtimeId: decision.runtime.runtimeId,
          state: result?.state === "open" || result?.state === "active" ? "open" : "pairing-ready",
          pairingPayload: result?.pairingPayload ?? null,
        });
      } catch (error) {
        return this.#transition(claimed.record, {
          state: "failed",
          failure: failure("activation-failed", error?.message ?? String(error), true),
        });
      }
    }
    if (decision.outcome === "legacy-takeover") {
      if (!decision.session) {
        return this.#transition(operation, {
          state: "failed",
          failure: failure("session-not-found", "That session is no longer in the CLI session store."),
        });
      }
      if (decision.session.directoryExists !== true) {
        return this.#transition(operation, {
          state: "failed",
          failure: failure("directory-not-found", "The session working directory is unavailable."),
        });
      }
      const claimed = await this.#claimEffect(operation, "takeover", "activating", {
        legacyWriter: {
          sessionId: decision.writer?.sessionId ?? intent.target.sessionId,
          pid: decision.writer?.pid ?? null,
          channelId: decision.writer?.channelId ?? null,
        },
      });
      if (!claimed.applied) return this.#reconcileOperation(claimed.record);
      const terminated = await this.#ports.processes.terminateLegacy?.(decision.writer);
      if (!terminated?.ok) {
        return this.#transition(claimed.record, {
          state: "failed",
          failure: failure(
            "takeover-failed",
            terminated?.error ?? "Could not prove the prior Copilot process stopped; resume was cancelled for safety.",
          ),
        });
      }
      return this.#launch(
        claimed.record,
        intent,
        { outcome: "resume", session: decision.session },
        { effectAlreadyClaimed: true },
      );
    }
    if (decision.outcome === "start" || decision.outcome === "resume") {
      return this.#launch(operation, intent, decision);
    }
    throw new Error(`Unsupported session resolution outcome '${decision.outcome}'`);
  }

  async #launch(operation, intent, decision, { effectAlreadyClaimed = false } = {}) {
    const action = decision.outcome;
    const claimed = effectAlreadyClaimed
      ? {
          applied: true,
          record: await this.#transition(operation, {
            action,
            state: "launching",
            effectCommittedAt: this.#ports.clock.now(),
          }),
        }
      : await this.#claimEffect(operation, action, "launching");
    if (!claimed.applied) return this.#reconcileOperation(claimed.record);
    let identity;
    let current = claimed.record;
    let launchIssued = false;
    try {
      identity = await this.#ports.identities.create({
        operationId: operation.operationId,
        target: intent.target,
      });
      current = await this.#transition(current, {
        identityRef: identity.identityRef,
        pairingPayload: identity.pairingPayload ?? null,
      });
      if (current.revision !== claimed.record.revision + 1 || current.identityRef !== identity.identityRef) {
        return this.#reconcileOperation(current);
      }
      launchIssued = true;
      const result =
        action === "start"
          ? await this.#ports.launcher.start({
              operationId: operation.operationId,
              project: decision.project,
              identity,
              mode: intent.mode,
              name: intent.name,
            })
          : await this.#ports.launcher.resume({
              operationId: operation.operationId,
              session: decision.session,
              identity,
              mode: intent.mode,
            });
      if (result?.ok === false) {
        return await this.#transition(current, {
          state: "failed",
          failure: failure("launch-failed", result.error ?? "The session could not be launched.", true),
        });
      }
      return await this.#transition(current, {
        pid: result?.pid ?? null,
        runtimeId: result?.runtimeId ?? null,
        identityFile: result?.identityFile ?? current.identityFile ?? null,
        state: result?.state === "pairing-ready" ? "pairing-ready" : "launching",
        pairingPayload: result?.pairingPayload ?? null,
      });
    } catch (error) {
      if (launchIssued) {
        return this.#transition(current, {
          failure: failure(
            "launch-outcome-unknown",
            "The launch outcome is uncertain and must be reconciled before any retry.",
            true,
          ),
        });
      }
      return this.#transition(current, {
        identityRef: identity?.identityRef ?? current.identityRef ?? null,
        state: "failed",
        failure: failure("identity-failed", error?.message ?? String(error), true),
      });
    }
  }

  async #claimEffect(operation, action, state, updates = {}) {
    const record = await this.#ports.journal.update(
      operation.operationId,
      { ...updates, action, state, effectCommittedAt: this.#ports.clock.now() },
      { expectedRevision: operation.revision },
    );
    return {
      applied:
        record?.revision === operation.revision + 1 &&
        record.action === action &&
        record.state === state,
      record,
    };
  }

  async #transition(operation, updates) {
    const next = await this.#ports.journal.update(
      operation.operationId,
      updates,
      { expectedRevision: operation.revision },
    );
    if (!next) throw new Error(`Lifecycle operation '${operation.operationId}' no longer exists`);
    return next;
  }

  async #reconcileOperation(operation) {
    if (!operation || isTerminalLaunchState(operation.state)) return operation;
    if (operation.action === "undecided" && operation.target) {
      return this.#resolveAndExecute(operation, intentFromOperation(operation));
    }
    const located = await this.#ports.runtimeDirectory.locateOperation(operation);
    if (located?.status === "multiple") {
      return this.#transition(operation, {
        state: "failed",
        failure: failure("writer-conflict", "Multiple runtimes claim this operation."),
      });
    }
    if (located?.status === "single") {
      const status = await this.#ports.runtimeControl.status(located.runtime, {
        operationId: operation.operationId,
      });
      return this.#transition(operation, {
        runtimeId: located.runtime.runtimeId,
        state:
          status?.state === "open" || status?.state === "active"
            ? "open"
            : status?.state === "pairing"
              ? "pairing"
              : "pairing-ready",
        pairingPayload: status?.pairingPayload ?? operation.pairingPayload ?? null,
      });
    }
    if (operation.action === "start" || operation.action === "resume" || operation.action === "takeover") {
      const process = await this.#ports.processes.inspect(operation.pid);
      if (process?.state === "alive" || process?.state === "unknown") return operation;
      return this.#transition(operation, {
        state: "failed",
        failure: failure(
          "launch-not-recoverable",
          "The prior launch cannot be recovered and will not be repeated automatically.",
          true,
        ),
      });
    }
    if (operation.action === "activate") {
      return this.#transition(operation, {
        state: "failed",
        failure: failure("runtime-unavailable", "The selected runtime is no longer available.", true),
      });
    }
    return operation;
  }

  #sameRuntime(runtime, challenge) {
    return runtime &&
      challenge &&
      runtime.storeAuthority === challenge.storeAuthority &&
      runtime.sessionId === challenge.sessionId &&
      (runtime.runtimeInstanceId ?? runtime.runtimeId) === challenge.runtimeInstanceId &&
      runtime.generation === challenge.generation &&
      runtime.pid === challenge.pid &&
      runtime.processStartedAt === challenge.processStartedAt;
  }

  async #forceTakeover(operation, targetRuntime, statusError) {
    const revalidated = await this.#ports.runtimeDirectory.locateTarget(operation.target);
    if (revalidated?.status !== "single" || !this.#sameRuntime(revalidated.runtime, operation.challenge)) {
      return this.#transition(operation, {
        state: "failed",
        failure: failure("takeover-stale", "Runtime ownership changed before forced takeover."),
      });
    }
    if (typeof this.#ports.processes.revalidate === "function") {
      const exact = await this.#ports.processes.revalidate(targetRuntime);
      if (!exact) {
        return this.#transition(operation, {
          state: "failed",
          failure: failure("takeover-stale", "The runtime process identity is no longer exact."),
        });
      }
    }
    try {
      await this.#ports.runtimeControl.quiesce(targetRuntime, {
        operationId: operation.operationId,
        challengeId: operation.challenge.challengeId,
      });
    } catch (error) {
      if (error?.code && !["ECONNREFUSED", "ENOENT", "ETIMEDOUT", "runtime-command-failed"].includes(error.code)) {
        return this.#transition(operation, {
          state: "failed",
          failure: failure("takeover-failed", error?.message ?? "The runtime refused to quiesce."),
        });
      }
    }
    const finalPresence = await this.#ports.runtimeDirectory.locateTarget(operation.target);
    if (finalPresence?.status !== "single" || !this.#sameRuntime(finalPresence.runtime, operation.challenge)) {
      return this.#transition(operation, {
        state: "failed",
        failure: failure("takeover-stale", "Runtime ownership changed before termination."),
      });
    }
    const terminated = await this.#ports.processes.terminate?.(targetRuntime);
    if (!terminated?.ok) {
      return this.#transition(operation, {
        state: "failed",
        failure: failure("takeover-failed", terminated?.error ?? statusError?.message ?? "Termination failed."),
      });
    }
    const exited = await this.#ports.processes.confirmExit?.(targetRuntime);
    if (!exited?.ok) {
      return this.#transition(operation, {
        state: "failed",
        failure: failure("takeover-failed", exited?.error ?? "Process exit could not be confirmed."),
      });
    }
    const session = await this.#ports.sessions.resolve(operation.target);
    if (!session?.directoryExists) {
      return this.#transition(operation, {
        state: "failed",
        failure: failure("directory-not-found", "The session working directory is unavailable."),
      });
    }
    let current = await this.#transition(operation, {
      action: "takeover",
      state: "launching",
      challenge: null,
      failure: null,
    });
    let identity;
    let launchIssued = false;
    try {
      identity = await this.#ports.identities.create({
        operationId: operation.operationId,
        target: operation.target,
      });
      current = await this.#transition(current, {
        identityRef: identity.identityRef,
        pairingPayload: identity.pairingPayload ?? null,
      });
      launchIssued = true;
      const result = await this.#ports.launcher.resume({
        operationId: operation.operationId,
        session,
        identity,
        mode: operation.mode,
      });
      if (result?.ok === false) {
        return this.#transition(current, {
          state: "failed",
          failure: failure("launch-failed", result.error ?? "The session could not be resumed."),
        });
      }
      return this.#transition(current, {
        pid: result?.pid ?? null,
        runtimeId: result?.runtimeId ?? null,
        identityFile: result?.identityFile ?? current.identityFile ?? null,
        pairingPayload: result?.pairingPayload ?? identity.pairingPayload ?? null,
      });
    } catch (error) {
      return this.#transition(current, {
        failure: failure(
          launchIssued
            ? "launch-outcome-unknown"
            : "identity-failed",
          launchIssued
            ? "The takeover Resume outcome is uncertain and must be reconciled before any retry."
            : error?.message ?? String(error),
          true,
        ),
      });
    }
  }
}

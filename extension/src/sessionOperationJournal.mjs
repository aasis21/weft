// SPDX-License-Identifier: Apache-2.0
import {
  LIFECYCLE_RETENTION_MS,
  beginLaunchOperation,
  isTerminalLaunchState,
  listLaunchOperations,
  pruneLaunchOperations,
  readLaunchOperation,
  updateLaunchOperation,
} from "./launchOperations.mjs";
import { normalizeOpenIntent, targetReservationKey } from "./sessionResolution.mjs";

function toRequest(intent) {
  const normalized = normalizeOpenIntent(intent);
  const existing = normalized.target.kind === "existing";
  return {
    requestId: normalized.operationId,
    operation: existing ? "resume" : "new",
    projectName: existing ? null : normalized.target.projectName,
    storeAuthority: existing ? normalized.target.storeAuthority : null,
    sessionId: existing ? normalized.target.sessionId : null,
    targetKey: targetReservationKey(normalized.target, normalized.operationId),
    mode: normalized.mode,
    name: normalized.name,
    requesterId: normalized.requesterId,
    takeoverRequested: normalized.takeoverRequested === true,
  };
}

function snapshot(record) {
  if (!record) return null;
  return {
    ...record,
    operationId: record.requestId,
    revision: record.revision ?? 0,
    action: record.action ?? "undecided",
  };
}

export function createLaunchOperationJournal({
  baseDir,
  liveReferences = {},
  clock = { now: () => Date.now() },
} = {}) {
  return Object.freeze({
    async begin(intent) {
      const result = await beginLaunchOperation(toRequest(intent), { baseDir, now: clock.now() });
      return { ...result, record: snapshot(result.record) };
    },
    async read(operationId) {
      return snapshot(readLaunchOperation(operationId, { baseDir }));
    },
    async update(operationId, updates, { expectedRevision } = {}) {
      const current = await updateLaunchOperation(operationId, updates, {
        baseDir,
        expectedRevision,
        now: clock.now(),
      });
      return snapshot(current);
    },
    async listUnresolved() {
      return listLaunchOperations({ baseDir }).filter((record) => !isTerminalLaunchState(record.state)).map(snapshot);
    },
    async cleanup({ now = clock.now() } = {}) {
      await pruneLaunchOperations({
        baseDir,
        now,
        resolvedTtlMs: LIFECYCLE_RETENTION_MS,
        unresolvedNewTtlMs: LIFECYCLE_RETENTION_MS,
        isLiveRuntimeReference: liveReferences.isRuntimeLive ?? (() => false),
        isIdentityReferenced: liveReferences.isIdentityReferenced ?? (() => false),
      });
    },
  });
}

// SPDX-License-Identifier: Apache-2.0
import {
  lifecycleStatus,
  lifecycleStatusToLegacy,
  openSessionFromLegacy,
} from "@aasis21/weft-shared";

const LEGACY_STATES = Object.freeze({
  launched: "launching",
  ready: "pairing-ready",
  claimed: "open",
  abandoned: "cancelled",
  superseded: "cancelled",
});

export function coordinatorIntentFromLegacy(message, requesterId = null) {
  const projected = openSessionFromLegacy(message);
  if (!projected) return null;
  return {
    ...projected.msg,
    requesterId,
  };
}

export function lifecycleSnapshotFromLaunchRecord(record) {
  if (!record?.requestId) return null;
  const state = LEGACY_STATES[record.state] ?? record.state;
  return {
    ...record,
    operationId: record.requestId,
    state,
    action: record.action ?? (
      record.operation === "resume" ? "resume"
        : record.operation === "new" ? "start"
          : "undecided"
    ),
    target: record.target ?? (
      record.operation === "resume"
        ? {
            kind: "existing",
            storeAuthority: record.storeAuthority ?? "default",
            sessionId: record.sessionId,
          }
        : { kind: "new", projectName: record.projectName }
    ),
    payload: record.pairingPayload ?? null,
    failure: record.failure ?? (
      record.error
        ? { code: state === "cancelled" ? "cancelled" : "launch-failed", message: record.error, actions: [] }
        : null
    ),
  };
}

export function lifecycleEnvelopeFromSnapshot(snapshot) {
  if (!snapshot) return null;
  return lifecycleStatus({
    ...snapshot,
    operationId: snapshot.operationId ?? snapshot.requestId,
    payload: snapshot.pairingPayload ?? snapshot.payload ?? null,
  });
}

export function legacyEnvelopesFromSnapshot(snapshot) {
  const envelope = lifecycleEnvelopeFromSnapshot(snapshot);
  if (!envelope) return [];
  return lifecycleStatusToLegacy(envelope).map((message) => {
    if (message.eventSubtype !== "launch_status") return message;
    return {
      ...message,
      msg: {
        ...message.msg,
        ...(!message.msg.sessionId && snapshot.sessionId ? { sessionId: snapshot.sessionId } : {}),
        ...(!message.msg.projectName && snapshot.projectName ? { projectName: snapshot.projectName } : {}),
      },
    };
  });
}

export function readPositiveLegacyEvidence(
  target,
  { attachedApi, pendingApi, baseDir, now = Date.now() } = {},
) {
  if (target?.kind !== "existing") return null;
  const ownership = attachedApi?.inspectAttachedSessionOwnership?.(target.sessionId, { baseDir, now });
  if (ownership?.state === "writer") return { kind: "writer", writer: ownership.writer };
  if (ownership?.state === "stopped") return { kind: "stopped", writer: ownership.writer };
  const writer = attachedApi?.findAttachedSession?.(target.sessionId, { baseDir, now });
  if (writer) return { kind: "writer", writer };
  if (target.storeAuthority !== "legacy-offer") return null;
  const offer = pendingApi?.listPendingSessions?.({ baseDir })
    ?.find((candidate) => candidate.channelId === target.sessionId);
  return offer ? { kind: "offer", offer } : null;
}

export async function applyLegacyClaim(
  { requestId, channelId },
  { launchApi, pendingApi, baseDir } = {},
) {
  let operation = null;
  if (typeof requestId === "string" && requestId) {
    operation = await launchApi?.markLaunchClaimed?.(requestId, { baseDir });
  }
  if (typeof channelId === "string" && channelId) {
    pendingApi?.removePendingSession?.(channelId, { baseDir });
  }
  return operation;
}

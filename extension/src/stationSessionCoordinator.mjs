// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  buildPairingPayload,
  exportKeyPair,
  generateKeyPair,
  randomChannelId,
} from "@aasis21/weft-shared";
import { SessionCoordinator } from "./sessionCoordinator.mjs";
import { createLaunchOperationJournal } from "./sessionOperationJournal.mjs";
import { createRuntimeLifecycleClient, discoverRuntimeLifecycles } from "./runtimeLifecycle.mjs";
import { deriveStoreAuthority } from "./runtimeIdentity.mjs";
import { verifyProcessIdentity } from "./processIdentity.mjs";
import { isPidAlive } from "./registryFile.mjs";
import { resolveVersion } from "./version.mjs";
import { spawnCopilotSession } from "./spawn.mjs";
import { readPositiveLegacyEvidence } from "./sessionCompatibility.mjs";

export function defaultSessionStorePath() {
  return join(homedir(), ".copilot", "session-store.db");
}

function directoryExists(path) {
  try {
    return typeof path === "string" && path.length > 0 && existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function runtime(presence) {
  return presence ? { ...presence, runtimeId: presence.runtimeInstanceId } : null;
}

function exactRuntime(actual, expected) {
  return actual &&
    expected &&
    actual.storeAuthority === expected.storeAuthority &&
    actual.sessionId === expected.sessionId &&
    actual.runtimeInstanceId === expected.runtimeInstanceId &&
    actual.generation === expected.generation &&
    actual.pid === expected.pid &&
    actual.processStartedAt === expected.processStartedAt;
}

function lifecycleError(response, command) {
  const error = new Error(response?.error?.message ?? `Runtime ${command} failed.`);
  error.code = response?.error?.code ?? "runtime-command-failed";
  return error;
}

async function commandRuntime(presence, command, payload, { baseDir, timeoutMs } = {}) {
  const response = await createRuntimeLifecycleClient(presence, { baseDir }).command(command, payload, {
    timeoutMs,
  });
  if (response?.ok !== true) throw lifecycleError(response, command);
  return response.result ?? null;
}

async function discoverTarget(target, { baseDir, attachedApi, pendingApi, timeoutMs } = {}) {
  const discovery = await discoverRuntimeLifecycles({
    baseDir,
    storeAuthority: target.storeAuthority,
    sessionId: target.sessionId,
    timeoutMs,
  });
  if (discovery.status === "conflict" || discovery.status === "multiple") {
    return { status: "multiple", runtimes: discovery.runtimes.map(runtime) };
  }
  if (discovery.status === "single") {
    return { status: "single", runtime: runtime(discovery.runtimes[0]) };
  }
  if (discovery.status === "uncertain") return { status: "uncertain" };
  const legacy = readPositiveLegacyEvidence(target, { attachedApi, pendingApi, baseDir });
  if (legacy?.kind === "writer") return { status: "legacy-writer", writer: legacy.writer };
  if (legacy?.kind === "stopped") return { status: "none", stoppedEvidence: legacy.writer };
  if (legacy?.kind === "offer") {
    return {
      status: "single",
      runtime: {
        legacyOffer: true,
        runtimeId: `legacy-offer:${legacy.offer.channelId}`,
        runtimeInstanceId: `legacy-offer:${legacy.offer.channelId}`,
        storeAuthority: "legacy-offer",
        sessionId: legacy.offer.channelId,
        generation: 0,
        pid: null,
        processStartedAt: null,
        pairingPayload: legacy.offer.payload,
      },
    };
  }
  return { status: "uncertain" };
}

async function locateOperationRuntime(operation, { baseDir, timeoutMs } = {}) {
  const discovery = await discoverRuntimeLifecycles({ baseDir, timeoutMs });
  if (discovery.status === "conflict") return { status: "multiple" };
  const matches = [];
  for (const presence of discovery.runtimes) {
    if (operation.runtimeId && presence.runtimeInstanceId === operation.runtimeId) {
      matches.push(runtime(presence));
      continue;
    }
    if (Number.isInteger(operation.pid) && operation.pid === presence.pid) {
      matches.push(runtime(presence));
      continue;
    }
    if (
      operation.target?.kind === "existing" &&
      operation.target.storeAuthority === presence.storeAuthority &&
      operation.target.sessionId === presence.sessionId
    ) {
      matches.push(runtime(presence));
      continue;
    }
    try {
      const status = await commandRuntime(presence, "status", { operationId: operation.operationId }, {
        baseDir,
        timeoutMs,
      });
      if (
        status?.operationId === operation.operationId ||
        (
          operation.pairingPayload?.channelId &&
          status?.pairingPayload?.channelId === operation.pairingPayload.channelId
        )
      ) {
        matches.push(runtime(presence));
      }
    } catch {
      // Discovery already proved the runtime. A failed status query cannot identify this operation.
    }
  }
  if (matches.length > 1) return { status: "multiple", runtimes: matches };
  return matches.length === 1 ? { status: "single", runtime: matches[0] } : { status: "none" };
}

async function waitForExit(presence, { timeoutMs = 5_000, pollMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const proof = await verifyProcessIdentity(presence);
    if (proof?.live === false) return { ok: true };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return { ok: false, error: "The prior Copilot process did not exit; Resume was cancelled." };
}

export function createStationSessionCoordinator({
  baseDir,
  storePath = defaultSessionStorePath(),
  storeAuthority = deriveStoreAuthority(storePath),
  sessionsApi,
  projectsApi,
  attachedApi,
  pendingApi,
  launchApi,
  spawnFn,
  getTransportDescriptor,
  timeoutMs = 5_000,
  clock = { now: () => Date.now() },
  diagnostics,
} = {}) {
  const runtimeDirectory = {
    locateTarget: (target) => discoverTarget(
      {
        ...target,
        storeAuthority: target.storeAuthority === "default" ? storeAuthority : target.storeAuthority,
      },
      { baseDir, attachedApi, pendingApi, timeoutMs },
    ),
    locateOperation: (operation) => locateOperationRuntime(operation, { baseDir, timeoutMs }),
  };
  const journal = createLaunchOperationJournal({
    baseDir,
    clock,
    liveReferences: {
      isRuntimeLive: async (record) =>
        (await runtimeDirectory.locateOperation(record))?.status === "single",
      isIdentityReferenced: async (record) =>
        (await runtimeDirectory.locateOperation(record))?.status === "single",
    },
  });
  const runtimeControl = {
    activate: (targetRuntime, payload) =>
      targetRuntime.legacyOffer
        ? Promise.resolve({ state: "pairing-ready", pairingPayload: targetRuntime.pairingPayload })
        : commandRuntime(targetRuntime, "activate", payload, { baseDir, timeoutMs }),
    status: (targetRuntime, payload) =>
      commandRuntime(targetRuntime, "status", payload, { baseDir, timeoutMs }),
    replaceController: (targetRuntime, payload) =>
      commandRuntime(targetRuntime, "replace-controller", payload, { baseDir, timeoutMs }),
    quiesce: (targetRuntime, payload) =>
      commandRuntime(targetRuntime, "quiesce", payload, { baseDir, timeoutMs }),
  };
  const identities = {
    async create({ operationId }) {
      const operation = launchApi.readLaunchOperation(operationId, { baseDir });
      if (!operation?.ownerToken) throw new Error(`Lifecycle operation '${operationId}' has no launch owner.`);
      const channelId = randomChannelId();
      const keyPair = await generateKeyPair();
      const { publicKeyB64, privateKeyJwk } = await exportKeyPair(keyPair);
      const pairingPayload = buildPairingPayload({
        channelId,
        publicKeyB64,
        transport: await Promise.resolve(getTransportDescriptor()),
        appVersion: resolveVersion(),
      });
      return {
        identityRef: launchApi.launchIdentityPath(operationId, { baseDir }),
        ownerToken: operation.ownerToken,
        pairingPayload,
        channelId,
        publicKeyB64,
        privateKeyJwk,
        pairingToken: pairingPayload.token,
        pairingExpiresAt: pairingPayload.expiresAt,
      };
    },
  };
  const launcher = {
    async start({ operationId, project, identity, mode, name }) {
      const result = await spawnCopilotSession({
        project,
        name,
        mode,
        identity,
        operationId,
        operationOwnerToken: identity.ownerToken,
        baseDir,
        spawnFn,
      });
      return { ...result, pairingPayload: identity.pairingPayload };
    },
    async resume({ operationId, session, identity, mode }) {
      const result = await spawnCopilotSession({
        project: { name: "resume", path: session.cwd },
        mode,
        identity,
        resumeSessionId: session.sessionId,
        operationId,
        operationOwnerToken: identity.ownerToken,
        baseDir,
        spawnFn,
      });
      return { ...result, pairingPayload: identity.pairingPayload };
    },
  };
  const ports = {
    journal,
    connections: {
      findHealthyCard: async () => null,
      reconnect: async () => ({ status: "not-found" }),
    },
    runtimeDirectory,
    runtimeControl,
    sessions: {
      async resolve(target) {
        const session = await Promise.resolve(
          sessionsApi.readSession?.(target.sessionId) ??
          sessionsApi.readSessionCwd(target.sessionId),
        );
        if (!session) return null;
        const resolved = typeof session === "string"
          ? { sessionId: target.sessionId, cwd: session }
          : session;
        return {
          ...resolved,
          sessionId: target.sessionId,
          directoryExists: directoryExists(resolved.cwd),
          writerState: "stopped",
        };
      },
    },
    projects: {
      async resolve(projectName) {
        const projects = await Promise.resolve(projectsApi.listProjects());
        const project = projects.find((candidate) => candidate.name === projectName);
        return project ? { ...project, directoryExists: directoryExists(project.path) } : null;
      },
    },
    identities,
    launcher,
    processes: {
      inspect: async (pid) => ({
        state: Number.isInteger(pid) && pid > 0 ? (isPidAlive(pid) ? "alive" : "stopped") : "unknown",
      }),
      revalidate: async (targetRuntime) => {
        const proof = await verifyProcessIdentity(targetRuntime);
        return proof?.live === true;
      },
      terminate: async (targetRuntime) => {
        const proof = await verifyProcessIdentity(targetRuntime);
        if (proof?.live !== true) return { ok: false, error: "Runtime ownership changed before termination." };
        try {
          process.kill(targetRuntime.pid, "SIGTERM");
          return { ok: true };
        } catch (error) {
          return { ok: false, error: error?.message ?? String(error) };
        }
      },
      confirmExit: waitForExit,
      terminateLegacy: (writer) => attachedApi.terminateAttachedSession(writer.sessionId, {
        baseDir,
        expectedPid: writer.pid,
        expectedChannelId: writer.channelId,
        requireHealthy: false,
      }),
    },
    clock,
    diagnostics,
  };
  const coordinator = new SessionCoordinator(ports);
  return Object.freeze({
    ...coordinator,
    open: coordinator.open.bind(coordinator),
    inspect: coordinator.inspect.bind(coordinator),
    cancel: coordinator.cancel.bind(coordinator),
    confirmTakeover: coordinator.confirmTakeover.bind(coordinator),
    reconcile: coordinator.reconcile.bind(coordinator),
    storeAuthority,
    async locateTarget(target) {
      return runtimeDirectory.locateTarget({
        ...target,
        storeAuthority: target.storeAuthority === "default" ? storeAuthority : target.storeAuthority,
      });
    },
  });
}

export async function mergeSavedSessionsWithRuntimePresence(
  sessions,
  {
    baseDir,
    sessionsApi,
    storeAuthority = deriveStoreAuthority(defaultSessionStorePath()),
    timeoutMs = 5_000,
  } = {},
) {
  const merged = new Map((sessions ?? []).map((session) => [session.sessionId, session]));
  const discovery = await discoverRuntimeLifecycles({ baseDir, storeAuthority, timeoutMs });
  for (const presence of discovery.runtimes) {
    if (merged.has(presence.sessionId)) continue;
    const saved = await Promise.resolve(
      sessionsApi.readSession?.(presence.sessionId) ??
      sessionsApi.readSessionCwd?.(presence.sessionId),
    );
    if (!saved) continue;
    const session = typeof saved === "string"
      ? { sessionId: presence.sessionId, cwd: saved, title: null, repository: null, branch: null, updatedAt: 0 }
      : saved;
    if (directoryExists(session.cwd)) merged.set(presence.sessionId, session);
  }
  const liveIds = new Set(discovery.runtimes.map((presence) => presence.sessionId));
  return [...merged.values()].sort((left, right) => {
    const liveDifference = Number(liveIds.has(right.sessionId)) - Number(liveIds.has(left.sessionId));
    return liveDifference || (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
  });
}

export { exactRuntime };

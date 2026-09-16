// SPDX-License-Identifier: Apache-2.0
import { createRuntimeIdentity } from "./runtimeIdentity.mjs";
import {
  publishRuntimePresence,
  readRuntimeCapability,
  scanRuntimePresence,
} from "./runtimePresence.mjs";
import {
  createLifecycleEndpoint,
  lifecycleAuth,
  runtimeEndpointAddress,
  sendLifecycleCommand,
} from "./lifecycleEndpoint.mjs";

export async function startRuntimeLifecycleHost(
  {
    identity: suppliedIdentity,
    storePath,
    storeAuthority,
    sessionId,
    handlers,
    state = "dormant",
    capabilities,
    processStartedAt,
    pid,
  },
  { baseDir, identityOptions, presenceOptions, endpointOptions, discoveryOptions } = {},
) {
  const identity = suppliedIdentity ?? createRuntimeIdentity(
    { storePath, storeAuthority, sessionId },
    identityOptions,
  );
  await scanRuntimePresence({
    baseDir,
    cleanup: true,
    probe: null,
    ...discoveryOptions,
  });
  const endpoint = runtimeEndpointAddress(identity.runtimeInstanceId, { baseDir });
  const published = await publishRuntimePresence({
    identity,
    endpoint,
    state,
    capabilities,
    processStartedAt,
    pid,
  }, { baseDir, ...presenceOptions });
  let endpointHost;
  try {
    endpointHost = await createLifecycleEndpoint({
      identity,
      capability: published.capability,
      endpoint,
      presence: () => published.presence,
      handlers,
    }, endpointOptions);
  } catch (error) {
    published.close();
    throw error;
  }
  let closed = false;
  const withdrawPresence = () => published.close();
  return {
    identity,
    endpoint,
    capability: published.capability,
    get presence() {
      return published.presence;
    },
    updatePresence(patch) {
      return published.update(patch);
    },
    withdrawPresence,
    async close() {
      if (closed) return;
      closed = true;
      withdrawPresence();
      await endpointHost.close();
    },
  };
}

export function createRuntimeLifecycleClient(presence, { baseDir, capability } = {}) {
  const token = capability ?? readRuntimeCapability(presence.runtimeInstanceId, { baseDir });
  const auth = lifecycleAuth(presence, token);
  return Object.freeze({
    presence,
    command(command, payload, options) {
      return sendLifecycleCommand({
        endpoint: presence.endpoint,
        auth,
        command,
        payload,
        id: options?.id,
      }, options);
    },
  });
}

export async function discoverRuntimeLifecycles(options = {}) {
  return scanRuntimePresence({
    ...options,
    probe: options.probe ?? (async (presence) => {
      const response = await createRuntimeLifecycleClient(presence, options).command("probe", null, {
        timeoutMs: options.timeoutMs,
      });
      const proven = response?.ok === true ? response.result?.presence : null;
      return proven?.storeAuthority === presence.storeAuthority &&
        proven?.sessionId === presence.sessionId &&
        proven?.runtimeInstanceId === presence.runtimeInstanceId &&
        proven?.generation === presence.generation;
    }),
  });
}

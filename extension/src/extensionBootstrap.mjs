// SPDX-License-Identifier: Apache-2.0
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { startRuntimeLifecycleHost } from "./runtimeLifecycle.mjs";

const BOOTSTRAP_STATE = Symbol.for("weft.extension-bootstrap.v1");
const ACTIVE_RUNTIME_PATH = "./activeRuntime.mjs";

function defaultStorePath() {
  return join(homedir(), ".copilot", "session-store.db");
}

function shutdownReason(event) {
  return event?.data?.shutdownType ?? event?.data?.errorReason ?? "session_end";
}

function isClear(reason) {
  return String(reason).toLowerCase().includes("clear");
}

async function defaultLoadActiveRuntime(options) {
  const module = await import(ACTIVE_RUNTIME_PATH);
  return module.createActiveRuntime(options);
}

export async function startExtensionBootstrap({
  joinSession,
  loadActiveRuntime = defaultLoadActiveRuntime,
  startLifecycleHost = startRuntimeLifecycleHost,
  storePath = defaultStorePath(),
  env = process.env,
  scope = globalThis,
  processTarget = process,
  identityFileExists = existsSync,
  lifecycleOptions,
} = {}) {
  if (typeof joinSession !== "function") throw new Error("joinSession is required");

  const identityFileEnv = env.WEFT_IDENTITY_FILE || "";
  const channelIdEnv = env.WEFT_CHANNEL_ID || "";
  // Copilot may preserve the original child environment across `/clear`. The identity file is the
  // durable handoff authority, so a now-missing file means the clear intentionally revoked it.
  const explicitHandoff = identityFileEnv ? identityFileExists(identityFileEnv) : Boolean(channelIdEnv);
  delete env.WEFT_IDENTITY_FILE;
  delete env.WEFT_CHANNEL_ID;

  let activeRuntime = null;
  let activationPromise = null;
  let lifecycleHost = null;
  let closing = false;
  let reloadIdentity = null;

  const activate = async ({ reason, context = null, showQr = false } = {}) => {
    if (!activationPromise) {
      lifecycleHost?.updatePresence({ state: "activating" });
      activationPromise = (async () => {
        try {
          activeRuntime = await loadActiveRuntime({
            session,
            identityFileEnv,
            channelIdEnv,
            reloadIdentity,
          });
          const result = await activeRuntime.activate({ reason, context, showQr });
          lifecycleHost?.updatePresence({ state: "active" });
          return result;
        } catch (error) {
          activationPromise = null;
          lifecycleHost?.updatePresence({ state: "degraded" });
          throw error;
        }
      })();
    } else if (showQr) {
      await activationPromise;
      await activeRuntime.showPairing(context);
    }
    return activationPromise;
  };

  const session = await joinSession({
    streaming: true,
    onPermissionRequest: async (request, invocation) => {
      if (!activeRuntime) return { kind: "user-not-available" };
      return activeRuntime.onPermissionRequest(request, invocation);
    },
    commands: [
      {
        name: "weft",
        description:
          "Pair your phone with this Copilot session. Optional transport: /weft [supabase|devtunnel].",
        handler: async (context) => {
          try {
            return await activate({ reason: "command", context, showQr: true });
          } catch (error) {
            session.log?.(`Weft: ${error?.message ?? error}`, {
              level: "warning",
              ephemeral: false,
            });
            return null;
          }
        },
      },
    ],
  });

  const previous = scope[BOOTSTRAP_STATE];
  const sameSessionReload = previous?.sessionId === session.sessionId && previous?.activeRuntime;
  if (sameSessionReload) {
    reloadIdentity = previous.activeRuntime.getReloadIdentity();
    await previous.close("extension_reload", { preserveIdentity: true });
  } else if (previous) {
    await previous.close("replaced");
  }

  lifecycleHost = await startLifecycleHost({
    storePath,
    sessionId: session.sessionId,
    handlers: {
      activate: (payload) => activate({ reason: "station", context: payload }),
      status: async () => activeRuntime?.status() ?? {
        state: "dormant",
        sessionId: session.sessionId,
        pid: process.pid,
      },
      "replace-controller": async (payload) => {
        await activate({ reason: "station", context: payload });
        return activeRuntime.replaceController(payload);
      },
      quiesce: async (payload) => {
        if (!activeRuntime) return { state: "dormant" };
        await activeRuntime.quiesce(payload?.reason ?? "quiesce");
        lifecycleHost.updatePresence({ state: "degraded" });
        return activeRuntime.status();
      },
    },
  }, lifecycleOptions);

  const onProcessExit = () => {
    lifecycleHost?.withdrawPresence?.();
  };
  processTarget.once?.("exit", onProcessExit);

  const close = async (reason = "session_end", { preserveIdentity = false } = {}) => {
    if (closing) return;
    closing = true;
    lifecycleHost?.withdrawPresence?.();
    processTarget.off?.("exit", onProcessExit);
    try {
      if (activeRuntime) {
        if (isClear(reason)) activeRuntime.discardHandoffIdentity();
        await activeRuntime.shutdown(reason, { preserveIdentity });
      }
    } finally {
      try {
        await lifecycleHost?.close();
      } finally {
        if (scope[BOOTSTRAP_STATE]?.close === close) delete scope[BOOTSTRAP_STATE];
      }
    }
  };

  const state = {
    sessionId: session.sessionId,
    get activeRuntime() {
      return activeRuntime;
    },
    get lifecycleHost() {
      return lifecycleHost;
    },
    activate,
    close,
  };
  scope[BOOTSTRAP_STATE] = state;

  session.on?.("session.shutdown", (event) => {
    void close(shutdownReason(event));
  });

  if (sameSessionReload) {
    await activate({ reason: "reload" });
  } else if (explicitHandoff) {
    await activate({ reason: "handoff" });
  }

  return state;
}

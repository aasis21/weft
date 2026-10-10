// SPDX-License-Identifier: Apache-2.0
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { startRuntimeLifecycleHost } from "./runtimeLifecycle.mjs";

const BOOTSTRAP_STATE = Symbol.for("weft.extension-bootstrap.v1");
const ACTIVE_RUNTIME_PATH = "./activeRuntime.mjs";
const PAIRING_CANVAS_PATH = "./pairingCanvas.mjs";

async function defaultLoadPairingCanvas(options) {
  const module = await import(PAIRING_CANVAS_PATH);
  return module.createPairingCanvasServer(options);
}

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
  createCanvas,
  loadPairingCanvas = defaultLoadPairingCanvas,
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
  const pairingPanels = new Map();

  const activate = async ({ reason, context = null, showQr = false } = {}) => {
    if (closing) throw new Error("This Copilot session has ended.");
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
          return activeRuntime;
        } catch (error) {
          activationPromise = null;
          lifecycleHost?.updatePresence({ state: "degraded" });
          throw error;
        }
      })();
    }
    const runtime = await activationPromise;
    if (closing) throw new Error("This Copilot session has ended.");
    try {
      const result = await runtime.activate({ reason, context, showQr });
      lifecycleHost?.updatePresence({ state: "active" });
      return result;
    } catch (error) {
      lifecycleHost?.updatePresence({ state: "degraded" });
      throw error;
    }
  };

  const preparePairing = async (options = {}) => {
    if (closing) throw new Error("This Copilot session has ended.");
    if (!activeRuntime) await activate({ reason: "pairing" });
    return activeRuntime.preparePairing(options);
  };
  const pairingStatus = () => activeRuntime?.status() ?? { state: "dormant" };
  const pairingCanvas = typeof createCanvas === "function" ? createCanvas({
    id: "weft-pairing",
    displayName: "Weft",
    description: "Pair a phone to this Copilot session with a graphical QR and live connection status.",
    inputSchema: {
      type: "object",
      properties: { transport: { type: "string", enum: ["supabase", "devtunnel"] } },
      additionalProperties: false,
    },
    actions: [{
      name: "status",
      description: "Check the phone connection without exposing the pairing credential.",
      handler: () => ({ state: pairingStatus().state }),
    }],
    open: async ({ instanceId, input }) => {
      let panel = pairingPanels.get(instanceId);
      if (!panel) {
        panel = loadPairingCanvas({ preparePairing, status: pairingStatus }).catch((error) => {
          pairingPanels.delete(instanceId);
          throw error;
        });
        pairingPanels.set(instanceId, panel);
      }
      const server = await panel;
      try {
        await preparePairing({ transport: input?.transport });
      } catch (error) {
        server.setError(error.message);
      }
      return { title: "Weft - pair your phone", url: server.url };
    },
    onClose: async ({ instanceId }) => {
      const panel = pairingPanels.get(instanceId);
      pairingPanels.delete(instanceId);
      if (panel) await (await panel).close();
    },
  }) : null;

  const session = await joinSession({
    streaming: true,
    ...(pairingCanvas ? { canvases: [pairingCanvas] } : {}),
    tools: [{
      name: "weft_pair",
      description: "Pair a phone to this session. Opens a graphical QR in the Copilot app, or shows the terminal QR in CLI. Use only when the user asks to pair or open Weft.",
      parameters: {
        type: "object",
        properties: { transport: { type: "string", enum: ["supabase", "devtunnel"] } },
        additionalProperties: false,
      },
      handler: async (args = {}) => {
        if (pairingCanvas && session.capabilities?.ui?.canvases) {
          await session.rpc.canvas.open({
            canvasId: "weft-pairing",
            instanceId: "weft-phone-pairing",
            input: args,
          });
          return "Weft pairing is open in the side panel. Scan the QR or copy its code to the phone.";
        }
        await activate({ reason: "command", context: { args: args.transport ?? "" }, showQr: true });
        return "Weft pairing is shown in the session. CLI users can also run /weft.";
      },
    }],
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
      try {
        await Promise.all([...pairingPanels.values()].map(async (panel) => (await panel).close()));
      } finally {
        pairingPanels.clear();
        if (activeRuntime) {
          if (isClear(reason)) activeRuntime.discardHandoffIdentity();
          await activeRuntime.shutdown(reason, { preserveIdentity });
        }
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

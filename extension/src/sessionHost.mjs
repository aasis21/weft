// SPDX-License-Identifier: Apache-2.0
//
// The session host: Weft's dormant presence inside one Copilot session (LLD §5.1).
//
//   * joins the Copilot session (tools, /weft, the pairing canvas);
//   * publishes the live record ~/.weft/sessions-live/<runtimeId>.json (dormant until activated);
//   * serves the local control pipe Station uses (sessionControl.mjs);
//   * owns the ONE transition queue: activate · reload · resetLink · switchTransport ·
//     replaceController · stop run one at a time, and `stop` drains then rejects new work;
//   * loads the session link (sessionLink.mjs, its own bundle) only when something activates it.
//
// Kept free of crypto, QR, transport and relay imports so a dormant session costs almost nothing.
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import {
  deriveStoreAuthority,
  getTerminalInstanceId,
  nextSessionRuntime,
  publishSessionRecord,
} from "./sessionRegistry.mjs";
import { sessionPipeAddress, startSessionControlServer } from "./sessionControl.mjs";
import { resolveVersion } from "./version.mjs";

const HOST_STATE = Symbol.for("weft.session-host.v2");
const SESSION_LINK_PATH = "./sessionLink.mjs";
const PAIRING_CANVAS_PATH = "./pairingCanvas.mjs";
export const TRANSITION_KINDS = Object.freeze([
  "activate", "reload", "resetLink", "switchTransport", "replaceController", "stop",
]);

async function defaultLoadPairingCanvas(options) {
  const module = await import(PAIRING_CANVAS_PATH);
  return module.createPairingCanvasServer(options);
}

async function defaultLoadSessionLink(options) {
  const module = await import(SESSION_LINK_PATH);
  return module.createSessionLink(options);
}

function defaultStorePath() {
  return join(homedir(), ".copilot", "session-store.db");
}

function shutdownReason(event) {
  return event?.data?.shutdownType ?? event?.data?.errorReason ?? "session_end";
}

const isClear = (reason) => String(reason).toLowerCase().includes("clear");

/** Request id from a Station handoff identity file, read without crypto (dormant-safe). */
function readHandoffRequestId(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const id = parsed?.requestId;
    return typeof id === "string" && id ? id : null;
  } catch {
    return null;
  }
}

function stale(message, extra = {}) {
  return Object.assign(new Error(message), { code: "stale", ...extra });
}

const RELOAD_IDLE_CHECK_MS = 5_000;

/** Whether a turn is in flight: true, false, or null when this Copilot cannot tell. */
async function readSessionBusy(session) {
  const metadata = session?.rpc?.metadata;
  try {
    if (typeof metadata?.activity === "function") {
      const activity = await metadata.activity();
      if (typeof activity?.hasActiveWork === "boolean") return activity.hasActiveWork;
    }
  } catch { /* fall through */ }
  try {
    if (typeof metadata?.isProcessing === "function") {
      const processing = await metadata.isProcessing();
      return Boolean(processing && (typeof processing === "object" ? processing.isProcessing : processing));
    }
  } catch { /* unknown */ }
  return null;
}

export async function startSessionHost({
  joinSession,
  createCanvas,
  loadPairingCanvas = defaultLoadPairingCanvas,
  loadSessionLink = defaultLoadSessionLink,
  storePath = defaultStorePath(),
  env = process.env,
  scope = globalThis,
  processTarget = process,
  identityFileExists = existsSync,
  baseDir,
  now = Date.now,
  publishRecord = publishSessionRecord,
  recordOptions = {},
  startControl = startSessionControlServer,
  controlOptions,
  setTimer = (fn, ms) => {
    const handle = setTimeout(fn, ms);
    handle.unref?.();
    return handle;
  },
} = {}) {
  if (typeof joinSession !== "function") throw new Error("joinSession is required");

  const identityFile = env.WEFT_IDENTITY_FILE || "";
  const channelIdEnv = env.WEFT_CHANNEL_ID || "";
  // Copilot may preserve the original child environment across `/clear`. The identity file is the
  // durable handoff authority, so a now-missing file means the clear intentionally revoked it.
  const explicitHandoff = identityFile ? identityFileExists(identityFile) : Boolean(channelIdEnv);
  delete env.WEFT_IDENTITY_FILE;
  delete env.WEFT_CHANNEL_ID;

  let link = null;
  let linkLoading = null;
  let reloadIdentity = null;
  let record = null;
  let control = null;
  let stopping = false;
  let reloadWaiting = false;
  let closePromise = null;
  const pairingPanels = new Map();

  // ---- transition queue -------------------------------------------------------------------------
  let queue = Promise.resolve();
  function enqueue(kind, fn) {
    if (stopping && kind !== "stop") return Promise.reject(new Error("This Copilot session has ended."));
    const run = queue.then(async () => {
      const started = now();
      try {
        return await fn();
      } finally {
        link?.log?.("queue.transition", { kind, ms: now() - started });
      }
    });
    queue = run.catch(() => {});
    return run;
  }

  async function ensureLink() {
    if (stopping) throw new Error("This Copilot session has ended.");
    if (link) return link;
    linkLoading ??= (async () => {
      const created = await loadSessionLink({
        session,
        record,
        reloadIdentity,
        identityFile: explicitHandoff ? identityFile : "",
        channelIdEnv: explicitHandoff ? channelIdEnv : "",
        handoffExpected: explicitHandoff,
        requestTransition: enqueue,
      });
      reloadIdentity = null;
      link = created;
      return created;
    })().finally(() => { linkLoading = null; });
    return linkLoading;
  }

  const activateLink = async ({ context = null, showQr = false } = {}) => {
    const active = await ensureLink();
    return active.activate({ showQr, context });
  };

  const preparePairing = (options = {}) =>
    enqueue("activate", async () => (await ensureLink()).preparePairing(options));
  const pairingStatus = () => link?.status() ?? { state: "dormant" };
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
        panel = loadPairingCanvas({ session, preparePairing, status: pairingStatus }).catch((error) => {
          pairingPanels.delete(instanceId);
          throw error;
        });
        pairingPanels.set(instanceId, panel);
      }
      const server = await panel;
      try {
        await preparePairing({ transport: input?.transport });
        server.setError(null);
      } catch (error) {
        server.setError(error.message);
      }
      return { title: await server.getTitle(), url: server.url };
    },
    onClose: async ({ instanceId }) => {
      const panel = pairingPanels.get(instanceId);
      pairingPanels.delete(instanceId);
      if (panel) await (await panel).close();
    },
  }) : null;

  const showPairing = async (context = {}) => {
    const transport = context.args?.trim();
    if (pairingCanvas && (session.capabilities?.ui?.canvases || pairingPanels.size > 0)) {
      const instanceId = pairingPanels.keys().next().value ?? "weft-phone-pairing";
      if (pairingPanels.has(instanceId) && transport) await preparePairing({ transport });
      await session.rpc.canvas.open({
        canvasId: "weft-pairing",
        instanceId,
        input: transport ? { transport } : {},
      });
      return "Weft pairing is open in the side panel. Scan the QR or copy its code to the phone.";
    }
    await enqueue("activate", () => activateLink({ context, showQr: true }));
    return "Weft pairing is shown in the session. CLI users can also run /weft.";
  };

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
      handler: (args = {}) => showPairing({ args: args.transport ?? "" }),
    }, {
      name: "weft_workspace_access",
      description: "Authorize one read-only workspace request from your paired Weft phone. Does not return file content or change files. Only handles requests already pending in Weft.",
      parameters: {
        type: "object", additionalProperties: false,
        properties: {
          requestId: { type: "string" },
          action: { type: "string", enum: ["list", "changes", "open", "diff"] },
          path: { type: "string" },
          scope: { type: "string", enum: ["workspace", "touched"], description: "For listing requests, identifies the current-folder or agent-touched tree." },
        },
        required: ["requestId", "action", "path"],
      },
      handler: async (args) => {
        if (!link) throw new Error("No paired workspace request is pending.");
        return link.grantWorkspaceAccess(args);
      },
    }],
    onPermissionRequest: async (request, invocation) => {
      if (!link) return { kind: "user-not-available" };
      return link.onPermissionRequest(request, invocation);
    },
    commands: [{
      name: "weft",
      description: "Pair your phone with this Copilot session. Optional transport: /weft [supabase|devtunnel].",
      handler: async (context) => {
        try {
          return await showPairing(context);
        } catch (error) {
          session.log?.(`Weft: ${error?.message ?? error}`, { level: "warning", ephemeral: false });
          return null;
        }
      },
    }],
  });

  // ---- reload / replacement of a previous instance in this process ------------------------------
  const previous = scope[HOST_STATE];
  const sameSessionReload = previous?.sessionId === session.sessionId;
  let activateAfterStart = false;
  let openedBy = null;
  if (sameSessionReload) {
    activateAfterStart = Boolean(previous.link);
    openedBy = previous.record?.record?.run?.openedBy ?? null;
    // The predecessor cancels and AWAITS its pending transport before handing over the identity.
    reloadIdentity = await previous.close("extension_reload", { keepIdentity: true });
  } else if (previous) {
    await previous.close("replaced");
  }

  // ---- identity + live record + control pipe ----------------------------------------------------
  const storeAuthority = deriveStoreAuthority(storePath);
  const sessionId = String(session.sessionId ?? "").trim() || "unknown-session";
  const { runtimeId, generation } = nextSessionRuntime({ storeAuthority, sessionId }, { scope });
  const handoffRequestId = explicitHandoff && identityFile ? readHandoffRequestId(identityFile) : null;
  openedBy ??= handoffRequestId
    ? { kind: "station", requestId: handoffRequestId }
    : explicitHandoff ? { kind: "handoff", requestId: null } : { kind: "user", requestId: null };
  const pipe = sessionPipeAddress(runtimeId, { baseDir });
  record = await publishRecord({
    session: { storeAuthority, sessionId },
    run: {
      runtimeId,
      generation,
      terminalInstanceId: getTerminalInstanceId({ scope }),
      version: resolveVersion(),
      openedBy,
      cwd: session.cwd ?? session.workingDirectory ?? process.cwd(),
    },
    pipe,
    link: {
      state: "dormant",
      generation: reloadIdentity?.linkGeneration ?? 0,
      controllerRevision: reloadIdentity?.controllerRevision ?? 0,
      endpointRevision: reloadIdentity?.endpointRevision ?? 0,
    },
  }, { baseDir, now, ...recordOptions });

  const controlIdentity = () => ({ storeAuthority, sessionId, runtimeInstanceId: runtimeId, generation });
  const handlers = {
    probe: () => {
      const status = link?.status?.() ?? null;
      return {
        runtimeId,
        generation,
        sessionId,
        storeAuthority,
        version: resolveVersion(),
        link: { ...record.record.link },
        controllerDeviceId: status?.controllerDeviceId ?? null,
        controllerName: status?.phoneName ?? null,
      };
    },
    activate: (payload) => enqueue("activate", () => activateLink({
      context: { requesterId: payload?.requesterId ?? null, requestId: payload?.requestId ?? null },
    })),
    status: () => link?.status() ?? {
      state: "dormant",
      linkGeneration: record.record.link.generation,
      sessionId,
      pid: process.pid,
      version: resolveVersion(),
      connected: false,
      paired: false,
      watchLevel: "off",
    },
    resetLink: (payload) => {
      const expect = payload?.expectGeneration;
      const result = () => ({ result: "stale", generation: link?.generation ?? record.record.link.generation });
      if (!link || link.generation !== expect) return result();
      return enqueue("resetLink", async () => {
        if (!link || link.generation !== expect) return result();
        const status = await link.resetLink({ by: payload?.by ?? "station" });
        return { result: "reset", generation: status.linkGeneration };
      });
    },
    replaceController: (payload) => enqueue("replaceController", async () => {
      const active = await ensureLink();
      if (active.controllerRevision !== payload?.expectControllerRevision) {
        throw stale("The session's controller changed; confirm again.");
      }
      return active.replaceController();
    }),
    quiesce: (payload) => enqueue("stop", async () => {
      if (!link) return { state: "dormant" };
      const stopped = link;
      const identity = await stopped.stop({ reason: payload?.reason ?? "quiesce", keepIdentity: true, announce: true });
      link = null;
      // The phone is disconnected; the next activation needs a fresh grant, never the old trust.
      reloadIdentity = identity ? {
        ...identity,
        trustedPeerPublicKeyB64: null,
        controllerDeviceId: null,
        controllerName: null,
        pairingToken: null,
        pairingExpiresAt: null,
        controllerRevision: (identity.controllerRevision ?? 0) + 1,
      } : null;
      record.update({ link: { state: "dormant", controllerRevision: reloadIdentity?.controllerRevision ?? 0 }, offer: null });
      return { state: "dormant" };
    }),
    traffic: () => link?.traffic?.() ?? { title: null, entries: [] },
    reloadExtension: async (payload) => {
      const reload = session.rpc?.extensions?.reload;
      if (typeof reload !== "function") {
        throw Object.assign(new Error("This Copilot version cannot reload extensions on request. Run /extensions reload in the session."), { code: "unsupported" });
      }
      // Reply first; the reload replaces this instance.
      const reloadSoon = () => setTimer(() => {
        if (!stopping) void Promise.resolve().then(() => reload.call(session.rpc.extensions)).catch(() => {});
      }, 50);
      if (!payload?.whenIdle) {
        reloadSoon();
        return { state: "reloading" };
      }
      if (reloadWaiting) return { state: "waiting-for-turn" };
      const busy = await readSessionBusy(session);
      if (busy === null) return { state: "activity-unknown" };
      if (!busy) {
        reloadSoon();
        return { state: "reloading" };
      }
      // Never cut a turn off: check again until the session is idle, then reload.
      reloadWaiting = true;
      const check = async () => {
        if (stopping) return;
        const stillBusy = await readSessionBusy(session);
        if (stillBusy === false) reloadSoon();
        else if (stillBusy === true) setTimer(check, RELOAD_IDLE_CHECK_MS);
        else reloadWaiting = false;
      };
      setTimer(check, RELOAD_IDLE_CHECK_MS);
      return { state: "waiting-for-turn" };
    },
  };
  try {
    control = await startControl({
      identity: controlIdentity,
      capability: () => record.capability,
      pipe,
      handlers,
    }, controlOptions);
  } catch (error) {
    record.close();
    throw error;
  }

  const onProcessExit = () => {
    record?.close();
  };
  processTarget.once?.("exit", onProcessExit);

  async function close(reason = "session_end", { keepIdentity = false } = {}) {
    closePromise ??= (async () => {
      processTarget.off?.("exit", onProcessExit);
      let identity = null;
      let failure = null;
      try {
        await enqueue("stop", async () => {
          stopping = true;
          try {
            await Promise.all([...pairingPanels.values()].map(async (panel) => (await panel).close()));
          } finally {
            pairingPanels.clear();
            if (linkLoading) await linkLoading.catch(() => {});
            if (link) {
              if (isClear(reason)) link.discardHandoffIdentity();
              identity = await link.stop({ reason, keepIdentity });
            }
          }
        });
      } catch (error) {
        failure = error;
      }
      try {
        await control?.close();
      } finally {
        // A reload keeps the record file for the successor; anything else removes it.
        record?.close({ remove: !keepIdentity });
        if (scope[HOST_STATE]?.close === close) delete scope[HOST_STATE];
      }
      if (failure) throw failure;
      return identity ?? (keepIdentity ? reloadIdentity : null);
    })();
    return closePromise;
  }

  const state = {
    sessionId: session.sessionId,
    runtimeId,
    generation,
    get link() {
      return link;
    },
    get record() {
      return record;
    },
    get control() {
      return control;
    },
    handlers,
    enqueue,
    activate: (options = {}) => enqueue("activate", () => activateLink(options)),
    close,
  };
  scope[HOST_STATE] = state;

  session.on?.("session.shutdown", (event) => {
    void close(shutdownReason(event)).catch(() => {});
  });

  if (activateAfterStart) {
    await enqueue("reload", () => activateLink({}));
  } else if (explicitHandoff) {
    await enqueue("activate", () => activateLink({}));
  }

  return state;
}

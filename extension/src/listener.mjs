// SPDX-License-Identifier: Apache-2.0
import { existsSync, statSync } from "node:fs";
import { hostname } from "node:os";
import { randomInt } from "node:crypto";
import {
  EVENT_TYPE,
  PAIR_KIND,
  SUBTYPE,
  SecureChannel,
  buildPairingPayload,
  deviceHeartbeat,
  exportKeyPair,
  generateKeyPair,
  listenForPeers,
  projectList,
  randomChannelId,
  spawnPairing,
  spawnResult,
} from "@aasis21/helm-shared";
import { createTransport } from "./transportFactory.mjs";
import { spawnCopilotSession } from "./spawn.mjs";
import * as projectsStore from "./projects.mjs";
import { getOrCreateDeviceId } from "./deviceIdentity.mjs";

const ADJECTIVES = ["brave", "calm", "clever", "curious", "gentle", "quick", "sunny", "tidy"];
const ANIMALS = ["otter", "fox", "heron", "panda", "lynx", "wren", "seal", "yak"];
// Proactive DEVICE_HEARTBEAT cadence: independent of PROJECT_LIST_REQUEST/PROJECT_LIST, so an idle
// phone (not polling) can still tell the listener process is alive, not just that the transport
// socket is up.
const DEVICE_HEARTBEAT_MS = 15_000;

export function createListener({
  transport = null,
  keyPair = null,
  channelId = null,
  deviceId = null,
  heartbeatMs = DEVICE_HEARTBEAT_MS,
  spawnFn,
  projectsApi = projectsStore,
  log = console,
} = {}) {
  let listenerTransport = transport;
  let listenerKeyPair = keyPair;
  let listenerChannelId = channelId;
  // Stable, non-secret device id (persisted across restarts) — see deviceIdentity.mjs. Independent
  // of listenerChannelId/listenerKeyPair, which stay ephemeral per run for forward secrecy.
  const listenerDeviceId = deviceId ?? getOrCreateDeviceId();
  let pairingPayload = null;
  let pairingStop = null;
  let controlUnsub = null;
  let boundPeerPub = null;
  let channel = null;
  let stopped = false;
  let started = false;
  let heartbeatTimer = null;

  const start = async () => {
    if (started) return api;
    started = true;
    stopped = false;
    listenerKeyPair ??= await generateKeyPair();
    listenerChannelId ??= randomChannelId();
    listenerTransport ??= createTransport({ channelId: listenerChannelId });
    pairingPayload = buildPairingPayload({
      channelId: listenerChannelId,
      publicKeyB64: listenerKeyPair.publicKeyB64,
      kind: PAIR_KIND.LISTENER,
    });
    const handle = await listenForPeers({
      transport: listenerTransport,
      keyPair: listenerKeyPair,
      connect: true,
      channelId: listenerChannelId,
      senderId: "helm-listener",
      senderName: hostname(),
      onPeer: bindPeer,
    });
    pairingStop = handle.stop;
    return api;
  };

  const stop = async () => {
    if (stopped) return;
    stopped = true;
    stopHeartbeat();
    try {
      controlUnsub?.();
    } catch {
      // best-effort
    }
    controlUnsub = null;
    try {
      pairingStop?.();
    } catch {
      // best-effort
    }
    pairingStop = null;
    boundPeerPub = null;
    channel = null;
    try {
      await listenerTransport?.close?.();
    } catch {
      // best-effort
    }
  };

  function stopHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }

  async function bindPeer({ key, peer }) {
    if (stopped) return;
    if (boundPeerPub && peer.publicKeyB64 !== boundPeerPub) {
      log?.warn?.(`Helm listener: ignoring pairing from a different phone (${peer.senderName ?? peer.deviceId ?? "unknown"})`);
      return;
    }
    boundPeerPub = peer.publicKeyB64;
    try {
      controlUnsub?.();
    } catch {
      // best-effort
    }
    stopHeartbeat();
    channel = new SecureChannel({
      transport: listenerTransport,
      key,
      identity: {
        channelId: listenerChannelId,
        senderId: "helm-listener",
        senderName: hostname(),
      },
    });
    controlUnsub = channel.onEvent(EVENT_TYPE.CONTROL, (envelope) => {
      void handleControl(envelope);
    });
    await sendProjectList();
    // Proactive liveness beat: unlike PROJECT_LIST (request/reply), this fires on a fixed interval
    // so the phone can tell the listener process is alive even when it isn't actively polling.
    heartbeatTimer = setInterval(() => {
      void channel?.send(deviceHeartbeat(listenerDeviceId))?.catch?.(() => {});
    }, heartbeatMs);
    heartbeatTimer.unref?.();
  }

  async function sendProjectList() {
    if (!channel || stopped) return;
    const projects = (await Promise.resolve(projectsApi.listProjects())).map((p) => ({
      name: p.name,
      path: p.path,
      isDefault: p.isDefault === true || p.default === true,
    }));
    await channel.send(projectList(projects, hostname(), listenerDeviceId));
  }

  async function handleControl(envelope) {
    if (stopped || envelope?.eventType !== EVENT_TYPE.CONTROL) return;
    if (envelope.eventSubtype === SUBTYPE.CONTROL.PROJECT_LIST_REQUEST) {
      await sendProjectList();
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.SPAWN_SESSION) {
      await handleSpawn(envelope.msg ?? {});
      return;
    }
    if (envelope.eventSubtype === SUBTYPE.CONTROL.FORGET_DEVICE) {
      await stop();
    }
  }

  async function handleSpawn({ requestId, projectName, mode = "default", name }) {
    const id = requestId || `request-${Date.now()}`;
    try {
      const project = await resolveProject(projectName);
      const sessionName = cleanSessionName(name) || friendlyName();
      const newChannelId = randomChannelId();
      const newKeyPair = await generateKeyPair();
      const { publicKeyB64, privateKeyJwk } = await exportKeyPair(newKeyPair);
      const result = spawnCopilotSession({
        project,
        name: sessionName,
        mode,
        identity: { channelId: newChannelId, publicKeyB64, privateKeyJwk },
        spawnFn,
      });
      if (!result.ok) {
        await channel?.send(spawnResult(id, false, result.error || "Could not spawn Copilot"));
        return;
      }
      await channel?.send(
        spawnPairing(
          id,
          buildPairingPayload({ channelId: newChannelId, publicKeyB64, kind: PAIR_KIND.SESSION }),
          sessionName,
          project.name,
        ),
      );
      await channel?.send(spawnResult(id, true));
    } catch (err) {
      await channel?.send(spawnResult(id, false, err?.message ?? String(err)));
    }
  }

  async function resolveProject(projectName) {
    const projects = await Promise.resolve(projectsApi.listProjects());
    const requested = cleanSessionName(projectName);
    const project = requested
      ? projects.find((p) => p.name === requested)
      : projects.find((p) => p.default === true || p.isDefault === true);
    if (!project) throw new Error(requested ? `Unknown project: ${requested}` : "No project selected");
    if (!existsSync(project.path) || !statSync(project.path).isDirectory()) {
      throw new Error(`Project path is missing or not a directory: ${project.path}`);
    }
    return project;
  }

  const api = {
    start,
    stop,
    get channelId() {
      return listenerChannelId;
    },
    get deviceId() {
      return listenerDeviceId;
    },
    get pairingPayload() {
      return pairingPayload;
    },
  };
  return api;
}

function cleanSessionName(name) {
  const value = String(name ?? "").trim();
  return value || null;
}

function friendlyName() {
  const adjective = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const animal = ANIMALS[randomInt(ANIMALS.length)];
  return `${adjective}-${animal}-${randomInt(1000, 9999)}`;
}

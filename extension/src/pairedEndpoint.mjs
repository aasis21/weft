// SPDX-License-Identifier: Apache-2.0
import { listenForPeers } from "@aasis21/weft-shared";

export async function openPairedEndpoint({ transport, onPeer, onDisconnected, ...options }) {
  let closed = false;
  let chain = Promise.resolve();
  const pairing = await listenForPeers({
    ...options, transport,
    onPeer: (peer) => {
      const operation = chain.then(() => closed ? undefined : onPeer(peer));
      chain = operation.catch(() => {});
      return operation;
    },
  });
  const stopStatus = transport.onStatus?.((state, detail) => {
    if (!closed && state === "disconnected") onDisconnected?.(detail);
  });
  return {
    stop() {
      if (closed) return;
      closed = true;
      stopStatus?.();
      pairing.stop();
    },
  };
}

export function createAttentionLease({
  now = Date.now, leaseMs = 60_000, cooldownMs = 5_000,
} = {}) {
  let negotiated = false;
  let id = null;
  let level = "off";
  let expiresAt = 0;
  const retired = new Set();
  return {
    get negotiated() { return negotiated; },
    get level() { return !negotiated ? "detail" : now() < expiresAt ? level : "off"; },
    update(request) {
      if (
        typeof request?.watchId !== "string" || !request.watchId.trim() ||
        request.watchId.length > 128 || !["detail", "compact", "off"].includes(request.level) ||
        (request.leaseMs !== undefined && (!Number.isFinite(request.leaseMs) || request.leaseMs <= 0))
      ) throw new Error("Invalid attention watch request.");
      if (retired.has(request.watchId) || (request.level === "off" && id && request.watchId !== id)) return null;
      if (id && id !== request.watchId) {
        retired.add(id);
        if (retired.size > 128) retired.delete(retired.values().next().value);
      }
      negotiated = true;
      id = request.watchId;
      const duration = Math.max(15_000, Math.min(120_000, request.leaseMs ?? leaseMs));
      if (request.level === "off") {
        retired.add(id);
        expiresAt = Math.min(expiresAt, now() + cooldownMs);
      } else {
        level = request.level;
        expiresAt = now() + duration;
      }
      return { watchId: id, level: request.level, leaseMs: request.level === "off" ? cooldownMs : duration };
    },
    reset() {
      negotiated = false;
      id = null;
      level = "off";
      expiresAt = 0;
      retired.clear();
    },
  };
}

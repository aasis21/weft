// SPDX-License-Identifier: Apache-2.0
// A tiny local WebSocket relay server: pairs up sockets by `?channelId=` on the connection URL and
// forwards any message one peer sends to every OTHER peer in the same room. It never inspects
// message contents (Helm's own E2E encryption already covers that — see shared/transport-relay.mjs,
// whose wire frame is opaque `{event, envelope}`), so this file has zero crypto/auth logic of its
// own. It exists so a transport built on `createRelayTransport` has something to connect BOTH ends
// to: normally that's a managed service (Supabase Realtime, Azure Web PubSub); for the `devtunnel`
// provisioning path (see devtunnel.mjs) it's this process itself, exposed publicly by `devtunnel
// host` pointing at the port this server listens on.
import { WebSocketServer } from "ws";

/**
 * Start a relay server bound to 127.0.0.1 (devtunnel forwards a public port to this local one —
 * the server itself never needs to be reachable except through the tunnel). Passing `port: 0`
 * (the default) lets the OS pick a free ephemeral port, read back via the returned `port`.
 */
export function startRelayServer({ port = 0 } = {}) {
  const rooms = new Map(); // channelId -> Set<WebSocket>

  const wss = new WebSocketServer({ host: "127.0.0.1", port });

  wss.on("connection", (socket, request) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const channelId = url.searchParams.get("channelId");
    if (!channelId) {
      socket.close(1008, "channelId required");
      return;
    }

    let room = rooms.get(channelId);
    if (!room) {
      room = new Set();
      rooms.set(channelId, room);
    }
    room.add(socket);

    socket.on("message", (data, isBinary) => {
      for (const peer of room) {
        if (peer !== socket && peer.readyState === socket.OPEN) peer.send(data, { binary: isBinary });
      }
    });

    socket.on("close", () => {
      room.delete(socket);
      if (room.size === 0) rooms.delete(channelId);
    });

    socket.on("error", () => {
      // The 'close' handler above still fires and cleans up the room entry.
    });
  });

  const ready = new Promise((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });

  return {
    ready,
    get port() {
      const address = wss.address();
      return typeof address === "object" && address ? address.port : null;
    },
    /** Room membership count, for tests/diagnostics — not used on the hot path. */
    roomSize(channelId) {
      return rooms.get(channelId)?.size ?? 0;
    },
    async close() {
      for (const room of rooms.values()) {
        for (const socket of room) socket.close(1001, "server shutting down");
      }
      rooms.clear();
      await new Promise((resolve) => wss.close(() => resolve()));
    },
  };
}

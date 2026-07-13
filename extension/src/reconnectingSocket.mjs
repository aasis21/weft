// SPDX-License-Identifier: Apache-2.0
import WebSocket from "ws";

const WS_CONNECTING = 0;
const WS_OPEN = 1;

/**
 * A self-healing WebSocket-like wrapper for the devtunnel / self-hosted relay transport.
 *
 * The devtunnel path used to hand `createRelayTransport` a raw, one-shot `ws` socket with no
 * reconnect and no keepalive. When a Dev Tunnel (or the relay) drops an idle connection, that
 * socket is gone for good — and because the Device Station's device-heartbeat + status-line
 * timers are all `unref()`'d (see listener.mjs / bin/weft.mjs), the still-open socket handle is
 * the ONLY thing keeping the Node event loop alive. Once it disappears the loop drains and the
 * never-settling `await start()` in bin/weft.mjs trips Node's "Detected unsettled top-level
 * await" exit, silently killing the station. The Supabase transport never hit this because
 * supabase-js runs its own ref'd, self-reconnecting realtime socket.
 *
 * This wrapper gives the devtunnel path that same resilience:
 *   - transparently reconnects with exponential backoff when the underlying socket closes/errors,
 *   - sends periodic WebSocket pings so the tunnel/relay never idle-closes the connection, and
 *   - keeps its ping + reconnect timers REF'd so the process stays alive across reconnect gaps
 *     (this is what actually prevents the "unsettled top-level await" exit).
 *
 * It exposes only the subset of the WebSocket surface that createRelayTransport
 * (shared/transport-relay.mjs) touches — addEventListener / removeEventListener / send / close /
 * readyState — re-emitting open/message/close/error from whichever underlying socket is currently
 * live. Reconnection/keepalive lifecycle deliberately lives here on the extension side, keeping
 * shared/ at zero runtime dependencies and free of any tunnel/transport lifecycle concerns.
 *
 * @param {string} url  The room-scoped relay URL (already carrying `?channelId=…`).
 */
export function createReconnectingSocket(url, {
  WebSocketImpl = WebSocket,
  pingIntervalMs = 30_000,
  minBackoffMs = 1_000,
  maxBackoffMs = 30_000,
} = {}) {
  const listeners = { open: new Set(), message: new Set(), close: new Set(), error: new Set() };
  let ws = null;
  let closedByUser = false;
  let backoff = minBackoffMs;
  let reconnectTimer = null;
  let pingTimer = null;

  function emit(type, event) {
    for (const handler of listeners[type] ?? []) {
      try {
        handler(event);
      } catch {
        // One faulty listener must not break delivery to the others.
      }
    }
  }

  function clearPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  // Deliberately REF'd (no unref): a live ping both keeps the tunnel/relay from idle-closing the
  // socket AND keeps the station process in the event loop between beats — see the module doc.
  function startPing() {
    clearPing();
    pingTimer = setInterval(() => {
      try {
        ws?.ping?.();
      } catch {
        // Best-effort keepalive; a failed ping just means the next close/reconnect cycle runs.
      }
    }, pingIntervalMs);
  }

  // Deliberately REF'd (no unref): holds the event loop open during the gap between a dropped
  // socket and its replacement, so the station never falls through to Node's exit.
  function scheduleReconnect() {
    if (closedByUser || reconnectTimer) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, maxBackoffMs);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (closedByUser) return;
    let socket;
    try {
      socket = new WebSocketImpl(url);
    } catch (err) {
      emit("error", { message: err?.message ?? String(err) });
      scheduleReconnect();
      return;
    }
    ws = socket;

    socket.addEventListener("open", () => {
      if (closedByUser) return;
      backoff = minBackoffMs; // Reset backoff on a healthy connection.
      startPing();
      emit("open", {});
    });
    socket.addEventListener("message", (e) => {
      if (closedByUser) return;
      emit("message", e);
    });
    socket.addEventListener("close", (e) => {
      clearPing();
      if (closedByUser) return;
      emit("close", e);
      scheduleReconnect();
    });
    socket.addEventListener("error", (e) => {
      if (closedByUser) return;
      // `ws` always follows an 'error' with a 'close', which is what drives the reconnect — so we
      // only surface the error here and let the close handler schedule the retry (avoids racing
      // two reconnect timers for a single failure).
      emit("error", e);
    });
  }

  connect();

  return {
    get readyState() {
      return ws ? ws.readyState : WS_CONNECTING;
    },
    send(data) {
      if (!ws || ws.readyState !== WS_OPEN) {
        // Mirror a raw ws send on a non-open socket: throw so callers (e.g. the heartbeat's
        // best-effort try/catch) skip this beat and the next one retries once reconnected.
        throw new Error("weft/reconnecting-socket: socket is not open");
      }
      ws.send(data);
    },
    addEventListener(type, handler) {
      listeners[type]?.add(handler);
    },
    removeEventListener(type, handler) {
      listeners[type]?.delete(handler);
    },
    close() {
      closedByUser = true;
      clearPing();
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      try {
        ws?.close();
      } catch {
        // Best-effort close.
      }
    },
  };
}

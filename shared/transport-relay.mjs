// SPDX-License-Identifier: Apache-2.0
// Dev Tunnel / self-hosted WebSocket relay Transport — primarily for a Microsoft Dev Tunnel
// (devtunnel host) forwarding to a local ws server, but works unmodified for ANY self-hosted or
// tunneled ws endpoint (a plain `ws` server you run yourself, a Cloudflare Durable Object, ngrok,
// etc.) since it only ever touches an already-open socket. Unlike Supabase/Web PubSub there is no
// separate "group" concept to join: the socket itself already terminates at an endpoint scoped to
// one pairing (the tunnel URL, or a server-side room keyed by channelId before the connection was
// handed to us), so channelId here is only asserted for parity with the other Transport
// factories and is never put on the wire.
//
// The caller is responsible for constructing an already-open-or-opening, already-authenticated
// WebSocket (any object exposing the standard addEventListener/removeEventListener/send/close/
// readyState surface — both the `ws` npm package and the browser/React Native global WebSocket
// qualify) pointed at the tunnel/relay URL (including any access token, e.g. as a query param)
// *before* calling this factory. This keeps shared/ at zero runtime dependencies and mirrors
// transport-supabase.mjs / transport-webpubsub.mjs's "caller passes in an already-constructed
// client" convention — auth/tunnel lifecycle never lives in shared/.
//
// Wire format: publish(event, envelope) -> socket.send(JSON.stringify({ event, envelope })),
// the same {event, envelope} frame transport-webpubsub.mjs uses, so a server-side relay can stay
// a dumb byte/JSON forwarder.

const WS_OPEN = 1; // WebSocket.OPEN — hard-coded so this file needs no DOM/ws lib types.

function fail(message) {
  return new Error(`helm/transport-relay: ${message}`);
}

/**
 * @param {{ socket: unknown, channelId: string }} opts
 *   socket — an already-constructed WebSocket-like object pointed at the tunnel/relay endpoint
 *   for this pairing. Not shared across channels; one socket per Transport instance.
 */
export function createRelayTransport({ socket, channelId } = {}) {
  if (
    !socket ||
    typeof socket.send !== "function" ||
    typeof socket.addEventListener !== "function"
  ) {
    throw fail("socket with send()/addEventListener() is required");
  }
  if (!channelId) throw fail("channelId is required");

  let closed = false;
  let openResolved = socket.readyState === WS_OPEN;
  let openPromise;

  const statusHandlers = new Set();
  const eventHandlers = new Map(); // event -> Set<handler>

  function emitStatus(status, detail) {
    for (const handler of statusHandlers) {
      try {
        handler(status, detail);
      } catch {
        // One faulty status subscriber must not break the others.
      }
    }
  }

  function dispatch(event, payload) {
    const handlers = eventHandlers.get(event);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(payload);
      } catch {
        // One faulty subscriber must not break delivery to the others.
      }
    }
  }

  // Registered once, up front, so delivery is independent of subscribe()/connect() ordering
  // (matches transport-supabase.mjs / transport-webpubsub.mjs's catch-all listener).
  socket.addEventListener("message", (e) => {
    if (closed) return;
    let parsed;
    try {
      const data = typeof e?.data === "string" ? e.data : e;
      parsed = JSON.parse(data);
    } catch {
      return; // Not a Helm envelope frame; ignore.
    }
    if (!parsed || typeof parsed.event !== "string") return;
    dispatch(parsed.event, parsed.envelope);
  });

  socket.addEventListener("open", () => {
    if (closed) return;
    openResolved = true;
    emitStatus("connected");
  });
  socket.addEventListener("close", (e) => {
    if (closed) return;
    emitStatus("disconnected", e?.reason);
  });
  socket.addEventListener("error", (e) => {
    if (closed) return;
    emitStatus("disconnected", e?.message ?? "error");
  });

  function assertOpen(action) {
    if (closed) throw fail(`${action}: transport is closed`);
  }

  function ready() {
    assertOpen("connect");
    if (openResolved || socket.readyState === WS_OPEN) {
      openResolved = true;
      return Promise.resolve();
    }
    if (openPromise) return openPromise;

    openPromise = new Promise((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onError = (e) => {
        cleanup();
        reject(fail(`connect failed: ${e?.message ?? "socket error"}`));
      };
      function cleanup() {
        socket.removeEventListener?.("open", onOpen);
        socket.removeEventListener?.("error", onError);
      }
      socket.addEventListener("open", onOpen);
      socket.addEventListener("error", onError);
    }).finally(() => {
      openPromise = undefined;
    });

    return openPromise;
  }

  return {
    async connect() {
      await ready();
    },

    async publish(event, envelope) {
      assertOpen("publish");
      await ready();
      assertOpen("publish");
      try {
        socket.send(JSON.stringify({ event, envelope }));
      } catch (err) {
        throw fail(`send failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },

    subscribe(event, handler) {
      assertOpen("subscribe");
      let handlers = eventHandlers.get(event);
      if (!handlers) {
        handlers = new Set();
        eventHandlers.set(event, handlers);
      }
      handlers.add(handler);
      return () => {
        const current = eventHandlers.get(event);
        if (!current) return;
        current.delete(handler);
        if (current.size === 0) eventHandlers.delete(event);
      };
    },

    onStatus(handler) {
      if (closed) return () => {};
      statusHandlers.add(handler);
      if (openResolved || socket.readyState === WS_OPEN) {
        queueMicrotask(() => statusHandlers.has(handler) && handler("connected"));
      }
      return () => statusHandlers.delete(handler);
    },

    async close() {
      if (closed) return;
      closed = true;
      eventHandlers.clear();
      statusHandlers.clear();
      try {
        socket.close();
      } catch {
        // Best-effort close.
      }
    },
  };
}

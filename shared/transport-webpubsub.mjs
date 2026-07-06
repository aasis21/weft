// SPDX-License-Identifier: Apache-2.0
// Azure Web PubSub transport (Web PubSub swap-in for transport-supabase.mjs).
//
// Like transport-supabase.mjs, this module never constructs the SDK client or handles
// auth/token minting itself — the caller passes in an already-constructed
// `@azure/web-pubsub-client` WebPubSubClient (built from a client access URL/token obtained
// out-of-band, e.g. from a negotiate endpoint). This keeps shared/ at zero runtime
// dependencies and mirrors the existing { client, channelId } shape so callers can select a
// transport without touching SecureChannel or anything above it.
//
// Mapping onto the Transport interface:
//   - One Weft pairing channel -> one Web PubSub group, named `weft:<channelId>`.
//   - publish(event, envelope)  -> client.sendToGroup(group, JSON.stringify({event, envelope}))
//   - subscribe(event, handler) -> in-memory dispatch off a single "group-message" listener
//   - onStatus                 -> forwards the SDK's connected/disconnected/stopped events
//
// NOTE: `noEcho` and the exact sendToGroup(group, content, dataType, options) signature
// should be verified against the installed @azure/web-pubsub-client version before relying
// on self-echo suppression in production — this mirrors Supabase's `broadcast.self: false`,
// but Web PubSub's client SDK surface is less stable across versions than Supabase's.

function fail(message) {
  return new Error(`weft/transport-webpubsub: ${message}`);
}

/**
 * @param {{ client: unknown, channelId: string }} opts
 *   client — a WebPubSubClient (from @azure/web-pubsub-client), already constructed by the
 *   caller with a client access URL/token. Not yet started.
 */
export function createWebPubSubTransport({ client, channelId } = {}) {
  if (!client || typeof client.start !== "function" || typeof client.on !== "function") {
    throw fail("client with start()/on() is required");
  }
  if (!channelId) throw fail("channelId is required");

  const group = `weft:${channelId}`;

  let closed = false;
  let started = false;
  let joined = false;
  let connectPromise;

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
  // (matches transport-supabase.mjs's catch-all listener).
  client.on("group-message", (e) => {
    if (closed) return;
    const msg = e?.message;
    if (!msg || msg.group !== group) return;
    let parsed;
    try {
      parsed = typeof msg.data === "string" ? JSON.parse(msg.data) : msg.data;
    } catch {
      return; // Not a Weft envelope frame; ignore.
    }
    if (!parsed || typeof parsed.event !== "string") return;
    dispatch(parsed.event, parsed.envelope);
  });

  client.on("connected", () => {
    if (closed) return;
    emitStatus("connected");
  });
  client.on("disconnected", (e) => {
    if (closed) return;
    emitStatus("disconnected", e?.message);
  });
  client.on("stopped", () => {
    if (closed) return;
    emitStatus("disconnected", "stopped");
  });

  function assertOpen(action) {
    if (closed) throw fail(`${action}: transport is closed`);
  }

  async function ready() {
    assertOpen("connect");
    if (joined) return;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
      if (!started) {
        started = true;
        await client.start();
      }
      if (!joined) {
        await client.joinGroup(group);
        joined = true;
      }
    })().catch((err) => {
      connectPromise = undefined;
      started = false;
      const message = err instanceof Error ? err.message : String(err);
      throw fail(`connect failed: ${message}`);
    });

    return connectPromise;
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
        await client.sendToGroup(group, JSON.stringify({ event, envelope }), "text", {
          noEcho: true,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw fail(`send failed: ${message}`);
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
      if (joined) queueMicrotask(() => statusHandlers.has(handler) && handler("connected"));
      return () => statusHandlers.delete(handler);
    },

    async close() {
      if (closed) return;
      closed = true;
      eventHandlers.clear();
      statusHandlers.clear();
      if (typeof client.stop === "function") {
        try {
          await client.stop();
        } catch {
          // Best-effort close.
        }
      }
    },
  };
}

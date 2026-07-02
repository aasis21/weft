// SPDX-License-Identifier: Apache-2.0
// Supabase Realtime Broadcast transport.
//
// Required Supabase setup: enable Realtime Authorization for private channels and add RLS
// policies on `realtime.messages` that only allow authorized Helm clients to join
// `private:helm:*` channels. Channels are created with `config.private = true`, so joins
// are denied until those policies exist — apply
// `supabase/migrations/*_helm_realtime_broadcast_rls.sql`. The relay remains untrusted and
// only carries ciphertext.
//
// Subscribe-order independence: a SINGLE catch-all broadcast listener is registered at
// channel-creation time (before channel.subscribe()), and transport.subscribe() only
// mutates an in-memory dispatch map. This means callers may subscribe() before OR after
// connect() and still receive events — Supabase Realtime otherwise delivers only to
// listeners registered before subscribe(). Relies on realtime-js matching the `*`
// wildcard event for broadcast bindings.

const STATUS_SUBSCRIBED = "SUBSCRIBED";
const STATUS_CHANNEL_ERROR = "CHANNEL_ERROR";
const STATUS_TIMED_OUT = "TIMED_OUT";
const STATUS_CLOSED = "CLOSED";

function fail(message) {
  return new Error(`helm/transport-supabase: ${message}`);
}

/**
 * @param {{ client: unknown, channelId: string }} opts
 *   client — a SupabaseClient (from @supabase/supabase-js), created by the caller.
 */
export function createSupabaseTransport({ client, channelId } = {}) {
  if (!client || typeof client.channel !== "function") {
    throw fail("client with channel() is required");
  }
  if (!channelId) throw fail("channelId is required");

  const name = `private:helm:${channelId}`;
  const channel = client.channel(name, {
    config: { private: true, broadcast: { self: false, ack: true } },
  });

  let closed = false;
  let subscribed = false;
  let connectPromise;

  // Handlers observing live connection-state changes (see onStatus). Supabase Realtime keeps
  // invoking the subscribe() status callback for the channel's lifetime — SUBSCRIBED on
  // (re)join, CHANNEL_ERROR/TIMED_OUT/CLOSED on a drop — so we forward those as connected/
  // disconnected. Without this a silent socket drop is invisible until a heartbeat times out.
  const statusHandlers = new Set();

  function emitStatus(status, detail) {
    for (const handler of statusHandlers) {
      try {
        handler(status, detail);
      } catch {
        // One faulty status subscriber must not break the others.
      }
    }
  }

  // event -> Set<handler>. The catch-all listener below dispatches into this map, so
  // delivery is independent of when connect()/subscribe() are called.
  const eventHandlers = new Map();

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

  // Registered before channel.subscribe() (which runs in ready()), so no events are
  // missed regardless of subscribe()/connect() ordering.
  channel.on("broadcast", { event: "*" }, (msg) => {
    if (closed) return;
    dispatch(msg.event, msg.payload);
  });

  function assertOpen(action) {
    if (closed) throw fail(`${action}: transport is closed`);
  }

  async function ready() {
    assertOpen("connect");
    if (subscribed) return;
    if (connectPromise) return connectPromise;

    const promise = new Promise((resolve, reject) => {
      channel.subscribe((status, err) => {
        if (closed) return;
        if (status === STATUS_SUBSCRIBED) {
          subscribed = true;
          emitStatus("connected");
          resolve();
          return;
        }
        if (
          status === STATUS_CHANNEL_ERROR ||
          status === STATUS_TIMED_OUT ||
          status === STATUS_CLOSED
        ) {
          // A drop after we were already live is a live-connection event, not a connect
          // failure — surface it to onStatus subscribers so the UI can go Offline at once.
          if (subscribed) emitStatus("disconnected", err);
          const detail = err
            ? `: ${err instanceof Error ? err.message : String(err)}`
            : "";
          reject(fail(`subscribe failed with status ${status}${detail} (channel ${name})`));
        }
      });
    });

    connectPromise = promise.catch((err) => {
      connectPromise = undefined;
      if (err instanceof Error && err.message.startsWith("helm/transport-supabase:")) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw fail(`subscribe failed: ${message}`);
    });

    return connectPromise;
  }

  async function sendBroadcast(event, envelope) {
    try {
      const result = await channel.send({ type: "broadcast", event, payload: envelope });
      if (result === "error" || result === "timed out") {
        throw fail(`send failed with status ${result}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("helm/transport-supabase:")) {
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      throw fail(`send failed: ${message}`);
    }
  }

  async function removeChannel() {
    if (typeof client.removeChannel !== "function") {
      throw fail("client.removeChannel() is required");
    }
    try {
      await client.removeChannel(channel);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw fail(`removeChannel failed: ${message}`);
    }
  }

  return {
    async connect() {
      await ready();
    },

    async publish(event, envelope) {
      assertOpen("publish");
      await ready();
      assertOpen("publish");
      await sendBroadcast(event, envelope);
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
      // Give a late subscriber the current truth so it isn't stuck at an assumed state.
      if (subscribed) queueMicrotask(() => statusHandlers.has(handler) && handler("connected"));
      return () => statusHandlers.delete(handler);
    },

    async close() {
      if (closed) return;
      closed = true;
      eventHandlers.clear();
      statusHandlers.clear();
      await removeChannel();
    },
  };
}

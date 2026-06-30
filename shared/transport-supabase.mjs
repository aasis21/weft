// Supabase Realtime Broadcast transport.
//
// Required Supabase setup: enable Realtime Authorization for private channels and add RLS
// policies on `realtime.messages` that only allow authorized Helm clients to join
// `private:helm:*` channels. The relay remains untrusted and only carries ciphertext.

const STATUS_SUBSCRIBED = "SUBSCRIBED";
const STATUS_CHANNEL_ERROR = "CHANNEL_ERROR";
const STATUS_TIMED_OUT = "TIMED_OUT";

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
    config: { broadcast: { self: false, ack: true } },
  });

  let closed = false;
  let subscribed = false;
  let connectPromise;
  const subscriptions = new Set();

  function assertOpen(action) {
    if (closed) throw fail(`${action}: transport is closed`);
  }

  async function ready() {
    assertOpen("connect");
    if (subscribed) return;
    if (connectPromise) return connectPromise;

    const promise = new Promise((resolve, reject) => {
      channel.subscribe((status) => {
        if (status === STATUS_SUBSCRIBED) {
          subscribed = true;
          resolve();
          return;
        }
        if (status === STATUS_CHANNEL_ERROR || status === STATUS_TIMED_OUT) {
          reject(fail(`subscribe failed with status ${status}`));
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
      const entry = { active: true };
      subscriptions.add(entry);
      channel.on("broadcast", { event }, (msg) => {
        if (!entry.active) return;
        handler(msg.payload);
      });
      return () => {
        entry.active = false;
        subscriptions.delete(entry);
      };
    },

    async close() {
      if (closed) return;
      closed = true;
      for (const entry of subscriptions) entry.active = false;
      subscriptions.clear();
      await removeChannel();
    },
  };
}

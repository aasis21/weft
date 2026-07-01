// In-process Transport for local development and tests.
//
// Both ends of a pairing (the extension side and the simulated phone side) create a
// LocalTransport with the SAME channelId in the SAME process (e.g. the harness or a unit test)
// and exchange envelopes through a shared in-memory bus. No network, no Supabase.

/** channelId -> (event -> Set<handler>) */
const BUS = new Map();

function busFor(channelId) {
  let m = BUS.get(channelId);
  if (!m) {
    m = new Map();
    BUS.set(channelId, m);
  }
  return m;
}

/**
 * @param {{ channelId: string, deliverSelf?: boolean }} opts
 *   deliverSelf — if true, a publisher also receives its own publishes (default false).
 */
export function createLocalTransport({ channelId, deliverSelf = false } = {}) {
  if (!channelId) throw new Error("helm/transport-local: channelId is required");
  const localHandlers = new Map(); // event -> Set<handler> registered by THIS instance
  const statusHandlers = new Set();
  let closed = false;
  let connected = false;

  function emitStatus(status) {
    for (const h of statusHandlers) {
      try {
        h(status);
      } catch {
        /* isolate status-handler errors */
      }
    }
  }

  function track(event, handler) {
    let s = localHandlers.get(event);
    if (!s) {
      s = new Set();
      localHandlers.set(event, s);
    }
    s.add(handler);
  }

  return {
    async connect() {
      connected = true;
      emitStatus("connected");
    },

    async publish(event, envelope) {
      if (closed) throw new Error("helm/transport-local: transport is closed");
      const handlers = busFor(channelId).get(event);
      if (!handlers) return;
      for (const h of handlers) {
        if (!deliverSelf && localHandlers.get(event)?.has(h)) continue;
        // async-dispatch to mimic a network hop
        setTimeout(() => {
          try {
            h(envelope);
          } catch {
            /* isolate handler errors */
          }
        }, 0);
      }
    },

    subscribe(event, handler) {
      const handlers = busFor(channelId).get(event) ?? new Set();
      busFor(channelId).set(event, handlers);
      handlers.add(handler);
      track(event, handler);
      return () => {
        handlers.delete(handler);
        localHandlers.get(event)?.delete(handler);
      };
    },

    onStatus(handler) {
      if (closed) return () => {};
      statusHandlers.add(handler);
      if (connected) queueMicrotask(() => statusHandlers.has(handler) && handler("connected"));
      return () => statusHandlers.delete(handler);
    },

    async close() {
      closed = true;
      connected = false;
      emitStatus("disconnected");
      statusHandlers.clear();
      for (const [event, set] of localHandlers) {
        const shared = busFor(channelId).get(event);
        if (shared) for (const h of set) shared.delete(h);
      }
      localHandlers.clear();
    },
  };
}

/** Test helper: wipe the in-memory bus between tests. */
export function _resetLocalBus() {
  BUS.clear();
}

import {
  connectSession,
  createClientFromMaterial,
  pairSession,
  type WeftClient,
} from '@/lib/weftClient';
import type { StoredPairing } from '@/lib/storage';
import type { Transport } from '@aasis21/weft-shared';

export type ConnectOpts =
  | { raw: string; transport?: Transport }
  | { pairing: StoredPairing; transport?: Transport }
  | { channelId: string; key: CryptoKey; deviceId?: string; transport: Transport };

export interface TransportRegistry {
  connect(id: string, opts: ConnectOpts): Promise<WeftClient>;
  /** Register an already-created client (e.g. one the runtime paired directly to keep the pairing). */
  adopt(id: string, client: WeftClient): void;
  /** Move a client to a new id (identity reconcile after a channel rotation). */
  rehome(from: string, to: string): void;
  get(id: string): WeftClient | undefined;
  has(id: string): boolean;
  dispose(id: string): void;
  disposeAll(): void;
  ids(): string[];
}

export function createTransportRegistry(deps?: {
  createClient?: (opts: ConnectOpts) => WeftClient | Promise<WeftClient>;
}): TransportRegistry {
  const clients = new Map<string, WeftClient>();
  const createClient = deps?.createClient ?? createDefaultClient;

  return {
    async connect(id, opts) {
      const existing = clients.get(id);
      if (existing) {
        await existing.close().catch(() => {});
      }
      const client = await createClient(opts);
      clients.set(id, client);
      return client;
    },
    adopt(id, client) {
      const existing = clients.get(id);
      if (existing && existing !== client) void existing.close().catch(() => {});
      clients.set(id, client);
    },
    rehome(from, to) {
      const client = clients.get(from);
      if (!client) return;
      const displaced = clients.get(to);
      if (displaced && displaced !== client) void displaced.close().catch(() => {});
      clients.delete(from);
      clients.set(to, client);
    },
    get(id) {
      return clients.get(id);
    },
    has(id) {
      return clients.has(id);
    },
    dispose(id) {
      const client = clients.get(id);
      clients.delete(id);
      void client?.close().catch(() => {});
    },
    disposeAll() {
      for (const [id, client] of clients) {
        clients.delete(id);
        void client.close().catch(() => {});
      }
    },
    ids() {
      return [...clients.keys()];
    },
  };
}

async function createDefaultClient(opts: ConnectOpts): Promise<WeftClient> {
  if ('raw' in opts) {
    const { client } = await pairSession(opts.raw, weftClientOptions(opts));
    return client;
  }
  if ('pairing' in opts) {
    return connectSession(opts.pairing, weftClientOptions(opts));
  }
  return createClientFromMaterial(opts);
}

function weftClientOptions(opts: { transport?: Transport }): { transport?: Transport } | undefined {
  return opts.transport === undefined ? undefined : { transport: opts.transport };
}

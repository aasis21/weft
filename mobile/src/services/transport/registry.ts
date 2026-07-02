import {
  connectSession,
  createClientFromMaterial,
  pairSession,
  type HelmClient,
} from '@/lib/helmClient';
import type { StoredPairing } from '@/lib/storage';
import type { Transport } from '@aasis21/helm-shared';

export type ConnectOpts =
  | { raw: string; transport?: Transport }
  | { pairing: StoredPairing; transport?: Transport }
  | { channelId: string; key: CryptoKey; deviceId?: string; transport?: Transport };

export interface TransportRegistry {
  connect(id: string, opts: ConnectOpts): Promise<HelmClient>;
  get(id: string): HelmClient | undefined;
  has(id: string): boolean;
  dispose(id: string): void;
  disposeAll(): void;
  ids(): string[];
}

export function createTransportRegistry(deps?: {
  createClient?: (opts: ConnectOpts) => HelmClient | Promise<HelmClient>;
}): TransportRegistry {
  const clients = new Map<string, HelmClient>();
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

async function createDefaultClient(opts: ConnectOpts): Promise<HelmClient> {
  if ('raw' in opts) {
    const { client } = await pairSession(opts.raw, helmClientOptions(opts));
    return client;
  }
  if ('pairing' in opts) {
    return connectSession(opts.pairing, helmClientOptions(opts));
  }
  return createClientFromMaterial(opts);
}

function helmClientOptions(opts: { transport?: Transport }): { transport?: Transport } | undefined {
  return opts.transport === undefined ? undefined : { transport: opts.transport };
}

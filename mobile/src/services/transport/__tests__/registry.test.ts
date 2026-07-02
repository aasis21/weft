import { describe, expect, it, vi } from 'vitest';
import type { EventEnvelope, EventType, SecureChannel } from '@aasis21/helm-shared';
import { createTransportRegistry, type ConnectOpts } from '@/services/transport/registry';
import type { HelmClient } from '@/lib/helmClient';

function makeClient(channelId: string): HelmClient {
  return {
    channelId,
    channel: {} as SecureChannel,
    send: vi.fn<(message: EventEnvelope) => Promise<void>>().mockResolvedValue(undefined),
    subscribe: vi.fn<(handler: (message: EventEnvelope, event: EventType) => void) => () => void>().mockReturnValue(vi.fn()),
    onStatus: vi.fn<(handler: (status: 'connected' | 'disconnected') => void) => () => void>().mockReturnValue(vi.fn()),
    close: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  };
}

describe('createTransportRegistry', () => {
  it('connect stores and returns a client', async () => {
    const client = makeClient('channel-1');
    const createClient = vi.fn<(opts: ConnectOpts) => HelmClient | Promise<HelmClient>>().mockReturnValue(client);
    const registry = createTransportRegistry({ createClient });
    const opts: ConnectOpts = { raw: 'pairing-payload' };

    await expect(registry.connect('stable-session-1', opts)).resolves.toBe(client);

    expect(createClient).toHaveBeenCalledWith(opts);
    expect(registry.get('stable-session-1')).toBe(client);
    expect(registry.has('stable-session-1')).toBe(true);
    expect(registry.ids()).toEqual(['stable-session-1']);
  });

  it('dispose closes and removes a client', async () => {
    const client = makeClient('channel-1');
    const registry = createTransportRegistry({ createClient: () => client });
    await registry.connect('stable-session-1', { raw: 'pairing-payload' });

    registry.dispose('stable-session-1');

    expect(client.close).toHaveBeenCalledTimes(1);
    expect(registry.get('stable-session-1')).toBeUndefined();
    expect(registry.has('stable-session-1')).toBe(false);
    expect(registry.ids()).toEqual([]);
  });

  it('disposeAll closes every client and clears the registry', async () => {
    const first = makeClient('channel-1');
    const second = makeClient('channel-2');
    const clients = [first, second];
    const registry = createTransportRegistry({ createClient: () => clients.shift() as HelmClient });
    await registry.connect('stable-session-1', { raw: 'first-payload' });
    await registry.connect('stable-session-2', { raw: 'second-payload' });

    registry.disposeAll();

    expect(first.close).toHaveBeenCalledTimes(1);
    expect(second.close).toHaveBeenCalledTimes(1);
    expect(registry.ids()).toEqual([]);
    expect(registry.has('stable-session-1')).toBe(false);
    expect(registry.has('stable-session-2')).toBe(false);
  });
});

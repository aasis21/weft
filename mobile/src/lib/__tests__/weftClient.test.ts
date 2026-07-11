import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../weftClient');
vi.unmock('@/lib/weftClient');

const shared = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  connect: vi.fn<() => Promise<void>>(),
}));

vi.mock('@aasis21/weft-shared', () => ({
  EVENT_TYPE: {
    STREAM: 'stream',
    PROMPT: 'prompt',
    APPROVAL: 'approval',
    DECISION: 'decision',
    ELICITATION: 'elicitation',
    CONTROL: 'control',
  },
  SecureChannel: vi.fn().mockImplementation(() => ({
    connect: shared.connect,
    close: vi.fn(),
    send: vi.fn(),
    onEvent: vi.fn(() => vi.fn()),
    onStatus: vi.fn(() => vi.fn()),
  })),
  createLocalTransport: vi.fn(() => ({ close: shared.close })),
  createSupabaseTransport: vi.fn(),
  createRelayTransport: vi.fn(),
  generateKeyPair: vi.fn(() =>
    Promise.resolve({
      privateKey: {} as CryptoKey,
      publicKeyB64: 'phone-public-key',
    }),
  ),
  isValidEnvelope: vi.fn(() => true),
  parsePairingPayload: vi.fn(() => ({
    channelId: 'channel-1',
    publicKeyB64: 'laptop-public-key',
    transport: { kind: 'local' },
  })),
  sayHello: vi.fn(() => Promise.resolve({ key: {} as CryptoKey })),
}));

describe('pairSession', () => {
  beforeEach(() => {
    shared.close.mockResolvedValue(undefined);
    shared.connect.mockRejectedValue(new Error('connect failed'));
    vi.spyOn(crypto.subtle, 'exportKey').mockResolvedValue({} as JsonWebKey);
  });

  it('closes the transport when client construction fails', async () => {
    const { pairSession } = await import('../weftClient');
    const transport = {
      connect: vi.fn(),
      publish: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      close: shared.close,
    };

    await expect(pairSession('{"v":1}', { transport })).rejects.toThrow('connect failed');

    expect(shared.close).toHaveBeenCalledTimes(1);
  });
});

describe('connectDevice', () => {
  beforeEach(async () => {
    shared.close.mockResolvedValue(undefined);
    shared.connect.mockResolvedValue(undefined);
    vi.spyOn(crypto.subtle, 'importKey').mockResolvedValue({} as CryptoKey);
    const { SecureChannel } = await import('@aasis21/weft-shared');
    vi.mocked(SecureChannel).mockImplementation(
      () =>
        ({
          connect: shared.connect,
          close: vi.fn(),
          send: vi.fn(),
          onEvent: vi.fn(() => vi.fn()),
          onStatus: vi.fn(() => vi.fn()),
        }) as never,
    );
  });

  it('reuses the stored keypair instead of minting a new one, and does not wait for an ack', async () => {
    const { connectDevice } = await import('../weftClient');
    const { sayHello, generateKeyPair } = await import('@aasis21/weft-shared');
    const transport = {
      connect: vi.fn(),
      publish: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      close: shared.close,
    };

    await connectDevice(
      {
        channelId: 'channel-1',
        peerPublicKeyB64: 'laptop-public-key',
        publicKeyB64: 'my-stored-phone-key',
        privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' } as JsonWebKey,
        deviceId: 'device-1',
        transport: { kind: 'local' },
      },
      { transport },
    );

    // The listener's boundPeerPub lock (listener.mjs) requires the SAME phone public key across
    // reconnects — a fresh keypair here would make this look like "a different phone".
    expect(generateKeyPair).not.toHaveBeenCalled();
    expect(sayHello).toHaveBeenCalledWith(
      expect.objectContaining({
        keyPair: expect.objectContaining({ publicKeyB64: 'my-stored-phone-key' }),
        peerPublicKeyB64: 'laptop-public-key',
        waitForAck: false,
      }),
    );
  });
});

describe('pairWithPublicKey with a devtunnel transport descriptor', () => {
  beforeEach(async () => {
    shared.close.mockResolvedValue(undefined);
    // sayHello is mocked at module scope to resolve, so let it reject early via SecureChannel
    // connect instead — same "closes the transport on failure" shape as the pairSession test.
    shared.connect.mockRejectedValue(new Error('connect failed'));
    vi.spyOn(crypto.subtle, 'exportKey').mockResolvedValue({} as JsonWebKey);
    const { SecureChannel } = await import('@aasis21/weft-shared');
    vi.mocked(SecureChannel).mockImplementation(
      () =>
        ({
          connect: shared.connect,
          close: vi.fn(),
          send: vi.fn(),
          onEvent: vi.fn(() => vi.fn()),
          onStatus: vi.fn(() => vi.fn()),
        }) as never,
    );
  });

  it('builds a WebSocket from the descriptor url (channelId appended at connect time) and hands it to createRelayTransport', async () => {
    const { pairWithPublicKey } = await import('../weftClient');
    const { createRelayTransport } = await import('@aasis21/weft-shared');

    const fakeSocket = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 0,
    };
    const WebSocketMock = vi.fn(() => fakeSocket);
    vi.stubGlobal('WebSocket', WebSocketMock);

    const fakeTransport = {
      connect: vi.fn(),
      publish: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      close: shared.close,
    };
    vi.mocked(createRelayTransport).mockReturnValue(fakeTransport as never);

    // Descriptor carries only the relay's base URL now — no channelId baked in, symmetric with
    // the Supabase descriptor. weftClient's devtunnel branch appends `?channelId=` at socket
    // construction time (same helper the extension side uses in transportFactory.mjs).
    await expect(
      pairWithPublicKey({
        channelId: 'channel-relay',
        publicKeyB64: 'laptop-public-key',
        transportDescriptor: { kind: 'devtunnel', url: 'wss://example.devtunnels.ms' },
      }),
    ).rejects.toThrow('connect failed');

    expect(WebSocketMock).toHaveBeenCalledWith('wss://example.devtunnels.ms?channelId=channel-relay');
    expect(createRelayTransport).toHaveBeenCalledWith({
      socket: fakeSocket,
      channelId: 'channel-relay',
    });
    // Failed handshake must still close the transport it opened (same as the local-transport case).
    expect(shared.close).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('preserves any pre-existing query string on the descriptor URL when appending channelId', async () => {
    const { pairWithPublicKey } = await import('../weftClient');
    const { createRelayTransport } = await import('@aasis21/weft-shared');

    const fakeSocket = {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      send: vi.fn(),
      close: vi.fn(),
      readyState: 0,
    };
    const WebSocketMock = vi.fn(() => fakeSocket);
    vi.stubGlobal('WebSocket', WebSocketMock);

    vi.mocked(createRelayTransport).mockReturnValue({
      connect: vi.fn(),
      publish: vi.fn(),
      subscribe: vi.fn(() => vi.fn()),
      close: shared.close,
    } as never);

    await expect(
      pairWithPublicKey({
        channelId: 'chan-2',
        publicKeyB64: 'laptop-public-key',
        transportDescriptor: { kind: 'devtunnel', url: 'wss://example.devtunnels.ms/?token=abc' },
      }),
    ).rejects.toThrow('connect failed');

    // `&channelId=…` (not `?channelId=…`) since the URL already has a `?token=` — guards against
    // the naive concat breaking any future relay that ships a token or path param alongside.
    expect(WebSocketMock).toHaveBeenCalledWith('wss://example.devtunnels.ms/?token=abc&channelId=chan-2');

    vi.unstubAllGlobals();
  });
});

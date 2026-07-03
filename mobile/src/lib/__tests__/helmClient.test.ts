import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../helmClient');
vi.unmock('@/lib/helmClient');

const shared = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  connect: vi.fn<() => Promise<void>>(),
}));

vi.mock('@aasis21/helm-shared', () => ({
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
  generateKeyPair: vi.fn(() =>
    Promise.resolve({
      privateKey: {} as CryptoKey,
      publicKeyB64: 'phone-public-key',
    }),
  ),
  isValidEnvelope: vi.fn(() => true),
  parsePairingPayload: vi.fn(() => ({ channelId: 'channel-1', publicKeyB64: 'laptop-public-key' })),
  sayHello: vi.fn(() => Promise.resolve({ key: {} as CryptoKey })),
}));

describe('pairSession', () => {
  beforeEach(() => {
    shared.close.mockResolvedValue(undefined);
    shared.connect.mockRejectedValue(new Error('connect failed'));
    vi.spyOn(crypto.subtle, 'exportKey').mockResolvedValue({} as JsonWebKey);
  });

  it('closes the transport when client construction fails', async () => {
    const { pairSession } = await import('../helmClient');
    const transport = { close: shared.close };

    await expect(pairSession('{"v":1}', { transport })).rejects.toThrow('connect failed');

    expect(shared.close).toHaveBeenCalledTimes(1);
  });
});

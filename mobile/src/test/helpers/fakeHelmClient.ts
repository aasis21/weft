// FakeHelmClient — the in-memory transport that stands in for the real Supabase/WebCrypto client.
//
// SessionManager only ever touches the transport through `pairSession` / `connectSession` from
// `./helmClient`, and only uses this small surface: `channelId`, `send`, `subscribe`, `onStatus`,
// `close`. So a fake that records outbound `send`s and lets a test push inbound messages in bypasses
// ALL crypto and networking while exercising the real manager end-to-end.
//
// setup.ts installs `helmClientMock` as the module mock; `registry` is shared with makeManager so a
// test can grab the client the manager just created and `emit()` messages into it.
import type { EventEnvelope, SecureChannel } from '@aasis21/helm-shared';
import type { StoredPairing } from '@/lib/storage';

type MessageHandler = (message: EventEnvelope, event: string) => void;
type StatusHandler = (status: 'connected' | 'disconnected') => void;

export class FakeHelmClient {
  readonly channelId: string;
  /** Not used by SessionManager; a typed stub so the shape satisfies HelmClient. */
  readonly channel: SecureChannel = {} as SecureChannel;
  /** Every EventEnvelope the manager pushed outbound, in order. */
  readonly sent: EventEnvelope[] = [];
  closed = false;
  status: 'connected' | 'disconnected' = 'connected';

  private messageHandlers = new Set<MessageHandler>();
  private statusHandlers = new Set<StatusHandler>();

  constructor(channelId: string) {
    this.channelId = channelId;
  }

  send = async (message: EventEnvelope): Promise<void> => {
    this.sent.push(message);
  };

  subscribe = (handler: MessageHandler): (() => void) => {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  };

  onStatus = (handler: StatusHandler): (() => void) => {
    this.statusHandlers.add(handler);
    return () => this.statusHandlers.delete(handler);
  };

  close = async (): Promise<void> => {
    this.closed = true;
    this.messageHandlers.clear();
    this.statusHandlers.clear();
  };

  // --- test-facing controls ----------------------------------------------------------------------

  /** Deliver an inbound message to the manager exactly as the relay would. */
  emit(message: EventEnvelope, event?: string): void {
    const ev = event ?? message.eventType;
    for (const handler of [...this.messageHandlers]) handler(message, ev);
  }

  /** Flip the live socket state (drop / rejoin). */
  setStatus(status: 'connected' | 'disconnected'): void {
    this.status = status;
    for (const handler of [...this.statusHandlers]) handler(status);
  }

  /** The last outbound message, or undefined. */
  get lastSent(): EventEnvelope | undefined {
    return this.sent[this.sent.length - 1];
  }

  /**
   * The flat `msg` payloads of every outbound envelope whose composite `${eventType}.${eventSubtype}`
   * matches `kind` (e.g. `'prompt.prompt'`, `'decision.approval_decision'`, `'control.state_request'`).
   * Returns payloads (not envelopes) so assertions stay on the flat message body.
   */
  sentOfKind(kind: string): Record<string, unknown>[] {
    return this.sent
      .filter((m) => `${m.eventType}.${m.eventSubtype}` === kind)
      .map((m) => m.msg as Record<string, unknown>);
  }

  /** Reset the recorded outbound log (e.g. before asserting a reconnect's fresh sends). */
  clearSent(): void {
    this.sent.length = 0;
  }
}

// --- registry: newest client per channelId, shared between the module mock and the harness --------
class FakeClientRegistry {
  private byChannel = new Map<string, FakeHelmClient>();
  private all: FakeHelmClient[] = [];

  create(channelId: string): FakeHelmClient {
    const client = new FakeHelmClient(channelId);
    this.byChannel.set(channelId, client);
    this.all.push(client);
    return client;
  }

  /** The most recently created client for a channel (what a fresh pair/connect handed the manager). */
  get(channelId: string): FakeHelmClient | undefined {
    return this.byChannel.get(channelId);
  }

  /** Every client ever created this test (a rescan/reconnect makes more than one per channel). */
  forChannel(channelId: string): FakeHelmClient[] {
    return this.all.filter((c) => c.channelId === channelId);
  }

  reset(): void {
    this.byChannel.clear();
    this.all = [];
  }
}

export const registry = new FakeClientRegistry();

/** Build a synthetic StoredPairing for a channel (no real ECDH; the fake needs none). */
export function fakePairing(channelId: string): StoredPairing {
  return {
    channelId,
    peerPublicKeyB64: `peer-${channelId}`,
    publicKeyB64: `pub-${channelId}`,
    privateKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y', d: 'd' } as JsonWebKey,
    deviceId: `dev-${channelId}`,
    savedAt: Date.now(),
  };
}

/** The QR string is treated verbatim as the channelId in tests (real code parses a payload). */
function channelIdFromRaw(raw: string): string {
  try {
    const parsed = JSON.parse(raw) as { channelId?: string };
    if (parsed?.channelId) return parsed.channelId;
  } catch {
    /* not JSON — use as-is */
  }
  return raw;
}

// --- the module mock installed for `@/lib/helmClient` in setup.ts ---------------------------------
export const helmClientMock = {
  async pairSession(raw: string): Promise<{ client: FakeHelmClient; pairing: StoredPairing }> {
    const channelId = channelIdFromRaw(raw);
    const client = registry.create(channelId);
    return { client, pairing: fakePairing(channelId) };
  },
  async connectSession(pairing: StoredPairing): Promise<FakeHelmClient> {
    return registry.create(pairing.channelId);
  },
  async createClientFromMaterial(opts: { channelId: string }): Promise<FakeHelmClient> {
    return registry.create(opts.channelId);
  },
  getSenderName(): string {
    return 'WebApp';
  },
};

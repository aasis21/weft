import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPairingPayload, encodePairingLink } from '@aasis21/weft-shared';
import App from '@/app/App';

const runtime = vi.hoisted(() => ({
  addByQr: vi.fn(async (_raw: string) => 'channel-1'),
  snapshot: { ready: true, activeId: null, sessions: [], devices: [] },
}));

vi.mock('@/session/runtime/instance', () => ({
  sessionAccess: { init: () => Promise.resolve() },
  sessionRuntime: {
    setChatVisible: vi.fn(),
    subscribe: () => () => {},
    getSnapshot: () => runtime.snapshot,
    init: () => Promise.resolve(),
    addByQr: runtime.addByQr,
  },
}));

vi.mock('@/ui/hooks/usePairing', () => ({ isNativeRuntime: () => false }));

vi.mock('@/ui/screens/LandingScreen', () => ({
  LandingScreen: () => <main data-testid="landing-screen">Landing</main>,
}));

const connect = vi.hoisted(() => ({ result: null as Promise<void> | null }));
vi.mock('@/ui/screens/ConnectScreen', () => ({
  ConnectScreen: ({ autoPairCode, onPair }: { autoPairCode?: string | null; onPair(raw: string): Promise<void> }) => (
    <main data-testid="connect">
      <span data-testid="auto-pair-code">{autoPairCode ?? ''}</span>
      <button type="button" onClick={() => { connect.result = onPair(autoPairCode ?? ''); }}>Pair link</button>
      <button type="button" onClick={() => { connect.result = onPair('not a pairing code'); connect.result.catch(() => undefined); }}>Pair garbage</button>
      <button type="button" onClick={() => { connect.result = onPair(` ${JSON.stringify(payload)} `); }}>Pair JSON</button>
    </main>
  ),
}));

const payload = buildPairingPayload({
  channelId: 'channel-1',
  publicKeyB64: 'laptop-public-key',
  transport: { kind: 'local' },
});

afterEach(() => {
  window.history.replaceState(null, '', '/');
  runtime.addByQr.mockClear();
});

beforeEach(() => {
  runtime.addByQr.mockResolvedValue('channel-1');
});

describe('App /pair route', () => {
  it('scrubs the code from the address bar and pairs the link through Connect', async () => {
    const user = userEvent.setup();
    const link = encodePairingLink(payload, window.location.origin);
    window.history.replaceState(null, '', new URL(link).pathname + new URL(link).hash);

    render(<App />);

    expect(await screen.findByTestId('auto-pair-code')).toHaveTextContent(link);
    expect(window.location.pathname).toBe('/');
    expect(window.location.hash).toBe('');
    await user.click(screen.getByRole('button', { name: 'Pair link' }));
    await connect.result;
    expect(runtime.addByQr).toHaveBeenCalledWith(JSON.stringify(payload));
  });

  it('leaves normal paths alone', async () => {
    window.history.replaceState(null, '', '/somewhere#v3.e30');
    render(<App />);
    expect(await screen.findByTestId('landing-screen')).toBeInTheDocument();
    expect(window.location.pathname).toBe('/somewhere');
    expect(screen.queryByTestId('connect')).not.toBeInTheDocument();
  });

  it('accepts pasted raw JSON and rejects input that is not a pairing code', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', `/pair${new URL(encodePairingLink(payload)).hash}`);
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Pair garbage' }));
    await expect(connect.result).rejects.toThrow(/invalid pairing payload/);
    expect(runtime.addByQr).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Pair JSON' }));
    await connect.result;
    expect(runtime.addByQr).toHaveBeenCalledWith(JSON.stringify(payload));
    await waitFor(() => expect(window.location.pathname).toBe('/'));
  });
});

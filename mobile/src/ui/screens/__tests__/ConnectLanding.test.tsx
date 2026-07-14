import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConnectScreen } from '@/ui/screens/ConnectScreen';
import { LandingScreen } from '@/ui/screens/LandingScreen';

vi.mock('@/ui/pairing/WebQrScanner', () => ({
  WebQrScanner: ({ onResult }: { onResult(raw: string): void }) => (
    <button type="button" data-testid="mock-scanner" onClick={() => onResult('scanner-payload')}>
      Mock scanner
    </button>
  ),
}));

// Manual/paste pairing is desktop-only now (#weft-scan-ux). Default the mock to "desktop" so
// existing tests exercising that path don't need to change; one test below flips it to "touch"
// to lock in that the option disappears there.
const platformState = vi.hoisted(() => ({ desktop: true }));
vi.mock('@/lib/platform', () => ({ isDesktopInput: () => platformState.desktop }));

describe('LandingScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformState.desktop = true;
  });

  it('renders pairing CTAs and fires their callbacks', async () => {
    const user = userEvent.setup();
    const onBeginPair = vi.fn();
    const onStartDemo = vi.fn().mockResolvedValue(undefined);
    render(<LandingScreen onBeginPair={onBeginPair} onStartDemo={onStartDemo} error={null} onError={vi.fn()} />);

    expect(screen.getAllByRole('button', { name: 'Scan QR to pair' })).toHaveLength(2);
    await user.click(screen.getAllByRole('button', { name: 'Scan QR to pair' })[0]);
    expect(onBeginPair).toHaveBeenCalledWith(false);

    await user.click(screen.getByRole('button', { name: 'Paste a code' }));
    expect(onBeginPair).toHaveBeenCalledWith(true);

    await user.click(screen.getByRole('button', { name: 'Try the demo' }));
    expect(onStartDemo).toHaveBeenCalledTimes(1);
  });

  it('renders session-return CTAs when sessions already exist', async () => {
    const user = userEvent.setup();
    const onOpenSessions = vi.fn();
    render(
      <LandingScreen
        hasSessions
        onOpenSessions={onOpenSessions}
        onBeginPair={vi.fn()}
        onStartDemo={vi.fn().mockResolvedValue(undefined)}
        error="Pairing failed"
        onError={vi.fn()}
      />,
    );

    expect(screen.getByText('Pairing failed')).toHaveClass('error-banner');
    await user.click(screen.getByRole('button', { name: '← Back to your sessions' }));
    await user.click(screen.getAllByRole('button', { name: 'Open your sessions' })[0]);
    expect(onOpenSessions).toHaveBeenCalledTimes(2);
  });
});

describe('ConnectScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platformState.desktop = true;
  });

  it('renders scanner region and pairs scanner results', async () => {
    const user = userEvent.setup();
    const onPair = vi.fn().mockResolvedValue(undefined);
    render(
      <ConnectScreen
        hasSessions={false}
        error={null}
        onError={vi.fn()}
        onPair={onPair}
      />,
    );

    expect(screen.getByText('Scan to connect')).toBeInTheDocument();
    await user.click(screen.getByTestId('mock-scanner'));
    expect(onPair).toHaveBeenCalledWith('scanner-payload');
  });

  it('accepts manual pairing JSON and submits it', async () => {
    const user = userEvent.setup();
    const onPair = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <ConnectScreen
        hasSessions
        initialManual
        error="Bad code"
        onError={vi.fn()}
        onPair={onPair}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    expect(screen.getByText('Bad code')).toHaveClass('error-banner');
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual pairing JSON' }), {
      target: { value: '{"v":1,"channelId":"abc"}' },
    });
    await user.click(screen.getByRole('button', { name: 'Pair from pasted code' }));
    expect(onPair).toHaveBeenCalledWith('{"v":1,"channelId":"abc"}');
    expect(screen.queryByRole('button', { name: 'Demo / Simulator' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('hides manual/paste entry entirely on touch devices, both on Landing and Join', async () => {
    platformState.desktop = false;
    const { unmount } = render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Paste a code' })).not.toBeInTheDocument();
    unmount();

    render(
      <ConnectScreen hasSessions={false} error={null} onError={vi.fn()} onPair={vi.fn().mockResolvedValue(undefined)} />,
    );
    expect(screen.queryByRole('button', { name: 'Enter code manually' })).not.toBeInTheDocument();
  });
});

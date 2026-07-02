import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { JoinSessionScreen } from '@/ui/screens/JoinSessionScreen';
import { LandingScreen } from '@/ui/screens/LandingScreen';

vi.mock('@/ui/pairing/WebQrScanner', () => ({
  WebQrScanner: ({ onResult }: { onResult(raw: string): void }) => (
    <button type="button" data-testid="mock-scanner" onClick={() => onResult('scanner-payload')}>
      Mock scanner
    </button>
  ),
}));

describe('LandingScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

describe('JoinSessionScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders scanner region and pairs scanner results', async () => {
    const user = userEvent.setup();
    const onPair = vi.fn().mockResolvedValue(undefined);
    render(
      <JoinSessionScreen
        hasSessions={false}
        error={null}
        onError={vi.fn()}
        onPair={onPair}
        onStartDemo={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    expect(screen.getByText('Point your camera at the laptop QR')).toBeInTheDocument();
    await user.click(screen.getByTestId('mock-scanner'));
    expect(onPair).toHaveBeenCalledWith('scanner-payload');
  });

  it('accepts manual pairing JSON and submits it', async () => {
    const user = userEvent.setup();
    const onPair = vi.fn().mockResolvedValue(undefined);
    const onStartDemo = vi.fn().mockResolvedValue(undefined);
    const onCancel = vi.fn();
    render(
      <JoinSessionScreen
        hasSessions
        initialManual
        error="Bad code"
        onError={vi.fn()}
        onPair={onPair}
        onStartDemo={onStartDemo}
        onCancel={onCancel}
      />,
    );

    expect(screen.getByRole('button', { name: '← Back to sessions' })).toBeInTheDocument();
    expect(screen.getByText('Bad code')).toHaveClass('error-banner');
    fireEvent.change(screen.getByRole('textbox', { name: 'Manual pairing JSON' }), {
      target: { value: '{"v":1,"channelId":"abc"}' },
    });
    await user.click(screen.getByRole('button', { name: 'Pair from pasted code' }));
    expect(onPair).toHaveBeenCalledWith('{"v":1,"channelId":"abc"}');

    await user.click(screen.getByRole('button', { name: 'Demo / Simulator' }));
    expect(onStartDemo).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '← Back to sessions' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});

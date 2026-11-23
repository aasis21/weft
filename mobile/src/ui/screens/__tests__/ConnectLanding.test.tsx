import { Capacitor } from '@capacitor/core';
import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

const androidScanner = vi.hoisted(() => ({
  isSupported: vi.fn(),
  isGoogleBarcodeScannerModuleAvailable: vi.fn(),
  scan: vi.fn(),
}));
vi.mock('@capacitor-mlkit/barcode-scanning', () => ({ BarcodeScanner: androidScanner }));

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
    expect(screen.getByRole('heading', { name: 'Open Weft on your laptop' })).toBeVisible();
    expect(screen.getByText(/Run weft to open Control Center/)).toBeVisible();
    expect(screen.getAllByRole('link', { name: 'Set up your laptop' })[0]).toHaveAttribute('href', '#get-started');
    expect(screen.getAllByRole('button', { name: 'Scan QR to pair' })[0]).toHaveClass('secondary-action');
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
    expect(screen.queryByRole('link', { name: 'Set up your laptop' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '← Back to your sessions' }));
    await user.click(screen.getAllByRole('button', { name: 'Open your sessions' })[0]);
    expect(onOpenSessions).toHaveBeenCalledTimes(2);
  });
});

describe('LandingScreen phone download', () => {
  afterEach(() => vi.restoreAllMocks());

  it('leads with the direct APK download in an Android browser', () => {
    platformState.desktop = false;
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15) Mobile');
    render(<LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />);
    const links = screen.getAllByRole('link', { name: 'Get the Android app' });
    expect(links[0]).toHaveAttribute('href', 'https://github.com/aasis21/weft/releases/latest/download/weft-android.apk');
    expect(links[0]).toHaveClass('primary-action');
    expect(screen.getAllByRole('button', { name: 'Scan QR to pair' })[0]).toHaveClass('secondary-action');
    expect(screen.getByRole('heading', { name: 'Get Weft on your phone.' })).toBeInTheDocument();
  });

  it('offers only the browser option on iPhone, and nothing inside the Android app', () => {
    platformState.desktop = false;
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0) Mobile');
    const { unmount } = render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );
    expect(screen.queryByRole('link', { name: 'Get the Android app' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Any phone browser' })).toBeInTheDocument();
    unmount();

    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    render(<LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />);
    expect(screen.queryByRole('heading', { name: 'Get Weft on your phone.' })).not.toBeInTheDocument();
  });
});

describe('ConnectScreen', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    platformState.desktop = false;
  });

  it('never opens the camera until the user taps Scan laptop QR', async () => {
    const user = userEvent.setup();
    const onPair = vi.fn().mockResolvedValue(undefined);
    render(<ConnectScreen hasSessions={false} error={null} onError={vi.fn()} onPair={onPair} />);

    expect(screen.getByRole('heading', { name: 'Connect to your laptop' })).toBeInTheDocument();
    expect(screen.queryByTestId('mock-scanner')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Scan laptop QR' }));
    await user.click(screen.getByTestId('mock-scanner'));
    expect(onPair).toHaveBeenCalledWith('scanner-payload');
  });

  it('does not launch the Android scanner on mount, and falls back to the in-app camera when tapped', async () => {
    vi.spyOn(Capacitor, 'getPlatform').mockReturnValue('android');
    vi.spyOn(Capacitor, 'isNativePlatform').mockReturnValue(true);
    androidScanner.isSupported.mockResolvedValue({ supported: true });
    androidScanner.isGoogleBarcodeScannerModuleAvailable.mockResolvedValue({ available: false });
    const onPair = vi.fn().mockResolvedValue(undefined);
    render(<ConnectScreen firstRun hasSessions={false} error={null} onError={vi.fn()} onPair={onPair} />);

    await Promise.resolve();
    expect(androidScanner.isSupported).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Scan laptop QR' }));
    await userEvent.click(await screen.findByTestId('mock-scanner'));
    expect(androidScanner.scan).not.toHaveBeenCalled();
    expect(onPair).toHaveBeenCalledWith('scanner-payload');
  });

  it('pairs a pasted code on touch devices and can switch back to scanning', async () => {
    const user = userEvent.setup();
    const onPair = vi.fn().mockResolvedValue(undefined);
    render(<ConnectScreen hasSessions={false} error={null} onError={vi.fn()} onPair={onPair} />);

    await user.click(screen.getByRole('button', { name: 'Paste code' }));
    expect(screen.getByRole('button', { name: 'Pair' })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Pairing code' }), {
      target: { value: ' {"v":2,"channelId":"test"} ' },
    });
    await user.click(screen.getByRole('button', { name: 'Pair' }));
    expect(onPair).toHaveBeenCalledWith('{"v":2,"channelId":"test"}');

    await user.click(screen.getByRole('button', { name: 'Scan QR instead' }));
    expect(screen.getByRole('button', { name: 'Scan laptop QR' })).toBeInTheDocument();
  });

  it('pairs an opened pairing link immediately with the progress UI', async () => {
    let finish!: () => void;
    const onPair = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const onAutoPairStarted = vi.fn();
    const link = 'https://useweft.netlify.app/pair#v3.e30';
    render(
      <ConnectScreen
        hasSessions={false}
        error={null}
        onError={vi.fn()}
        onPair={onPair}
        autoPairCode={link}
        onAutoPairStarted={onAutoPairStarted}
      />,
    );

    expect(await screen.findByRole('status', { name: 'Pairing progress' })).toHaveTextContent('Connecting to your laptop…');
    expect(onPair).toHaveBeenCalledTimes(1);
    expect(onPair).toHaveBeenCalledWith(link);
    expect(onAutoPairStarted).toHaveBeenCalledTimes(1);
    await act(async () => finish());
  });

  it('shows pairing progress, then Try again re-opens the method that failed', async () => {
    const user = userEvent.setup();
    let fail!: (error: Error) => void;
    const onPair = vi.fn()
      .mockReturnValueOnce(new Promise<void>((_, reject) => { fail = reject; }))
      .mockResolvedValueOnce(undefined);
    const onError = vi.fn();
    const { rerender } = render(<ConnectScreen hasSessions={false} error={null} onError={onError} onPair={onPair} />);

    await user.click(screen.getByRole('button', { name: 'Scan laptop QR' }));
    await user.click(screen.getByTestId('mock-scanner'));
    expect(screen.getByRole('status', { name: 'Pairing progress' })).toHaveTextContent('Connecting to your laptop…');
    expect(screen.queryByTestId('mock-scanner')).not.toBeInTheDocument();

    await act(async () => fail(new Error('Laptop unreachable')));
    expect(onError).toHaveBeenLastCalledWith('Laptop unreachable');
    rerender(<ConnectScreen hasSessions={false} error="Laptop unreachable" onError={onError} onPair={onPair} />);
    expect(screen.queryByTestId('mock-scanner')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    await user.click(screen.getByTestId('mock-scanner'));
    expect(onPair).toHaveBeenCalledTimes(2);
  });

  it('opens the paste box directly and keeps Close for the in-app variant', async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    render(
      <ConnectScreen hasSessions initialManual error="Bad code" onError={vi.fn()} onPair={vi.fn()} onCancel={onCancel} />,
    );

    expect(screen.getByRole('textbox', { name: 'Pairing code' })).toBeInTheDocument();
    expect(screen.getByText('Bad code')).toHaveClass('error-banner');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('welcomes first-time users with Station first, and Got it collapses the guide', async () => {
    const user = userEvent.setup();
    const onIntroDone = vi.fn();
    render(
      <ConnectScreen firstRun showIntro onIntroDone={onIntroDone} hasSessions={false} error={null} onError={vi.fn()} onPair={vi.fn()} />,
    );

    expect(screen.getByRole('heading', { name: 'Your Copilot session, off the desk.' })).toBeInTheDocument();
    const ways = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(ways).toEqual(['Weft Station', 'Just this chat']);
    expect(screen.getByRole('button', { name: 'Scan laptop QR' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Got it' }));
    expect(onIntroDone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('heading', { name: 'Connect to your laptop' })).toBeInTheDocument();
    expect(screen.getByText('Need a pairing code?')).toBeInTheDocument();
  });

  it('leads with /weft when opened from a live chat', () => {
    render(<ConnectScreen hasSessions fromChat showIntro error={null} onError={vi.fn()} onPair={vi.fn()} />);
    const ways = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(ways).toEqual(['Just this chat', 'Weft Station']);
  });

  it('copies the setup link when the share sheet is unavailable', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<ConnectScreen hasSessions={false} error={null} onError={vi.fn()} onPair={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Send setup link' }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('https://aasis21.github.io/weft/#install-laptop'));
    expect(screen.getByText('Setup link copied. Send it to your laptop.')).toBeInTheDocument();
  });

  it('keeps the desktop-only paste shortcut off the touch landing page', () => {
    render(
      <LandingScreen onBeginPair={vi.fn()} onStartDemo={vi.fn().mockResolvedValue(undefined)} error={null} onError={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Paste a code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Set up your laptop' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Scan QR to pair' })[0]).toHaveClass('primary-action');
  });
});
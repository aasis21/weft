import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import jsQR from 'jsqr';
import { WebQrScanner } from '../WebQrScanner';

vi.mock('jsqr', () => ({
  default: vi.fn(() => ({ data: 'js-raw' })),
}));

describe('WebQrScanner', () => {
  let stopTrack: ReturnType<typeof vi.fn>;
  let getUserMedia: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    stopTrack = vi.fn();
    getUserMedia = vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: stopTrack }],
    });
    Object.defineProperty(navigator, 'mediaDevices', {
      value: { getUserMedia },
      configurable: true,
    });
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) =>
      window.setTimeout(() => callback(performance.now()), 0),
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((handle) => clearTimeout(handle));
  });

  afterEach(() => {
    delete (globalThis as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
  });

  it('stops the camera stream immediately after a successful decode', async () => {
    const detect = vi.fn().mockResolvedValue([{ rawValue: 'pairing-raw' }]);
    const BarcodeDetector = vi.fn().mockImplementation(() => ({ detect }));
    BarcodeDetector.getSupportedFormats = vi.fn().mockResolvedValue(['qr_code']);
    (globalThis as unknown as { BarcodeDetector: unknown }).BarcodeDetector = BarcodeDetector;
    const onResult = vi.fn();

    render(<WebQrScanner variant="inline" onResult={onResult} onCancel={() => undefined} />);

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('pairing-raw'));
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });

  it('falls back to jsQR when BarcodeDetector does not report QR support', async () => {
    const BarcodeDetector = vi.fn();
    BarcodeDetector.getSupportedFormats = vi.fn().mockResolvedValue([]);
    (globalThis as unknown as { BarcodeDetector: unknown }).BarcodeDetector = BarcodeDetector;
    vi.spyOn(HTMLVideoElement.prototype, 'videoWidth', 'get').mockReturnValue(2);
    vi.spyOn(HTMLVideoElement.prototype, 'videoHeight', 'get').mockReturnValue(2);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(16) })),
    } as unknown as CanvasRenderingContext2D);
    const onResult = vi.fn();

    render(<WebQrScanner variant="inline" onResult={onResult} onCancel={() => undefined} />);

    await waitFor(() => expect(onResult).toHaveBeenCalledWith('js-raw'));
    expect(BarcodeDetector).not.toHaveBeenCalled();
    expect(jsQR).toHaveBeenCalled();
  });

  it('offers retry and paste actions after a fatal inline camera error', async () => {
    getUserMedia.mockRejectedValue(new Error('blocked'));
    const onPasteCode = vi.fn();

    render(
      <WebQrScanner
        variant="inline"
        onResult={() => undefined}
        onCancel={() => undefined}
        onPasteCode={onPasteCode}
      />,
    );

    expect(await screen.findByText('Camera blocked. Allow camera access, or use the paste box instead.')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Paste code instead' }));
    expect(onPasteCode).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Retry camera' }));
    await waitFor(() => expect(getUserMedia).toHaveBeenCalledTimes(2));
  });
});

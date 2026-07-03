import { useCallback, useEffect, useRef, useState } from 'react';

interface WebQrScannerProps {
  onResult(raw: string): void;
  onCancel(): void;
  onPasteCode?: () => void;
  /** `overlay` (default) is a full-screen modal; `inline` embeds the live scanner in a page. */
  variant?: 'overlay' | 'inline';
}

type DetectFrame = (
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
) => Promise<string | null>;

interface BarcodeDetectorLike {
  detect(source: CanvasImageSource): Promise<Array<{ rawValue?: string }>>;
}
interface BarcodeDetectorCtor {
  new (opts?: { formats?: string[] }): BarcodeDetectorLike;
  getSupportedFormats?(): Promise<string[]>;
}

/**
 * Build a per-frame QR detector. Prefers the native `BarcodeDetector` (Chromium / Android
 * Chrome — fast, GPU-backed) and lazily falls back to jsQR everywhere else (iOS Safari,
 * Firefox) so the browser scanner has the widest possible reach.
 */
async function makeDetector(): Promise<DetectFrame> {
  const Ctor = (globalThis as unknown as { BarcodeDetector?: BarcodeDetectorCtor })
    .BarcodeDetector;
  if (Ctor) {
    try {
      const formats = (await Ctor.getSupportedFormats?.()) ?? [];
      if (formats.includes('qr_code')) {
        const detector = new Ctor({ formats: ['qr_code'] });
        return async (video) => {
          const codes = await detector.detect(video);
          return codes[0]?.rawValue ?? null;
        };
      }
    } catch {
      /* fall through to jsQR */
    }
  }
  const { default: jsQR } = await import('jsqr');
  return async (video, canvas) => {
    const w = video.videoWidth;
    const h = video.videoHeight;
    if (!w || !h) return null;
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    return jsQR(data, w, h, { inversionAttempts: 'dontInvert' })?.data ?? null;
  };
}

/**
 * Full-screen camera overlay that scans the laptop pairing QR directly in the browser.
 * Decodes entirely on-device — frames never leave the page. Calls `onResult` with the raw
 * payload string (same shape the native scanner and paste box produce) on the first hit.
 */
export function WebQrScanner({
  onResult,
  onCancel,
  onPasteCode,
  variant = 'overlay',
}: WebQrScannerProps): JSX.Element {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const onResultRef = useRef(onResult);
  const resultDeliveredRef = useRef(false);
  const retryPlayRef = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState('Requesting camera…');
  const [fatal, setFatal] = useState(false);
  const [needsPlayGesture, setNeedsPlayGesture] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    onResultRef.current = onResult;
  }, [onResult]);

  const retryPlay = useCallback((): void => {
    retryPlayRef.current?.();
  }, []);

  const retryCamera = useCallback((): void => {
    resultDeliveredRef.current = false;
    setFatal(false);
    setStatus('Requesting camera…');
    setNeedsPlayGesture(false);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let frame = 0;
    let stopped = false;
    let scanningStarted = false;

    const stopStream = (): void => {
      stream?.getTracks().forEach((track) => track.stop());
      stream = null;
    };

    const fail = (message: string): void => {
      stopped = true;
      stopStream();
      setStatus(message);
      setFatal(true);
      setNeedsPlayGesture(false);
    };

    void (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        fail('This browser has no camera access — use the paste box instead.');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
      } catch {
        fail('Camera blocked. Allow camera access, or use the paste box instead.');
        return;
      }
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || stopped) return;
      video.srcObject = stream;

      const startScanning = async (): Promise<void> => {
        if (scanningStarted || stopped) return;
        scanningStarted = true;
        let detect: DetectFrame;
        try {
          detect = await makeDetector();
        } catch {
          fail('Could not start the QR decoder — use the paste box instead.');
          return;
        }
        setStatus('Point at the laptop QR code');
        const tick = async (): Promise<void> => {
          if (stopped) return;
          try {
            const raw = await detect(video, canvas);
            if (raw) {
              stopped = true;
              if (!resultDeliveredRef.current) {
                resultDeliveredRef.current = true;
                onResultRef.current(raw);
              }
              stopStream();
              return;
            }
          } catch {
            /* transient frame error — keep scanning */
          }
          frame = requestAnimationFrame(() => void tick());
        };
        void tick();
      };

      const playAndScan = async (fromGesture: boolean): Promise<void> => {
        if (stopped) return;
        try {
          await video.play();
        } catch {
          if (!fromGesture) {
            setStatus('Tap to enable camera preview');
            setNeedsPlayGesture(true);
            return;
          }
          fail('Could not start the camera preview — use the paste box instead.');
          return;
        }
        setNeedsPlayGesture(false);
        await startScanning();
      };

      retryPlayRef.current = () => {
        void playAndScan(true);
      };
      await playAndScan(false);
    })();

    return () => {
      stopped = true;
      retryPlayRef.current = null;
      cancelAnimationFrame(frame);
      stopStream();
    };
  }, [attempt]);

  return (
    <div
      className={variant === 'inline' ? 'scanner-inline' : 'scanner-overlay'}
      role={variant === 'overlay' ? 'dialog' : 'group'}
      aria-modal={variant === 'overlay' ? true : undefined}
      aria-label="Scan pairing QR"
    >
      <video ref={videoRef} className="scanner-video" muted playsInline />
      <canvas ref={canvasRef} hidden />
      <div className="scanner-reticle" aria-hidden="true">
        <span className="scanner-line" />
      </div>
      <p className={`scanner-status${fatal ? ' is-error' : ''}`}>{status}</p>
      {needsPlayGesture ? (
        <button className="secondary-action scanner-enable" type="button" onClick={retryPlay}>
          Tap to enable camera
        </button>
      ) : null}
      {fatal && variant === 'inline' ? (
        <div className="scanner-actions">
          <button
            className="secondary-action"
            type="button"
            aria-label="Retry camera"
            onClick={retryCamera}
          >
            Retry camera
          </button>
          {onPasteCode ? (
            <button
              className="link-btn"
              type="button"
              aria-label="Paste code instead"
              onClick={onPasteCode}
            >
              Paste code instead
            </button>
          ) : null}
        </div>
      ) : null}
      {variant === 'overlay' ? (
        <button className="secondary-action scanner-cancel" type="button" onClick={onCancel}>
          {fatal ? 'Back' : 'Cancel'}
        </button>
      ) : null}
    </div>
  );
}

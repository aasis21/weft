import type { PromptAttachment } from '@aasis21/weft-shared';

/**
 * Turn a user-picked image File into a relay-ready {@link PromptAttachment}: downscaled,
 * re-encoded as JPEG, and base64-encoded (no `data:` URL prefix). Downscaling keeps the
 * encrypted relay payload well under the transport's ~1MB per-message cap; the Copilot
 * SDK resizes again on its side for the model.
 */
export interface DownscaleOptions {
  /** Longest-edge ceiling in CSS pixels. Default 1024. */
  maxDim?: number;
  /** Initial JPEG quality (0–1). Default 0.7. */
  quality?: number;
  /** Base64 length budget per image; quality is stepped down until it fits. Default 500 KB. */
  maxBytes?: number;
}

const DEFAULTS: Required<DownscaleOptions> = {
  maxDim: 1024,
  quality: 0.7,
  maxBytes: 500 * 1024,
};

/** Accepted picker MIME types. HEIC/HEIF are excluded — browsers can't decode them to canvas. */
export const ACCEPTED_IMAGE_TYPES = 'image/png,image/jpeg,image/webp,image/gif,image/bmp';

function isImage(file: File): boolean {
  return typeof file.type === 'string' && file.type.startsWith('image/');
}

function fitWithin(w: number, h: number, max: number): { width: number; height: number } {
  if (w <= max && h <= max) return { width: w, height: h };
  const scale = Math.min(max / w, max / h);
  return {
    width: Math.max(1, Math.round(w * scale)),
    height: Math.max(1, Math.round(h * scale)),
  };
}

function sanitizeName(name: string): string {
  const base = (name || 'image').replace(/[\\/]+/g, ' ').trim();
  const clipped = base.length > 80 ? base.slice(0, 80) : base;
  return clipped || 'image';
}

async function loadImage(file: File): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' } as ImageBitmapOptions);
    } catch {
      // Fall back to <img> below (older WebViews / unsupported options).
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Could not decode image.'));
    };
    img.src = url;
  });
}

/** Convert a picked image file into a downscaled base64 JPEG attachment. */
export async function fileToAttachment(file: File, opts: DownscaleOptions = {}): Promise<PromptAttachment> {
  if (!isImage(file)) throw new Error('Only image files can be attached.');
  const { maxDim, quality, maxBytes } = { ...DEFAULTS, ...opts };

  const source = await loadImage(file);
  const srcW = 'width' in source ? source.width : 0;
  const srcH = 'height' in source ? source.height : 0;
  if (!srcW || !srcH) throw new Error('Image has no dimensions.');

  const { width, height } = fitWithin(srcW, srcH, maxDim);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D is unavailable.');
  // White matte so transparent PNGs don't flatten to black under JPEG.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) source.close();

  let q = quality;
  let dataUrl = canvas.toDataURL('image/jpeg', q);
  while (dataUrl.length > maxBytes && q > 0.3) {
    q = Math.max(0.3, q - 0.15);
    dataUrl = canvas.toDataURL('image/jpeg', q);
  }

  const comma = dataUrl.indexOf(',');
  const data = comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
  return { data, mimeType: 'image/jpeg', name: sanitizeName(file.name) };
}

/** Build an `<img src>`-ready data URL from a relay attachment. */
export function attachmentSrc(attachment: PromptAttachment): string {
  return `data:${attachment.mimeType};base64,${attachment.data}`;
}

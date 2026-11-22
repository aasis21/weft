import { useEffect, useState } from 'react';
import { isNativeRuntime } from '@/ui/hooks/usePairing';

/** Always the newest signed APK: each Release attaches a version-less copy under this name. */
export const ANDROID_APK_URL = 'https://github.com/aasis21/weft/releases/latest/download/weft-android.apk';
export const WEB_APP_URL = 'https://useweft.netlify.app';
export const RELEASES_URL = 'https://github.com/aasis21/weft/releases/latest';
const LATEST_RELEASE_API = 'https://api.github.com/repos/aasis21/weft/releases/latest';
const CACHE_KEY = 'weft.latestRelease.v1';

export type PhonePlatform = 'android' | 'ios' | 'other';

export function phonePlatform(userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent): PhonePlatform {
  if (/android/i.test(userAgent)) return 'android';
  if (/iphone|ipad|ipod/i.test(userAgent)) return 'ios';
  return 'other';
}

/** Offer the APK only in a browser, never inside the Android app itself. */
export function canOfferAndroidApp(): boolean {
  return !isNativeRuntime();
}

/** Numeric semver compare: >0 when a is newer than b. Non-numeric parts compare as 0. */
export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const pb = b.replace(/^v/, '').split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff) return diff;
  }
  return 0;
}

export interface LatestRelease {
  version: string;
  /** APK size in whole MB, when the release lists it. */
  apkMb: number | null;
}

/**
 * Latest published release (version + APK size) from GitHub's public API, cached for the browser
 * session. Returns null until loaded or when offline/rate-limited; callers just omit the detail.
 */
export function useLatestRelease(): LatestRelease | null {
  const [release, setRelease] = useState<LatestRelease | null>(() => {
    try {
      const cached = sessionStorage.getItem(CACHE_KEY);
      return cached ? (JSON.parse(cached) as LatestRelease) : null;
    } catch {
      return null;
    }
  });

  useEffect(() => {
    if (release) return undefined;
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(LATEST_RELEASE_API, { signal: controller.signal, headers: { Accept: 'application/vnd.github+json' } });
        if (!response.ok) return;
        const body = (await response.json()) as { tag_name?: string; assets?: Array<{ name?: string; size?: number }> };
        if (typeof body.tag_name !== 'string') return;
        const apk = body.assets?.find((asset) => asset.name?.endsWith('.apk'));
        const next = {
          version: body.tag_name.replace(/^v/, ''),
          apkMb: typeof apk?.size === 'number' ? Math.round(apk.size / 1_000_000) : null,
        };
        setRelease(next);
        try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(next)); } catch { /* cache is optional */ }
      } catch {
        /* offline or rate-limited: show the link without version detail */
      }
    })();
    return () => controller.abort();
  }, [release]);

  return release;
}

// Shared desktop/mobile detection helpers.
//
// Two different questions come up and must not be conflated:
//  - isDesktopInput(): does this device have a real keyboard + mouse (hover + fine
//    pointer)? Used for input-method conventions like "Enter submits" vs "Enter is a
//    newline". A native app or a touch web view answers false here.
//  - useIsWideViewport(): is the browser window wide enough to dock a persistent
//    sidebar instead of using an overlay drawer? This is about screen real estate, not
//    input device, so a wide touchscreen tablet can still be "wide" while not being
//    "desktop input".

import { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';

function isNativePlatform(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** True on a non-native (browser) session with a mouse/trackpad + hover support. */
export function isDesktopInput(): boolean {
  if (isNativePlatform()) return false;
  try {
    return globalThis.matchMedia?.('(hover: hover) and (pointer: fine)').matches ?? false;
  } catch {
    return false;
  }
}

/** Default breakpoint above which the session rail docks instead of overlaying. */
export const DESKTOP_SIDEBAR_BREAKPOINT_PX = 1024;

/** Reactive "is the viewport at least `minWidthPx` wide?" check, updated on resize. */
export function useIsWideViewport(minWidthPx: number = DESKTOP_SIDEBAR_BREAKPOINT_PX): boolean {
  const query = `(min-width: ${minWidthPx}px)`;
  const [isWide, setIsWide] = useState(() => {
    try {
      return globalThis.matchMedia?.(query).matches ?? false;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let mql: MediaQueryList | undefined;
    try {
      mql = globalThis.matchMedia?.(query);
    } catch {
      mql = undefined;
    }
    if (!mql) return undefined;
    const onChange = (): void => setIsWide(mql!.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql!.removeEventListener('change', onChange);
  }, [query]);

  return isWide;
}

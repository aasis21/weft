import type { JSX } from 'react';

/**
 * Shared laptop glyph for device avatars — same path used by `ChatThread`'s device-attribution
 * chip, so a "laptop" always looks like the same icon everywhere in the app.
 */
export function LaptopGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        d="M3 3.5A1.5 1.5 0 0 1 4.5 2h7A1.5 1.5 0 0 1 13 3.5V10H3V3.5zM2 11h12l1 2.2a.5.5 0 0 1-.46.8H1.46A.5.5 0 0 1 1 13.2L2 11z"
      />
    </svg>
  );
}

/** Round avatar wrapper around {@link LaptopGlyph}, tinted online/offline/loading via `tone`. */
export function DeviceAvatar({ tone }: { tone: 'online' | 'offline' | 'loading' }): JSX.Element {
  return (
    <span className={`device-avatar device-avatar-${tone}`} aria-hidden="true">
      <LaptopGlyph />
    </span>
  );
}

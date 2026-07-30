import type { JSX, ReactNode } from 'react';

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

function StrokeIcon({ children }: { children: ReactNode }): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

export function PlayGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <path d="M8 5.8v12.4c0 .8.9 1.2 1.5.8l9.5-6.2a1 1 0 0 0 0-1.6L9.5 5A1 1 0 0 0 8 5.8Z" />
    </svg>
  );
}

export function MoreHorizontalGlyph(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.8" />
      <circle cx="12" cy="12" r="1.8" />
      <circle cx="19" cy="12" r="1.8" />
    </svg>
  );
}

export function RefreshGlyph(): JSX.Element {
  return (
    <StrokeIcon>
      <path d="M20 12a8 8 0 0 1-13.6 5.7" />
      <path d="M4 12A8 8 0 0 1 17.6 6.3" />
      <path d="M17.5 3.5v3h-3" />
      <path d="M6.5 20.5v-3h3" />
    </StrokeIcon>
  );
}

export function TrashGlyph(): JSX.Element {
  return (
    <StrokeIcon>
      <path d="M4 7h16" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </StrokeIcon>
  );
}

export function StarGlyph(): JSX.Element {
  return (
    <StrokeIcon>
      <path d="m12 3 2.7 5.5 6.1.9-4.4 4.3 1 6.1-5.4-2.9-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3Z" />
    </StrokeIcon>
  );
}

export function PlusGlyph(): JSX.Element {
  return (
    <StrokeIcon>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </StrokeIcon>
  );
}

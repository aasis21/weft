import type { JSX } from 'react';

interface WeftMarkProps {
  /** Rendered size in px. The mark is stroke-based, so it stays crisp at any of them. */
  size?: number;
  className?: string;
}

/**
 * The Weft mark: two threads running left to right, crossing twice, one visibly passing over and
 * then under the other. That is literally what a weft is — the crosswise thread woven through the
 * warp — and unlike a woven *grid* (which collapses into a plain `#` the moment it gets small) an
 * interlace of two strands stays legible down to 16px.
 *
 * Drawn in `currentColor` so it inherits whatever it is placed on, and geometrically identical to
 * public/icon.svg so the tab, the installed app and the drawer are all the same mark.
 */
export function WeftMark({ size = 20, className }: WeftMarkProps): JSX.Element {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {/* The weft: one unbroken stroke, always on top. */}
      <path d="M2.5 8C7 8 7 16 12 16C17 16 17 8 21.5 8" />
      {/* The warp: the same curve mirrored, broken at both crossings so it reads as passing under. */}
      <path d="M2.5 16C5 16 5.7 14.2 6.2 13.3" />
      <path d="M7.9 10.6C9 9.1 10.2 8 12 8C13.8 8 15 9.1 16.1 10.6" />
      <path d="M17.8 13.3C18.3 14.2 19 16 21.5 16" />
    </svg>
  );
}

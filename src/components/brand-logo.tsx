import { useId } from 'react';

import { cn } from '@/lib/utils';

/**
 * The ToonyBook lockup, inline rather than `<img src="/logo.svg">`.
 *
 * Inline is what makes the wordmark `currentColor`: the site follows the
 * system theme, and the source artwork's near-black wordmark (#1E1B4B) would
 * disappear against a dark header. The mark keeps its brand gradient in both
 * themes.
 *
 * `public/logo.svg` stays the source for the favicon and for `public/logo.png`
 * (email clients don't render SVG — see the sendEmail call in core/auth).
 */
export function BrandLogo({
  className,
  title,
  showTagline = false,
}: {
  className?: string;
  /** Accessible name — pass the app name. Omit to mark it decorative. */
  title?: string;
  /**
   * Off by default: the tagline is 11px in an 80-unit-tall box, so at header
   * height (~40px) it renders at ~5px and reads as a smudge. Turn it on where
   * the lockup is shown large (hero, footer).
   */
  showTagline?: boolean;
}) {
  // The gradient is referenced as url(#id) from <defs>. Two instances on one
  // page (header + footer) would collide on a hardcoded id, so derive a
  // per-instance one. useId is stable across SSR and hydration; the punctuation
  // React adds ("«r0»") is not safe inside a url() fragment, hence the strip.
  const gradientId = `brand-logo-bg-${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      // The mark spans y 10-70, so the no-tagline crop is padded to 8-72 and the
      // wordmark baseline moves from 47 to 50.5 to stay centered on the mark
      // (with the tagline it sits high, balanced against the second line).
      viewBox={showTagline ? '0 0 320 80' : '0 8 320 64'}
      fill="none"
      {...(title
        ? { role: 'img' as const, 'aria-label': title }
        : { 'aria-hidden': true as const })}
      className={cn('h-10 w-auto', className)}
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FF6B4A" />
          <stop offset="100%" stopColor="#FFB800" />
        </linearGradient>
      </defs>

      {/* Mark: rounded tile + open book + magic sparks */}
      <rect
        x="10"
        y="10"
        width="60"
        height="60"
        rx="18"
        fill={`url(#${gradientId})`}
      />
      <path
        d="M 22 46 C 22 46 28 41 40 41 C 52 41 58 46 58 46 L 58 28 C 58 28 52 23 40 23 C 28 23 22 28 22 28 Z"
        fill="#FFFFFF"
        opacity="0.9"
      />
      <path
        d="M 40 23 L 40 41"
        stroke="#FF6B4A"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
      <path
        d="M 40 14 L 42 18 L 46 20 L 42 22 L 40 26 L 38 22 L 34 20 L 38 18 Z"
        fill="#FFFFFF"
      />
      <circle cx="23" cy="20" r="2.5" fill="#FFEAA7" />
      <circle cx="56" cy="18" r="3" fill="#6C5CE7" />

      {/* Wordmark — "Toony" inherits the theme's foreground color */}
      <text
        x="88"
        y={showTagline ? 47 : 50.5}
        fontFamily="'Nunito Variable', 'Nunito', 'Source Sans 3', system-ui, sans-serif"
        fontWeight="900"
        fontSize="30"
        fill="currentColor"
        letterSpacing="-0.5"
      >
        Toony<tspan fill="#FF6B4A">Book</tspan>
      </text>

      {showTagline ? (
        <text
          x="90"
          y="62"
          fontFamily="'Nunito Variable', 'Nunito', system-ui, sans-serif"
          fontWeight="700"
          fontSize="11"
          fill="#6C5CE7"
          letterSpacing="1.2"
          className="dark:fill-[#A78BFA]"
        >
          AI STORYBOOK CREATOR
        </text>
      ) : null}
    </svg>
  );
}

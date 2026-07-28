/**
 * BSV Launchpad mark — a rounded gradient badge (gold→violet, the brand accents)
 * with an ascending "launch" glyph. Pure SVG so it stays crisp from favicon size
 * up to the header, and looks identical in light/dark themes.
 */
export function Logo({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" className={className} aria-hidden="true">
      <defs>
        <linearGradient id="lp-mark" x1="4" y1="2" x2="28" y2="30" gradientUnits="userSpaceOnUse">
          <stop stopColor="#f0ba4a" />
          <stop offset="1" stopColor="#8b7bfb" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="url(#lp-mark)" />
      {/* ascending launch arrow */}
      <path d="M16 6.5 L22.5 19 L16 15.8 L9.5 19 Z" fill="#0a1124" />
      {/* launch trail */}
      <rect x="14.7" y="20.2" width="2.6" height="4.2" rx="1.3" fill="#0a1124" opacity="0.6" />
    </svg>
  );
}

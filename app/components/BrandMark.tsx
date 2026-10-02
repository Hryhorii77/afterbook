import { MARK_BARS, MARK_CRESCENT } from '@/lib/brand';

/** The Afterbook mark. Colours come from the theme tokens: sky tile with dark ink in
 *  dark mode, blue tile with white ink in light mode. */
export function BrandMark({ size = 24 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <rect className="brand-mark-tile" width="64" height="64" rx="16" />
      <g className="brand-mark-ink">
        <path d={MARK_CRESCENT} />
        {MARK_BARS.map((b) => (
          <rect key={b.y} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.h / 2} opacity={b.opacity} />
        ))}
      </g>
    </svg>
  );
}

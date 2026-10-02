import { ImageResponse } from 'next/og';
import { BRAND_BLUE, MARK_BARS, MARK_CRESCENT } from '@/lib/brand';

export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

// iOS rounds the corners itself, so the tile is a full square.
export default function AppleIcon() {
  return new ImageResponse(
    (
      <div style={{ display: 'flex', width: '100%', height: '100%', background: BRAND_BLUE }}>
        <svg width="180" height="180" viewBox="0 0 64 64">
          <path d={MARK_CRESCENT} fill="#fff" />
          {MARK_BARS.map((b) => (
            <rect key={b.y} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.h / 2} fill="#fff" opacity={b.opacity} />
          ))}
        </svg>
      </div>
    ),
    size,
  );
}

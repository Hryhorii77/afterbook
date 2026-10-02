// The Afterbook mark: a crescent (after hours) over two stepped lines (the order
// book), on a 64x64 grid. One definition so the header, favicon, app icon and share
// cards can't drift apart.
export const BRAND_BLUE = '#1f4fe0';
export const BRAND_SKY = '#9cd6ff';
export const BRAND_INK = '#121214';

export const MARK_CRESCENT = 'M34.10 12.57 A15 15 0 1 0 42.20 35.73 A12.3 12.3 0 1 1 34.10 12.57Z';
export const MARK_BARS = [
  { x: 12, y: 44, w: 40, h: 4.5, opacity: 1 },
  { x: 18, y: 51, w: 28, h: 4.5, opacity: 0.62 },
] as const;

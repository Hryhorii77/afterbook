import type { MetadataRoute } from 'next';
import { BRAND_BLUE, BRAND_INK } from '@/lib/brand';

// Apps that bookmark or install the site (the Base app's Discover tiles, Android's
// "Add to Home screen") read their icon from here or from a PNG <link rel="icon">.
// With only the SVG favicon, the Base app drew a letter "A" instead (2026-10-18).
// The PNGs are the 64x64 mark in app/icon.svg rendered full-bleed; re-render them if the mark changes.
// Some apps skip the page's <link> tags and ask for /apple-touch-icon.png (and -precomposed) by name;
// public/ has both as copies of app/apple-icon.png, since the Base app still drew the letter after a
// bookmark was re-added (2026-11-04). Keep them in step with app/apple-icon.png.
// No 'maskable' entry: the mark's lower bar reaches past the maskable safe circle.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Afterbook',
    short_name: 'Afterbook',
    description: "How far Coinbase's tokenized stocks on Base trade from the cash market, live.",
    start_url: '/',
    display: 'standalone',
    background_color: BRAND_INK,
    theme_color: BRAND_BLUE,
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    ],
  };
}

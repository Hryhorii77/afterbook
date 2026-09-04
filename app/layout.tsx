import type { Metadata, Viewport } from 'next';
import { headers } from 'next/headers';
import './globals.css';

// Without an explicit metadataBase, Next resolves the og:image/twitter:image
// meta tags against "http://localhost:3000" even in production.
// VERCEL_PROJECT_PRODUCTION_URL is the stable production alias (what people
// actually share); VERCEL_URL is only this specific immutable deployment's
// URL and is the fallback for preview deploys, which have no stable alias.
const siteHost = process.env.VERCEL_PROJECT_PRODUCTION_URL || process.env.VERCEL_URL;
const siteUrl = siteHost ? `https://${siteHost}` : 'http://localhost:3000';

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: 'Afterbook',
  description: 'Cash close vs the Aero book, in shares. Execution stays on Aerodrome.',
};

// This is a dark-only design by intent — not "supports dark mode," just dark.
// Without this, a device set to light mode renders native form controls
// (checkbox, select, number input spinner) and the mobile browser chrome
// (status bar / address bar) in light colors on top of our near-black page.
// colorScheme forces the browser's native UI to the dark variant regardless
// of the OS preference; themeColor matches the mobile browser chrome to the
// page background instead of leaving it white.
export const viewport: Viewport = {
  colorScheme: 'dark',
  themeColor: '#0b0d10',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Reading the per-request nonce here (set in middleware.ts) opts this
  // route out of static prerendering, which is required for Next to stamp
  // that same nonce onto the inline hydration scripts it renders — without
  // this, the CSP nonce in the response header wouldn't match anything in
  // a statically-baked page and hydration would still be blocked.
  await headers();

  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

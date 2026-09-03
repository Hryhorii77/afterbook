import type { Metadata } from 'next';
import { headers } from 'next/headers';
import './globals.css';

export const metadata: Metadata = {
  title: 'Afterbook',
  description: 'Cash close vs the Aero book, in shares. Execution stays on Aerodrome.',
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

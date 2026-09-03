import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Afterbook',
  description: 'Cash close vs the Aero book, in shares. Execution stays on Aerodrome.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

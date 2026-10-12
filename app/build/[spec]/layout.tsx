import { notFound } from 'next/navigation';
import { parseSpec } from '@/lib/customBasket';

// Rejects a malformed basket URL before loading.tsx starts streaming. The
// page's own notFound() comes after the stream has begun, so it rendered the
// not-found text with an HTTP 200; here the response is still a real 404.
export default async function BuildSpecLayout({ children, params }: { children: React.ReactNode; params: Promise<{ spec: string }> }) {
  if (!parseSpec((await params).spec)) notFound();
  return children;
}

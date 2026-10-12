import { notFound } from 'next/navigation';
import { parseSpec } from '@/lib/customBasket';

// Rejects a malformed basket URL with a real 404 before the page renders.
// While this route had a loading.tsx, the page's own notFound() came after
// streaming had begun and was sent as a 200; keep the check here so adding a
// loading boundary back can't bring that back.
export default async function BuildSpecLayout({ children, params }: { children: React.ReactNode; params: Promise<{ spec: string }> }) {
  if (!parseSpec((await params).spec)) notFound();
  return children;
}

import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { getTape } from '@/lib/tape';
import { getGeoInfo } from '@/lib/geo';
import { getStock } from '@/lib/tokens';
import HomeClient from '../components/HomeClient';
import { shareMetadata } from '@/lib/shareMeta';

interface PageProps {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params, searchParams }: PageProps): Promise<Metadata> {
  const { symbol } = await params;
  const stock = getStock(symbol);
  if (!stock) return {};

  return shareMetadata({
    title: `${stock.symbol} — Afterbook`,
    description: `${stock.name} (${stock.symbol}): cash close vs the Aero book, in shares.`,
    path: `/${stock.symbol}`,
    card: { page: 'stock', sym: stock.symbol },
    searchParams: await searchParams,
  });
}

// Same data fetch as app/page.tsx — the / route stays the default view,
// this is an additional entry point that pre-selects one symbol so tweets
// can deep-link straight to it instead of always landing on the homepage.
export default async function SymbolPage({ params }: PageProps) {
  const { symbol } = await params;
  const stock = getStock(symbol);
  if (!stock) notFound();

  const [tape, geo] = await Promise.all([getTape(), getGeoInfo()]);
  return <HomeClient initialTape={tape} initialGeo={geo} initialSymbol={stock.symbol} />;
}

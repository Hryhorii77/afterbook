import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getTape } from '@/lib/tape';
import { getGeoInfo } from '@/lib/geo';
import { findStock, getStock, poolVenue } from '@/lib/tokens';
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
    description: `${stock.name} (${stock.symbol}): cash price vs the onchain price on ${poolVenue(stock)}, in shares.`,
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
  if (!stock) {
    // People type the plain ticker (/AAPL, /nvda): send them to the token's page (/AAPLc).
    const byTicker = findStock(symbol);
    if (byTicker) permanentRedirect(`/${byTicker.symbol}`);
    notFound();
  }

  const [tape, geo] = await Promise.all([getTape(), getGeoInfo()]);
  return <HomeClient initialTape={tape} initialGeo={geo} initialSymbol={stock.symbol} />;
}

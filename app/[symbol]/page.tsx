import { notFound, permanentRedirect } from 'next/navigation';
import type { Metadata } from 'next';
import { getTape } from '@/lib/market/tape';
import { getGeoInfo } from '@/lib/server/geo';
import { findStock, getStock, poolVenue } from '@/lib/stocks/tokens';
import HomeClient from '../components/markets/HomeClient';
import { getMultiplierHistory } from '@/lib/stocks/multiplierHistory';
import { shareMetadata } from '@/lib/share/shareMeta';
import { firstParam } from '@/lib/share/cardUrl';
import { parsePrefill } from '@/lib/swap/prefill';

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
export default async function SymbolPage({ params, searchParams }: PageProps) {
  const [{ symbol }, sp] = await Promise.all([params, searchParams]);
  const stock = getStock(symbol);
  if (!stock) {
    // People type the plain ticker (/AAPL, /nvda): send them to the token's page (/AAPLc).
    const byTicker = findStock(symbol);
    // Keeps a prefilled buy (`?side=buy&usdc=100`) through the redirect; the browser keeps the #execute hash itself.
    if (byTicker) {
      const keep = new URLSearchParams();
      for (const k of ['side', 'usdc'] as const) {
        const v = firstParam(sp[k]);
        if (v != null) keep.set(k, v);
      }
      const q = keep.toString();
      permanentRedirect(`/${byTicker.symbol}${q ? `?${q}` : ''}`);
    }
    notFound();
  }

  const [tape, geo, corporateActions] = await Promise.all([getTape(), getGeoInfo(), getMultiplierHistory()]);
  // A link may arrive with a buy amount (`?side=buy&usdc=100#execute`, lib/swap/prefill.ts): it only fills the amount.
  const initialUsdc = parsePrefill({ side: firstParam(sp.side), usdc: firstParam(sp.usdc) });
  return (
    <HomeClient initialTape={tape} initialGeo={geo} corporateActions={corporateActions} initialSymbol={stock.symbol} stockPage initialUsdc={initialUsdc} />
  );
}

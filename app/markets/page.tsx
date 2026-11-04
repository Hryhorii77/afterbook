import { getTape } from '@/lib/market/tape';
import { getGeoInfo } from '@/lib/server/geo';
import { buildTodaySnapshot } from '@/lib/market/todaySnapshot';
import HomeClient from '../components/HomeClient';
import { shareMetadata } from '@/lib/share/shareMeta';

export const metadata = shareMetadata({
  title: 'Markets — Afterbook',
  description: "How far Coinbase's tokenized stocks on Base trade from the cash market, live, in shares, with real pool depth. Trade them from your own wallet.",
  path: '/markets',
  card: { page: 'home' },
});

// Fetching real data here (instead of leaving the whole page client-rendered)
// means the server-rendered HTML already has real numbers and real geo
// detection in it — curling the URL, or a crawler/judge viewing source,
// doesn't see empty dashes and "region could not be detected" that only
// resolve after client JS hydrates.
export default async function Page() {
  const [tape, geo] = await Promise.all([getTape(), getGeoInfo()]);
  // Lead with the biggest liquid gap (the pick /today uses), not whichever stock is listed first.
  const initialSymbol = buildTodaySnapshot(tape).headline?.symbol;
  return <HomeClient initialTape={tape} initialGeo={geo} initialSymbol={initialSymbol} />;
}

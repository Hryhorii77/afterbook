import { getTape } from '@/lib/tape';
import { getGeoInfo } from '@/lib/geo';
import { buildTodaySnapshot } from '@/lib/todaySnapshot';
import TradeHome from './components/TradeHome';
import { shareMetadata } from '@/lib/shareMeta';

export const metadata = shareMetadata({
  title: 'Afterbook',
  description: 'Buy, borrow and earn with tokenized stocks on Base, 24/7, priced next to the real stock market. Trade from your own wallet.',
  path: '/',
  card: { page: 'home' },
});

// Real data in the server HTML (prices, the market's state, the region check), so a crawler or a
// slow phone sees numbers rather than dashes. The tape page this used to be is /markets.
export default async function Page() {
  const [tape, geo] = await Promise.all([getTape(), getGeoInfo()]);
  // The card opens on the day's biggest liquid gap (the pick /today uses).
  const initialSymbol = buildTodaySnapshot(tape).headline?.symbol;
  return <TradeHome initialTape={tape} initialGeo={geo} initialSymbol={initialSymbol} />;
}

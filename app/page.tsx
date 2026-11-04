import { getTape } from '@/lib/market/tape';
import { getGeoInfo } from '@/lib/server/geo';
import { buildTodaySnapshot } from '@/lib/market/todaySnapshot';
import TradeHome from './components/home/TradeHome';
import { shareMetadata } from '@/lib/share/shareMeta';
import { getAaveStockLending } from '@/lib/lending/aave';

export const metadata = shareMetadata({
  title: 'Afterbook',
  description: 'Buy, borrow and earn with tokenized stocks on Base, 24/7, priced next to the real stock market. Trade from your own wallet.',
  path: '/',
  card: { page: 'home' },
});

// Real data in the server HTML (prices, the market's state, the region check), so a crawler or a
// slow phone sees numbers rather than dashes. The tape page this used to be is /markets.
export default async function Page() {
  // The Lend tab quotes the lenders' rate: Aave's reads are cached a minute (lib/lending/aave.ts) and given at
  // most 1.5 s, so a slow RPC drops the number rather than holding up the page.
  const lendApr = Promise.race([
    getAaveStockLending().then((a) => a.hub.supplyApr),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500)),
  ]).catch(() => null);
  const [tape, geo, supplyApr] = await Promise.all([getTape(), getGeoInfo(), lendApr]);
  // The card opens on the day's biggest liquid gap (the pick /today uses).
  const initialSymbol = buildTodaySnapshot(tape).headline?.symbol;
  return <TradeHome initialTape={tape} initialGeo={geo} initialSymbol={initialSymbol} lendApr={supplyApr} />;
}

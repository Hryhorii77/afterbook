import { redirect } from 'next/navigation';
import { getTape } from '@/lib/tape';
import { formatSpec, normalizeLegs } from '@/lib/customBasket';

export const dynamic = 'force-dynamic';

// /build opens on a starting basket: the three deepest pools right now,
// equal weights. Every basket lives at its own /build/<spec> URL.
export default async function BuildIndex() {
  const tape = await getTape().catch(() => null);
  const deepest = (tape?.rows ?? [])
    .filter((r) => r.depthUsd != null)
    .sort((a, b) => (b.depthUsd ?? 0) - (a.depthUsd ?? 0))
    .slice(0, 3)
    .map((r) => ({ symbol: r.symbol, weight: 1 }));
  const legs = deepest.length === 3 ? deepest : ['NVDAc', 'AAPLc', 'METAc'].map((symbol) => ({ symbol, weight: 1 }));
  redirect(`/build/${formatSpec(normalizeLegs(legs))}`);
}

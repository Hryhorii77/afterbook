import { getTape } from '@/lib/market/tape';
import { getGeoInfo } from '@/lib/server/geo';
import { shareMetadata } from '@/lib/share/shareMeta';
import { RulesClient } from '../components/agent/RulesClient';

export const metadata = shareMetadata({
  title: 'Stock rules — Afterbook',
  description: 'Recurring stock buys with your own limits: each run is checked for the gap, earnings, pool depth and cost, and you sign every buy yourself.',
  path: '/rules',
  card: { page: 'home' },
});

export default async function Page() {
  const [tape, geo] = await Promise.all([getTape(), getGeoInfo()]);
  return <RulesClient initialTape={tape} geo={geo} />;
}

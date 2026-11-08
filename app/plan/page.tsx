import { getTape } from '@/lib/market/tape';
import { getGeoInfo } from '@/lib/server/geo';
import { shareMetadata } from '@/lib/share/shareMeta';
import { PlanClient } from '../components/agent/PlanClient';

export const metadata = shareMetadata({
  title: 'Trade plan — Afterbook',
  description: 'Give a budget and your limits; Afterbook checks each stock’s gap, earnings, pool depth and fill cost, Claude explains the plan, and you sign any buy yourself.',
  path: '/plan',
  card: { page: 'home' },
});

export default async function Page() {
  const [tape, geo] = await Promise.all([getTape(), getGeoInfo()]);
  return <PlanClient initialTape={tape} geo={geo} />;
}

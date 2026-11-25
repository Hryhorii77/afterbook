// An agent's saved plan (afterbook.app/plan/<id>, 2026-11-21; lib/agent/planLink.ts): an agent asked for a plan
// or a basket over x402 or MCP and got this link to hand to a person (or a person asked the Telegram bot's /plan). The plan's checks run again on every
// view, and only what still passes is offered, at most the saved amount, through the checked swap or the
// basket buy, behind the region gate and the eligibility box. Nothing here signs.
import type { Metadata } from 'next';
import { readSavedPlan } from '@/lib/agent/savedPlan';
import { recheckSavedPlan } from '@/lib/agent/runPlan';
import { getGeoInfo } from '@/lib/server/geo';
import { SavedPlanClient } from '../../components/agent/SavedPlanClient';
import { planFills } from '@/lib/swap/swapLog';
import { unstable_cache } from 'next/cache';

// A plan page's fills through Next's data cache for a minute (keyed by the id), so views don't each read Redis.
const cachedPlanFills = unstable_cache((id: string) => planFills(id), ['plan-fills-v1'], { revalidate: 60 });
import { planReceipts } from '@/lib/agent/planReceipt';
import { getTape } from '@/lib/market/tape';
import { getStock } from '@/lib/stocks/tokens';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export const metadata: Metadata = {
  title: 'Your plan — Afterbook',
  description: 'A trade plan made on Afterbook: checked again now, and you sign any buy yourself.',
  // A private link: never in search results.
  robots: { index: false, follow: false },
};

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const saved = await readSavedPlan(id).catch((err) => {
    console.error('[/plan/[id]] read', err instanceof Error ? err.message : err);
    return 'error' as const;
  });
  if (saved === 'error' || saved === null) return <SavedPlanClient state={saved === null ? 'missing' : 'error'} />;
  const [geo, recheck, receipts] = await Promise.all([
    getGeoInfo(),
    recheckSavedPlan(saved).catch((err) => {
      console.error('[/plan/[id]] recheck', err instanceof Error ? err.message : err);
      return null;
    }),
    // What filled from this link so far (lib/agent/planReceipt.ts); a failed read just shows no receipts.
    (async () => {
      const [fills, tape] = await Promise.all([cachedPlanFills(saved.id), getTape().catch(() => null)]);
      if (!fills.length) return [];
      const multiplier = new Map((tape?.rows ?? []).map((r) => [r.symbol, r.multiplier]));
      return planReceipts(saved, fills, (sym) => getStock(sym)?.decimals, (sym) => multiplier.get(sym));
    })().catch((err) => {
      console.error('[/plan/[id]] receipts', err instanceof Error ? err.message : err);
      return [];
    }),
  ]);
  return <SavedPlanClient state="ok" saved={saved} recheck={recheck} geo={geo} receipts={receipts} />;
}

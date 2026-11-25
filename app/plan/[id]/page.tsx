// An agent's saved plan (afterbook.app/plan/<id>, 2026-11-21; lib/agent/planLink.ts): an agent asked for a plan
// or a basket over x402 or MCP and got this link to hand to a person (or a person asked the Telegram bot's /plan). The plan's checks run again on every
// view, and only what still passes is offered, at most the saved amount, through the checked swap or the
// basket buy, behind the region gate and the eligibility box. Nothing here signs.
import type { Metadata } from 'next';
import { readSavedPlan } from '@/lib/agent/savedPlan';
import { PLAN_ID_RE } from '@/lib/agent/planLink';
import { recheckSavedPlan } from '@/lib/agent/runPlan';
import { getGeoInfo } from '@/lib/server/geo';
import { SavedPlanClient } from '../../components/agent/SavedPlanClient';
import { planFills } from '@/lib/swap/swapLog';
import { unstable_cache } from 'next/cache';

// A plan page's fills through Next's data cache for a minute (keyed by the id), so views don't each read Redis.
const cachedPlanFills = unstable_cache((id: string) => planFills(id), ['plan-fills-v1'], { revalidate: 60 });
import { planReceipts, receiptView } from '@/lib/agent/planReceipt';
import { getTape } from '@/lib/market/tape';
import { getStock } from '@/lib/stocks/tokens';
import { planCardContent } from '@/lib/share/planCard';
import { cardPath, firstParam, parseTheme } from '@/lib/share/cardUrl';
import { OG_SIZE } from '@/lib/share/ogImage';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

const TITLE = 'Your plan — Afterbook';
const DESCRIPTION = 'A trade plan made on Afterbook: checked again now, and you sign any buy yourself.';

// The link preview (2026-11-25): the plan's own card (/card?page=plan&id=…, lib/share/planCard.ts), drawn from the saved
// plan, so a link shared on X or Telegram shows its stocks and verdicts. The saved plan is read through its data cache
// (the page reads the same entry). A private link: never in search results.
export async function generateMetadata({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }): Promise<Metadata> {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const robots = { index: false, follow: false };
  const saved = await readSavedPlan(id).catch(() => null);
  if (!saved) {
    // No plan data on a miss. A well-formed id (expired, or not saved yet) previews the plain "links last 7 days"
    // card; a malformed one gets no image at all. Both replace the root layout's home card, which otherwise showed.
    const image = PLAN_ID_RE.test(id) ? [{ url: cardPath({ page: 'plan', id }, { theme: parseTheme(firstParam(sp.theme)) }), ...OG_SIZE, alt: 'Afterbook plan links last 7 days', type: 'image/png' }] : [];
    return {
      title: TITLE,
      description: DESCRIPTION,
      robots,
      openGraph: { title: TITLE, description: DESCRIPTION, siteName: 'Afterbook', type: 'website', images: image },
      twitter: { card: image.length ? 'summary_large_image' : 'summary', title: TITLE, description: DESCRIPTION, images: image },
    };
  }
  const content = planCardContent(saved);
  const title = `A ${content.kind.toLowerCase()} on Afterbook: ${content.headline}`;
  const description = `${content.rows.map((r) => `${r.symbol} ${r.verdict.toLowerCase()}`).join(', ')}${content.more ? `, and ${content.more} more` : ''}. Checked again when you open it; you sign any buy yourself.`;
  const image = { url: cardPath({ page: 'plan', id: saved.id }, { theme: parseTheme(firstParam(sp.theme)) }), ...OG_SIZE, alt: `${title}. ${description}`, type: 'image/png' };
  return {
    title,
    description,
    robots,
    openGraph: { title, description, url: `/plan/${saved.id}`, siteName: 'Afterbook', type: 'website', images: [image] },
    twitter: { card: 'summary_large_image', title, description, images: [image] },
  };
}

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
      // Display text only: the exact numbers stay on the server (receiptView).
      return planReceipts(saved, fills, (sym) => getStock(sym)?.decimals, (sym) => multiplier.get(sym)).map(receiptView);
    })().catch((err) => {
      console.error('[/plan/[id]] receipts', err instanceof Error ? err.message : err);
      return [];
    }),
  ]);
  return <SavedPlanClient state="ok" saved={saved} recheck={recheck} geo={geo} receipts={receipts} />;
}

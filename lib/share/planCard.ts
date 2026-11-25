// What a plan link's share card says (/plan/<id>, 2026-11-25; drawn by buildPlanOgImage in ./ogImage.tsx). Only
// what the saved plan already shows anyone with the link: its stocks, the code's verdicts and amounts, and when it
// was made. Never receipts, a wallet or anything from the URL: the card is cached by URL, and a saved plan never
// changes, so the card can't go stale or say more than the page.
import type { SavedPlan } from '../agent/planLink';
import { getStock } from '../stocks/tokens';

export interface PlanCardRow {
  symbol: string;
  cashTicker: string;
  /** "Buy $10", "Wait", "Skip", or a basket's "40%". */
  verdict: string;
  buy: boolean;
  /** The gap and cost at the time, in words: "0.10% over the cash price · cost 0.06%". */
  detail: string;
}

export interface PlanCardContent {
  /** "Plan" or "Basket". */
  kind: string;
  /** "From the Telegram bot" or "From an agent". */
  from: string;
  /** "Made Nov 25, 12:26 ET". */
  made: string;
  headline: string;
  rows: PlanCardRow[];
  /** Legs not drawn (the card has room for 4). */
  more: number;
}

const MAX_ROWS = 4;
const money = (n: number) => `$${n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 || Number.isInteger(n) ? 0 : 2, minimumFractionDigits: 0 })}`;
const pct = (bp: number) => `${(Math.abs(bp) / 100).toFixed(2)}%`;

function gapWords(gapBp: number | null, against: string): string {
  if (gapBp == null) return 'no gap reading';
  // The plan's own wording: the gap is against "the cash <word>" (lib/agent/explain.ts).
  const ref = `cash ${against || 'price'}`;
  if (Math.abs(gapBp) < 0.5) return `at the ${ref}`;
  return `${pct(gapBp)} ${gapBp > 0 ? 'over' : 'under'} the ${ref}`;
}

function madeLabel(at: number): string {
  const d = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
  return `Made ${d} ET`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function planCardContent(saved: SavedPlan): PlanCardContent {
  const from = saved.via === 'telegram' ? 'From the Telegram bot' : 'From an agent';
  const made = madeLabel(saved.at);
  const ticker = (sym: string) => getStock(sym)?.cashTicker ?? sym.replace(/c$/, '');

  if (saved.kind === 'plan') {
    const legs = saved.plan.legs;
    const buys = legs.filter((l) => l.verdict === 'buy' && (l.usd ?? 0) > 0);
    const waits = legs.filter((l) => l.verdict === 'wait').length;
    const skips = legs.filter((l) => l.verdict === 'skip').length;
    const planned = buys.reduce((s, l) => s + (l.usd ?? 0), 0);
    const counts = [buys.length && plural(buys.length, 'buy'), waits && plural(waits, 'wait'), skips && plural(skips, 'skip')].filter(Boolean).join(', ');
    const headline = `${counts || 'No buys'} · ${money(planned)} of ${money(saved.plan.budgetUsd)}`;
    // Buys first (largest first), then waits, then skips: what the link offers leads.
    const order = { buy: 0, wait: 1, skip: 2 } as Record<string, number>;
    const sorted = [...legs].sort((a, b) => (order[a.verdict] ?? 3) - (order[b.verdict] ?? 3) || (b.usd ?? 0) - (a.usd ?? 0));
    const rows = sorted.slice(0, MAX_ROWS).map((l) => {
      const buy = l.verdict === 'buy' && (l.usd ?? 0) > 0;
      const cost = buy && l.costBp != null ? ` · cost ${pct(l.costBp)}` : '';
      return {
        symbol: l.symbol,
        cashTicker: ticker(l.symbol),
        verdict: buy ? `Buy ${money(l.usd!)}` : l.verdict === 'wait' ? 'Wait' : 'Skip',
        buy,
        detail: `${gapWords(l.gapBp, l.gapAgainst)}${cost}`,
      };
    });
    return { kind: 'Plan', from, made, headline, rows, more: Math.max(0, legs.length - MAX_ROWS) };
  }

  const b = saved.brief;
  const picks = b.picks ?? [];
  const headline = b.basket && picks.length ? `${money(b.investedUsd)} across ${plural(picks.length, 'stock')}` : 'No basket passed the limits';
  const rows = picks.slice(0, MAX_ROWS).map((p) => ({
    symbol: p.symbol,
    cashTicker: ticker(p.symbol),
    verdict: `${p.weightPct}%`,
    buy: true,
    detail: `${money(p.usd)} · ${gapWords(p.gapBp, p.gapAgainst)} · cost ${pct(p.costBp)}`,
  }));
  return { kind: 'Basket', from, made, headline, rows, more: Math.max(0, picks.length - MAX_ROWS) };
}

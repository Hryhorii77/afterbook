import { randomBytes } from 'crypto';
import { redis } from './redis';
import { getTape, type TapeResult } from './tape';
import { getStock } from './tokens';
import { parseSpec, formatSpec, basketGapBp, basketReferenceLabel } from './customBasket';
import { getBasketCost } from './basketCost';
import { buildTodaySnapshot, closeBasisBp } from './todaySnapshot';
import { stockShareText, todayShareText, basketShareText } from './shareText';
import type { CardSpec } from './cardUrl';

// One share = one frozen moment. When someone clicks Share, the server reads the tape once, writes
// the post's sentence from it and keeps it under the share's id (the `s` in the link) for 30 days;
// the card for that link (app/card/route.tsx) is drawn from the same frozen tape. Before this, the
// sentence came from the screen and the card from live prices a few seconds later, and a post said
// 8.0 bp over a card showing +2.8 bp. Numbers are always computed here, never taken from the
// client, so nobody can make a card show made-up numbers by editing a URL.

const TTL_SECONDS = 30 * 24 * 60 * 60;
const key = (id: string) => `share:${id}`;

export interface ShareSnapshot {
  card: CardSpec;
  takenAt: number;
  tape: Pick<TapeResult, 'rows' | 'session' | 'fetchedAt'>;
  /** Cost in bp to buy $10k of a basket (build cards only). */
  basketCostBp?: number | null;
  text: string;
}

/** Validates a card request from the browser; returns the canonical spec or null. */
export function cleanCardSpec(input: unknown): CardSpec | null {
  if (!input || typeof input !== 'object') return null;
  const c = input as Record<string, unknown>;
  const stock = typeof c.sym === 'string' ? getStock(c.sym) : undefined;
  switch (c.page) {
    case 'stock':
      return stock ? { page: 'stock', sym: stock.symbol } : null;
    case 'today':
      return { page: 'today', sym: stock?.symbol };
    case 'build': {
      const legs = typeof c.spec === 'string' ? parseSpec(c.spec) : null;
      return legs ? { page: 'build', spec: formatSpec(legs) } : null;
    }
    default:
      return null;
  }
}

export async function createShareSnapshot(card: CardSpec): Promise<{ id: string; text: string } | null> {
  if (!redis) return null;
  const tape = await getTape();
  let text: string;
  let basketCostBp: number | null | undefined;
  let stored: CardSpec = card;

  if (card.page === 'stock') {
    text = stockShareText(tape.rows.find((r) => r.symbol === card.sym), tape);
  } else if (card.page === 'today') {
    const marketOpen = tape.session.state === 'open';
    const row = (card.sym && tape.rows.find((r) => r.symbol === card.sym)) || buildTodaySnapshot(tape).headline;
    const gap = row ? (marketOpen ? row.basisBp : closeBasisBp(row)) : null;
    if (!row || gap == null) return null;
    stored = { page: 'today', sym: row.symbol };
    text = todayShareText(row.symbol, gap, marketOpen);
  } else if (card.page === 'build') {
    const legs = parseSpec(card.spec)!;
    const cost = await getBasketCost(legs).catch(() => null);
    basketCostBp = cost?.points.find((p) => p.usd === 10_000)?.costBp ?? null;
    text = basketShareText(legs, basketGapBp(legs, tape.rows, tape.session.state), basketReferenceLabel(legs, tape.rows, tape.session.state));
  } else {
    return null;
  }

  const id = randomBytes(8).toString('hex');
  const snapshot: ShareSnapshot = {
    card: stored,
    takenAt: Date.now(),
    tape: { rows: tape.rows, session: tape.session, fetchedAt: tape.fetchedAt },
    basketCostBp,
    text,
  };
  await redis.set(key(id), snapshot, { ex: TTL_SECONDS });
  return { id, text };
}

export async function getShareSnapshot(id: string): Promise<ShareSnapshot | null> {
  if (!redis || !/^[a-f0-9]{16}$/.test(id)) return null;
  try {
    return (await redis.get<ShareSnapshot>(key(id))) ?? null;
  } catch {
    return null;
  }
}

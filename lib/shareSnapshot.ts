import { randomBytes } from 'crypto';
import { redis } from './redis';
import { getTape, type TapeResult } from './tape';
import { getStock } from './tokens';
import { parseSpec, formatSpec, basketGapBp, basketReferenceLabel } from './customBasket';
import { getBasketCost } from './basketCost';
import { buildTodaySnapshot, todayReference } from './todaySnapshot';
import { stockShareText, todayShareText, basketShareText } from './shareText';
import type { CardSpec } from './cardUrl';
import { getBorrowSummary } from './liquidationRisk';
import { borrowShareText, type BorrowSummary } from './borrowSummary';
import { getMemeRow, type MemeRow } from './memestocks';
import { memeShareText } from './memeFormat';

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
  /** Lending totals and markets (borrow cards only). */
  borrow?: BorrowSummary;
  /** The meme's row as it was at share time (meme cards only). */
  meme?: MemeRow;
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
    case 'borrow':
      return { page: 'borrow' };
    case 'meme':
      // Shape only; createShareSnapshot then needs the meme on the verified allowlist.
      return typeof c.addr === 'string' && /^0x[a-fA-F0-9]{40}$/.test(c.addr) ? { page: 'meme', addr: c.addr } : null;
    default:
      return null;
  }
}

export async function createShareSnapshot(card: CardSpec): Promise<{ id: string; text: string } | null> {
  if (!redis) return null;
  const tape = await getTape();
  let text: string;
  let basketCostBp: number | null | undefined;
  let borrow: BorrowSummary | undefined;
  let meme: MemeRow | undefined;
  let stored: CardSpec = card;

  if (card.page === 'stock') {
    text = stockShareText(tape.rows.find((r) => r.symbol === card.sym), tape);
  } else if (card.page === 'today') {
    const row = (card.sym && tape.rows.find((r) => r.symbol === card.sym)) || buildTodaySnapshot(tape).headline;
    const ref = row ? todayReference(row, tape.session) : null;
    if (!row || !ref || ref.bp == null) return null;
    stored = { page: 'today', sym: row.symbol };
    text = todayShareText(row.symbol, ref.bp, ref.word);
  } else if (card.page === 'build') {
    const legs = parseSpec(card.spec)!;
    const cost = await getBasketCost(legs).catch(() => null);
    basketCostBp = cost?.points.find((p) => p.usd === 10_000)?.costBp ?? null;
    text = basketShareText(legs, basketGapBp(legs, tape.rows, tape.session.state), basketReferenceLabel(legs, tape.rows, tape.session.state));
  } else if (card.page === 'borrow') {
    borrow = await getBorrowSummary();
    if (borrow.rows.length === 0) return null;
    text = borrowShareText(borrow);
  } else if (card.page === 'meme') {
    const row = await getMemeRow(card.addr);
    if (!row) return null;
    meme = row;
    stored = { page: 'meme', addr: row.pool.meme.address };
    text = memeShareText(row.pool.meme.symbol, row.move.h24, row.pool.stockSymbol, row.stockMove.h24);
  } else {
    return null;
  }

  const id = randomBytes(8).toString('hex');
  const snapshot: ShareSnapshot = {
    card: stored,
    takenAt: Date.now(),
    tape: { rows: tape.rows, session: tape.session, fetchedAt: tape.fetchedAt },
    basketCostBp,
    borrow,
    meme,
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

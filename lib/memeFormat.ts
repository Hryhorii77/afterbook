// Small formatters shared by the /memes pages, the board and the meme card.
import { usdCompact } from './format';

/** +40.2% / −3.1% / — */
export const pctMove = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);

/** A price that can be $0.0000004: keep four significant digits. */
export function memePrice(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `$${n.toPrecision(4).replace(/0+$/, '')}`;
}

export function ageText(createdAt: number | null, now = Date.now()): string {
  if (!createdAt) return 'unknown';
  const days = Math.floor((now - createdAt) / 86_400_000);
  if (days < 1) return 'under a day';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  return `${Math.round(days / 30)} months`;
}

/** "BLUECHIP −7.8% while NVDAc +1.0% (24h)": the one number this page is for. */
export function moveSentence(meme: string, memeMove: number | null, stock: string, stockMove: number | null): string | null {
  if (memeMove == null) return null;
  return `${meme} ${pctMove(memeMove)} while ${stock} ${pctMove(stockMove)} in 24 hours`;
}

export const usdOrDash = (n: number | null) => (n == null ? '—' : usdCompact(n));

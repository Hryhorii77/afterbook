// Small formatters shared by the /memes pages, the board and the meme card.
import { usdCompact } from './format';

/** +40.2% / −3.1% / — */
export const pctMove = (n: number | null) => (n == null ? '—' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1)}%`);

/** A price that can be $0.0000004: four significant digits, always written out (toPrecision gave
 *  "$1.554e-7", which most people can't read). */
export function memePrice(n: number | null): string {
  if (n == null || !Number.isFinite(n) || n < 0) return '—';
  if (n >= 1) return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  if (n === 0) return '$0';
  const decimals = Math.min(20, Math.max(2, Math.ceil(-Math.log10(n)) + 3));
  return `$${n.toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '')}`;
}

/** A tiny price split for "$0.0₆1554" (six zeros after the point, then the digits), the way
 *  Dexscreener writes it; null when the price has fewer than three zeros and reads fine as is. */
export function memePriceZeros(n: number | null): { zeros: number; digits: string } | null {
  if (n == null || !Number.isFinite(n) || n <= 0 || n >= 0.001) return null;
  const [, frac = ''] = memePrice(n).slice(1).split('.');
  const zeros = frac.match(/^0*/)![0].length;
  return { zeros, digits: frac.slice(zeros) };
}

export function ageText(createdAt: number | null, now = Date.now()): string {
  if (!createdAt) return '—';
  const days = Math.floor((now - createdAt) / 86_400_000);
  if (days < 1) return '< 1 day';
  if (days < 60) return `${days} day${days === 1 ? '' : 's'}`;
  return `${Math.round(days / 30)} months`;
}

/** "BLUECHIP −7.8% while NVDAc +1.0% (24h)": the one number this page is for. */
export function moveSentence(meme: string, memeMove: number | null, stock: string, stockMove: number | null): string | null {
  if (memeMove == null) return null;
  return `${meme} ${pctMove(memeMove)} while ${stock} ${pctMove(stockMove)} in 24 hours`;
}

/** The post's sentence for a shared meme page (and the snapshot's, so the card matches it). */
export function memeShareText(meme: string, memeMove: number | null, stock: string, stockMove: number | null): string {
  const sentence = moveSentence(meme, memeMove, stock, stockMove);
  return `${sentence ?? `${meme}, a Base meme priced in ${stock}`}. Base memes priced in stock tokens, on Afterbook:`;
}

export const usdOrDash = (n: number | null) => (n == null ? '—' : usdCompact(n));

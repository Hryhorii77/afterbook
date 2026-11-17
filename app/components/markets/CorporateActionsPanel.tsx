'use client';

// Dividends and splits of the selected stock token, read onchain (lib/stocks/multiplierHistory.ts).
// Each entry is a MultiplierUpdated event with its transaction; the wording comes from classifyAction.

import type { CbStock } from '@/lib/stocks/tokens';
import { classifyAction, type CorporateAction } from '@/lib/stocks/multiplierActions';

const dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
/** 0.050, 1.06, 0.0040, 0.00019: three decimals, or two significant digits when that would show 0.000. */
const pctText = (p: number) => (p >= 0.01 ? p.toFixed(p >= 1 ? 2 : 3) : p.toPrecision(2));
const shares = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 6, maximumFractionDigits: 6 });

function describe(a: CorporateAction, ticker: string): string {
  const c = classifyAction(a);
  const range = c.from != null ? ` (${shares(c.from)} → ${shares(c.to)} shares a token)` : ` (now ${shares(c.to)} shares a token)`;
  switch (c.kind) {
    case 'dividend':
      return `Dividend reinvested: each token now holds ${pctText(c.pct!)}% more ${ticker}${range}.`;
    case 'split':
      return `Stock split ${c.ratio}: each token now holds ${Math.round(c.to / c.from!)}× the ${ticker}${range}.`;
    case 'reverse-split':
      return `Reverse split ${c.ratio}${range}.`;
    default:
      return `Shares a token changed${range}.`;
  }
}

export function CorporateActionsPanel({ stock, actions, scanned }: { stock: CbStock; actions: CorporateAction[]; scanned: boolean }) {
  if (!scanned) return null;
  const mine = actions.filter((a) => a.symbol === stock.symbol).reverse();
  return (
    <section className="panel corp-actions" aria-labelledby="corp-actions-h">
      <h2 id="corp-actions-h">Dividends and splits · {stock.symbol}</h2>
      {mine.length ? (
        <ul className="corp-actions-list">
          {mine.map((a) => (
            <li key={`${a.tx}:${a.logIndex}`}>
              <span className="corp-actions-date">{dateFmt.format(new Date(a.atMs))}</span>
              <span>
                {describe(a, stock.cashTicker)}{' '}
                <a href={`https://basescan.org/tx/${a.tx}`} target="_blank" rel="noopener noreferrer" className="emph-link">
                  Transaction&nbsp;<span className="ext-arrow">↗</span>
                </a>
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="corp-actions-none">No dividend or split for {stock.symbol} so far.</p>
      )}
      <p className="geo-note">
        Each token stands for a number of real {stock.cashTicker} shares, its multiplier. Coinbase reinvests a cash dividend, after
        withholding tax and a fee, by raising it, so holders get more stock instead of cash; a split multiplies it. Read onchain from the
        token&apos;s own updates.
      </p>
    </section>
  );
}

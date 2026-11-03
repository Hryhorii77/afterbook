// Execute: the eligibility checkbox, the in-app swap (SwapPanel) once it is ticked in an eligible
// region, the Aerodrome fallback, and the token's contract facts.
import { aerodromeSwapUrl, aerodromeDepositUrl, type CbStock } from '@/lib/tokens';
import type { TapeRow } from '@/lib/tape';
import type { GeoInfo } from '@/lib/geo';
import { usd } from '@/lib/format';
import { SwapPanel } from '../SwapPanel';
import { logOutboundClick, truncateAddr, useCopy } from './util';
import type { DepthResponse, QuoteResponse } from './types';

interface Props {
  symbol: string;
  activeStock: CbStock;
  activeRow: TapeRow | undefined;
  quote: QuoteResponse | null;
  depth: DepthResponse | null;
  geo: GeoInfo;
  eligibleChecked: boolean;
  setEligibleChecked: (v: boolean) => void;
  unlocked: boolean;
}

export function ExecuteSection({ symbol, activeStock, activeRow, quote, depth, geo, eligibleChecked, setEligibleChecked, unlocked }: Props) {
  const lotCopy = useCopy();
  const amountCopy = useCopy();

  // One-shot dump of the whole lot — symbol, size, shares, full pool
  // address — for pasting into a chat/ticket/agent prompt, distinct from
  // copyAmount below, which copies just the bare number for Aerodrome's own
  // amount field.
  const copyLot = () => {
    if (!quote) return;
    const text = `${activeStock.symbol} $${quote.usdcIn} ~${quote.sharesOut.toFixed(2)} ${activeStock.pool.address}`;
    void lotCopy.copy(text);
  };

  // Aerodrome's swap URL has no amount param (verified live — from/to/chain
  // are the only ones it reads), so the closest we can get to a deep-linked
  // trade size is a paste instead of a retype.
  const copyAmount = () => {
    if (quote) void amountCopy.copy(String(quote.usdcIn));
  };

  return (
    <section className="panel" id="execute">
      <h2>Execute</h2>
      {quote && (
        // Visible regardless of the eligibility checkbox below — a user
        // shouldn't have to affirm a legal checkbox just to see what
        // they'd actually be trading. The buttons and paste checklist
        // stay gated; this preview line doesn't need to be.
        <div className="trade-summary-row">
          <p className="trade-summary">
            {activeStock.symbol} · {usd(quote.usdcIn, 0)} · ~{quote.sharesOut.toFixed(2)} sh · pool{' '}
            {truncateAddr(activeStock.pool.address)}
          </p>
          <button type="button" className="btn btn-secondary" onClick={copyLot}>
            {lotCopy.copied ? 'Copied ✓' : 'Copy lot'}
          </button>
        </div>
      )}
      <label className="eligibility">
        <input
          type="checkbox"
          checked={eligibleChecked}
          onChange={(e) => setEligibleChecked(e.target.checked)}
        />
        I confirm I am not a US person and am eligible under my local law to trade tokenized equities.
      </label>
      {unlocked ? (
        <SwapPanel key={activeStock.symbol} stock={activeStock} defaultUsd={quote?.usdcIn} />
      ) : (
        // Same Buy / Sell switch the panel opens with, greyed out until eligibility is confirmed, so
        // both directions are visible up front and nothing moves when the box is ticked.
        <div className="carry-direction-toggle swap-side-toggle" aria-label="Buy or sell">
          <button type="button" className="carry-direction-tab" disabled>
            Buy {activeStock.symbol}
          </button>
          <button type="button" className="carry-direction-tab" disabled>
            Sell {activeStock.symbol}
          </button>
        </div>
      )}
      {unlocked && (
        <details className="geo-more">
          <summary className="emph-link">Or trade on Aerodrome&apos;s own site</summary>
          <div className="actions">
            {quote && (
              <button type="button" className="btn btn-secondary" onClick={copyAmount}>
                {amountCopy.copied ? 'Copied ✓' : `Copy ${usd(quote.usdcIn, 0)}`}
              </button>
            )}
            <a
              className="btn btn-secondary"
              href={aerodromeSwapUrl(activeStock)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => logOutboundClick(activeStock.symbol, quote?.usdcIn ?? null, 'aerodrome-swap', 'buy')}
            >
              Open {activeStock.symbol} on Aerodrome&nbsp;<span className="ext-arrow">↗</span>
            </a>
            <a
              className="btn btn-secondary"
              href={aerodromeDepositUrl(activeStock)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => logOutboundClick(activeStock.symbol, quote?.usdcIn ?? null, 'aerodrome-deposit')}
            >
              Add {activeStock.symbol} liquidity
            </a>
          </div>
          {quote && (
            // Aerodrome's swap URL has no amount param (verified live), so the
            // deep link alone leaves the user guessing what to paste where.
            // Spelling out the 3 clicks beats a silent assumption they'll
            // figure it out — this is the actual last-mile drop-off, not the
            // math above it.
            <ol className="paste-checklist">
              <li>
                Copy <strong>{usd(quote.usdcIn, 0)}</strong> — the button above puts it on your clipboard.
              </li>
              <li>Open {activeStock.symbol} on Aerodrome — the token pair is already selected.</li>
              <li>
                Paste into the USDC amount field, confirm, and sign in your own wallet — this app never touches
                it.
              </li>
            </ol>
          )}
        </details>
      )}
      {!eligibleChecked && geo.nonUs && <p className="geo-note">Confirm eligibility to trade.</p>}
      {geo.nonUs !== true ? (
        // Said plainly and up front: the greyed-out buttons alone read as broken.
        <p className="geo-note geo-note-blocked" style={{ marginBottom: 2 }}>
          {geo.country === 'US'
            ? "Trading is off in the United States: Coinbase's stock tokens aren't offered there. Everything else on Afterbook works."
            : "Trading is off because we couldn't tell which country you're in (a VPN or privacy setting can hide it). Everything else on Afterbook works."}
        </p>
      ) : (
        <p className="geo-note" style={{ marginBottom: 2 }}>
          Detected region: {geo.country}. Trades are signed in your own wallet; Afterbook never holds your funds.
        </p>
      )}
      <details className="geo-more">
        <summary>More</summary>
        <p className="geo-note">
          This is a best-effort geofence based on IP country, not a compliance control — it does not stop a
          VPN.{geo.country === 'US' && ' Execution stays locked regardless of the checkbox above.'} Buying and
          selling here sends a swap from your own wallet through KyberSwap&apos;s router (it splits the trade across
          Aero, Aerodrome and other Base pools). KyberSwap builds the transaction; Afterbook checks the
          fields that decide what you pay, who receives, the minimum, the fee and the permit before your wallet sees it,
          and never holds funds; approvals are for the exact amount only.
        </p>
      </details>
      <p className="geo-note contract-info">
        Token{' '}
        <a href={`https://basescan.org/address/${activeStock.tokenAddress}`} target="_blank" rel="noopener noreferrer">
          {truncateAddr(activeStock.tokenAddress)}&nbsp;<span className="ext-arrow">↗</span>
        </a>
        {' · '}Pool{' '}
        <a href={`https://basescan.org/address/${activeStock.pool.address}`} target="_blank" rel="noopener noreferrer">
          {truncateAddr(activeStock.pool.address)}&nbsp;<span className="ext-arrow">↗</span>
        </a>
        {' — verified on-chain, see README for the full check.'}
      </p>
      {activeRow?.multiplier != null && activeRow.multiplier !== 1 && (
        <p className="geo-note">
          1 {activeStock.symbol} currently redeems for {activeRow.multiplier.toFixed(4)} shares — reflects a past
          split or reinvested dividend (B20&apos;s <code>multiplier()</code>, read live on every quote).
        </p>
      )}
      <p className="geo-note">
        {depth && depth.symbol === symbol && depth.totalSupplyShares != null && (
          <>
            {depth.totalSupplyShares.toLocaleString('en-US', { maximumFractionDigits: 2 })} {activeStock.symbol} total
            supply on Base — read live from the token&apos;s own <code>totalSupply()</code>, not a static claim.{' '}
          </>
        )}
        Per Coinbase&apos;s own documentation, each token is backed 1:1 by a share held with Alpaca Securities (a
        regulated broker-custodian, ADGM-supervised, bankruptcy-remote structure) — that&apos;s the issuer&apos;s
        stated claim, not something this app can verify on-chain itself (no reserve-attestation contract exists
        for B20 tokens the way it does for some wrapped assets).{' '}
        <a className="emph-link" href="https://blog.base.org/tokenized-stocks" target="_blank" rel="noopener noreferrer">
          Source&nbsp;<span className="ext-arrow">↗</span>
        </a>
      </p>
    </section>
  );
}

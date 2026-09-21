import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { getStock } from '@/lib/tokens';
import { getCachedPoolState, midPriceUsd, tickForPriceUsd } from '@/lib/quote';
import { getPriceHistory, computeInRangeBounds } from '@/lib/volatility';
import { getNextEarnings } from '@/lib/earningsCalendar';
import { computeDivergenceLossAtBoundary } from '@/lib/lpRange';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE_PREMIUM } from '@/lib/x402';

export const revalidate = 0;

const DEFAULT_HOLDING_DAYS = 7;
const DEFAULT_TARGET_PROBABILITY_PCT = 70;
const PRICE_HISTORY_LOOKBACK_MS = 30 * 24 * 60 * 60_000;

// No options-implied-vol source exists anywhere in this app (see
// lib/earningsCalendar.ts and Bankr's separate "earnings volatility
// premium" suggestion for that gap) — this is a documented heuristic
// widening, not a real implied-move estimate, applied only when the
// earnings date actually falls inside the requested holding window.
const EARNINGS_VOL_WIDENING_FACTOR = 1.5;

async function handler(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get('symbol') ?? '';

  const stock = getStock(symbol);
  if (!stock) {
    return NextResponse.json({ error: 'unknown symbol' }, { status: 400 });
  }

  const holdingDaysRaw = searchParams.get('holdingDays');
  const holdingDays = holdingDaysRaw && Number.isFinite(Number(holdingDaysRaw)) ? Number(holdingDaysRaw) : DEFAULT_HOLDING_DAYS;
  if (holdingDays <= 0 || holdingDays > 365) {
    return NextResponse.json({ error: 'holdingDays must be between 1 and 365' }, { status: 400 });
  }

  const targetProbRaw = searchParams.get('targetProbabilityPct');
  const targetProbabilityPct = targetProbRaw && Number.isFinite(Number(targetProbRaw)) ? Number(targetProbRaw) : DEFAULT_TARGET_PROBABILITY_PCT;
  if (targetProbabilityPct <= 0 || targetProbabilityPct >= 100) {
    return NextResponse.json({ error: 'targetProbabilityPct must be between 0 and 100' }, { status: 400 });
  }

  try {
    const [state, priceHistory, nextEarningsIso] = await Promise.all([
      getCachedPoolState(stock),
      getPriceHistory(stock.symbol, Date.now() - PRICE_HISTORY_LOOKBACK_MS),
      getNextEarnings(stock.symbol),
    ]);

    const currentPriceUsd = midPriceUsd(state, stock);
    const daysUntilEarnings = nextEarningsIso ? (new Date(`${nextEarningsIso}T23:59:59Z`).getTime() - Date.now()) / 86_400_000 : null;
    const earningsInWindow = daysUntilEarnings != null && daysUntilEarnings >= 0 && daysUntilEarnings <= holdingDays;

    const bounds = computeInRangeBounds(priceHistory, currentPriceUsd, holdingDays, targetProbabilityPct);
    if (!bounds) {
      return NextResponse.json({ error: 'not enough price history yet for this symbol' }, { status: 503 });
    }

    // Widen symmetrically in log-price space around the current price,
    // same shape computeInRangeBounds already produces — a flat multiplier
    // on distance-from-current, not a re-run of the sigma model.
    const widen = earningsInWindow ? EARNINGS_VOL_WIDENING_FACTOR : 1;
    const lowUsd = currentPriceUsd * (bounds.lowUsd / currentPriceUsd) ** widen;
    const highUsd = currentPriceUsd * (bounds.highUsd / currentPriceUsd) ** widen;

    const tickLower = tickForPriceUsd(highUsd, state.multiplier, stock);
    const tickUpper = tickForPriceUsd(lowUsd, state.multiplier, stock);
    const divergenceLoss = computeDivergenceLossAtBoundary(lowUsd, highUsd, currentPriceUsd);

    return NextResponse.json({
      symbol: stock.symbol,
      currentPriceUsd,
      holdingDays,
      targetProbabilityPct,
      annualizedVol: bounds.sigma,
      nextEarningsDate: nextEarningsIso,
      earningsAdjustmentApplied: earningsInWindow,
      recommendedRange: {
        lowUsd,
        highUsd,
        tickLower,
        tickUpper,
      },
      // Impermanent-loss benchmark if price reaches exactly the low/high
      // edge of the recommended range — see lib/lpRange.ts for the
      // derivation. Not fees (which offset it separately).
      divergenceLossAtBoundary: divergenceLoss,
    });
  } catch (err) {
    return NextResponse.json({ error: 'lp-range unavailable', detail: String(err) }, { status: 502 });
  }
}

// Agent-facing sizing tool: pass a ticker and a target holding period, get
// back a tick range sized from realized volatility (widened if earnings
// fall inside the window) instead of the agent having to pull 30 days of
// price history and reimplement lib/volatility.ts's estimator itself.
export const GET: (request: NextRequest) => Promise<NextResponse> = x402Configured
  ? withX402<unknown>(
      handler,
      {
        accepts: {
          scheme: 'exact',
          price: X402_PRICE_PREMIUM,
          network: X402_NETWORK,
          payTo: X402_PAYOUT_ADDRESS!,
        },
        description: 'Recommended concentrated-liquidity tick range for one of Afterbook\'s ten stock pools, sized from realized volatility and a target holding period, plus the divergence-loss benchmark at each edge of that range.',
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });

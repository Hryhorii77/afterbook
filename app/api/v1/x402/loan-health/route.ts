// GET /api/v1/x402/loan-health?wallet=0x…[&threshold=1.2]: a wallet's Aave V4 and Morpho stock loans on Base
// for agents, paid per call with x402 ($0.02 in USDC on Base; 2026-11-21). The same reads and rules as the
// Telegram loan alerts (lib/lending/loanPositions.ts, loanHealth.ts): health at the lending oracle and at
// Aero's price (which keeps trading while the cash market is shut), how far the collateral could fall
// before liquidation, whether the loan is under `threshold`, and for an Aave loan the links that open
// Afterbook's Aave panel with the rescue planner set (lib/lending/rescueLink.ts), where a person signs. The answer
// is lib/lending/loanReport.ts, shared with the free MCP tool check_loan_health (2026-11-22).
// Read-only: chain reads of public positions, nothing a wallet could sign. A 400 or 502 isn't charged.
import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { getAddress, isAddress } from 'viem';
import { limitRead } from '@/lib/server/readGuard';
import { DEFAULT_ALERT_HEALTH, MAX_ALERT_HEALTH, MIN_ALERT_HEALTH } from '@/lib/lending/loanHealth';
import { loanHealthReport } from '@/lib/lending/loanReport';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE } from '@/lib/server/x402';

export const revalidate = 0;
export const maxDuration = 30;

async function handler(request: NextRequest) {
  // Several chain reads per call; the handler runs before the payment settles (as the plan routes).
  const limited = limitRead(request, 'agent-loan-health', 'lots');
  if (limited) return limited;
  const params = request.nextUrl.searchParams;
  for (const k of params.keys()) {
    if (k !== 'wallet' && k !== 'threshold') return NextResponse.json({ error: `unknown parameter: ${k.slice(0, 30)} (allowed: wallet, threshold)` }, { status: 400 });
  }
  const walletArg = params.get('wallet') ?? '';
  if (!isAddress(walletArg, { strict: false })) return NextResponse.json({ error: 'wallet must be an address (0x followed by 40 hex characters)' }, { status: 400 });
  const thresholdArg = params.get('threshold');
  const threshold = thresholdArg == null ? DEFAULT_ALERT_HEALTH : Number(thresholdArg);
  if (!Number.isFinite(threshold) || threshold < MIN_ALERT_HEALTH || threshold > MAX_ALERT_HEALTH) {
    return NextResponse.json({ error: `threshold must be between ${MIN_ALERT_HEALTH} and ${MAX_ALERT_HEALTH}` }, { status: 400 });
  }
  const wallet = getAddress(walletArg);
  try {
    return NextResponse.json(await loanHealthReport(wallet, threshold));
  } catch (err) {
    console.error('[/api/v1/x402/loan-health]', err);
    return NextResponse.json({ error: 'loan-health unavailable, try again shortly' }, { status: 502 });
  }
}

export const GET: (request: NextRequest) => Promise<NextResponse> = x402Configured
  ? withX402<unknown>(
      handler,
      {
        accepts: { scheme: 'exact', price: X402_PRICE, network: X402_NETWORK, payTo: X402_PAYOUT_ADDRESS! },
        description:
          "A wallet's Aave V4 and Morpho stock-token loans on Base: health at the lending oracle and at Aero's onchain price (which keeps trading while the cash market is shut), how far the collateral could fall before liquidation, whether it is under your threshold, and for an Aave loan links that open Afterbook's Aave panel with the repay or the added collateral worked out, for the person to sign. Read-only.",
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });

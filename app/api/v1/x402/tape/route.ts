import { NextRequest, NextResponse } from 'next/server';
import { withX402 } from '@x402/next';
import { getTape } from '@/lib/tape';
import { toPublicTape } from '@/lib/publicTape';
import { x402Configured, getX402Server, X402_PAYOUT_ADDRESS, X402_NETWORK, X402_PRICE } from '@/lib/x402';

export const revalidate = 0;

async function handler(_request: NextRequest) {
  const tape = await getTape();
  return NextResponse.json(toPublicTape(tape));
}

// Same shared public shape /api/v1/tape and the MCP get_tape tool already
// use — this is a third, machine-payable way to reach it. No API key, no
// rate limiter: payment itself is the throttle.
export const GET: (request: NextRequest) => Promise<NextResponse> = x402Configured
  ? withX402<unknown>(
      handler,
      {
        accepts: {
          scheme: 'exact',
          price: X402_PRICE,
          network: X402_NETWORK,
          payTo: X402_PAYOUT_ADDRESS!,
        },
        description:
          "Live cash-vs-Aerodrome basis, mid price, and pool depth for Afterbook's ten tokenized-stock pools on Base.",
      },
      getX402Server(),
    )
  : async () => NextResponse.json({ error: 'x402 tier not configured' }, { status: 503 });

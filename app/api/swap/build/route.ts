import { NextRequest, NextResponse } from 'next/server';
import { isAddress, getAddress } from 'viem';
import { guardSwapRequest } from '@/lib/swap/swapGuard';
import { buildSwap, parseSwapRequest, SwapError } from '@/lib/swap/swap';
import { rememberBuiltSwap } from '@/lib/swap/swapLog';
import { parseMemeSwapRequest } from '@/lib/swap/memeSwap';

export const revalidate = 0;

// The swap transaction for the connected wallet, built fresh and checked field by field in
// lib/swap/swap.ts (buildSwap) before it is returned. The browser sends it as is; nothing here signs.
// POST { symbol, side, amountIn, account, source?, slippageBps? } (source: 'basket' for a /build basket leg,
// for the metrics; slippageBps 10-100, default 50) or, for a meme buy, POST { meme, payWith, amountIn, account, slippageBps? }
export async function POST(request: NextRequest) {
  const refused = await guardSwapRequest(request);
  if (refused) return refused;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: 'invalid JSON' }, { status: 400 });
  const req = 'meme' in body ? await parseMemeSwapRequest(body) : parseSwapRequest(body);
  if (typeof req === 'string') return NextResponse.json({ error: req }, { status: 400 });
  if (typeof body.account !== 'string' || !isAddress(body.account)) return NextResponse.json({ error: 'account must be an address' }, { status: 400 });
  try {
    const account = getAddress(body.account);
    const tx = await buildSwap(req, account);
    await rememberBuiltSwap(tx, account, req.meme ? 'meme' : body.source === 'basket' ? 'basket' : 'stock');
    return NextResponse.json(tx);
  } catch (err) {
    return NextResponse.json({ error: err instanceof SwapError ? err.message : 'could not build the swap' }, { status: err instanceof SwapError ? err.status : 502 });
  }
}

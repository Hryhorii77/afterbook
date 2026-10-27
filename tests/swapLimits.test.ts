// The size limits in getRoute (shared by quoteSwap and buildSwap): $25k per swap, and a stock buy at most
// MAX_BUY_DEPTH_SHARE of its live pool depth. KyberSwap and the pool read are mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const depth = { usd: 50_000 as number | null };
vi.mock('../lib/quote', () => ({
  getCachedPoolState: vi.fn(async () => {
    if (depth.usd == null) throw new Error('rpc down');
    return {};
  }),
  poolDepth: vi.fn(() => ({ totalUsd: depth.usd })),
}));

const { quoteSwap, parseSwapRequest, KYBER_ROUTER, MAX_BUY_DEPTH_SHARE } = await import('../lib/swap');
const { getStock, USDC } = await import('../lib/tokens');

/** Answers KyberSwap's /routes the way the real API does, priced at `usd` for the input. */
function mockKyber(usd: number) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const q = new URL(url).searchParams;
      return new Response(
        JSON.stringify({
          code: 0,
          data: {
            routerAddress: KYBER_ROUTER,
            routeSummary: {
              tokenIn: q.get('tokenIn'),
              tokenOut: q.get('tokenOut'),
              amountIn: q.get('amountIn'),
              amountOut: '1000',
              amountInUsd: String(usd),
              amountOutUsd: String(usd),
              gasUsd: '0.01',
              route: [[{ exchange: 'aero-cl' }]],
            },
          },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }),
  );
}

const req = (symbol: string, side: 'buy' | 'sell', usd: number) => {
  const stock = getStock(symbol)!;
  const decimals = side === 'buy' ? USDC.decimals : stock.decimals;
  const r = parseSwapRequest({ symbol, side, amountIn: String(Math.round(usd * 10 ** decimals)) });
  if (typeof r === 'string') throw new Error(r);
  return r;
};

beforeEach(() => {
  depth.usd = 50_000;
});
afterEach(() => vi.unstubAllGlobals());

describe('stock buy depth cap', () => {
  it(`allows a buy under ${MAX_BUY_DEPTH_SHARE * 100}% of the pool`, async () => {
    mockKyber(4_000);
    const q = await quoteSwap(req('SONYc', 'buy', 4_000));
    expect(q).toMatchObject({ symbol: 'SONYc', side: 'buy', amountInUsd: 4_000 });
  });

  it('refuses a buy over it with 400 and names the limit', async () => {
    mockKyber(6_000);
    await expect(quoteSwap(req('SONYc', 'buy', 6_000))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/limited to \$5,000 .*\$50,000/) });
  });

  it('refuses with 503 rather than guessing when the pool cannot be read', async () => {
    depth.usd = null;
    mockKyber(100);
    await expect(quoteSwap(req('SONYc', 'buy', 100))).rejects.toMatchObject({ status: 503 });
  });

  it('does not depth-cap a sell', async () => {
    mockKyber(20_000);
    await expect(quoteSwap(req('SONYc', 'sell', 20_000))).resolves.toMatchObject({ side: 'sell' });
  });

  it('leaves a deep pool to the $25k cap', async () => {
    depth.usd = 800_000;
    mockKyber(24_000);
    await expect(quoteSwap(req('NVDAc', 'buy', 24_000))).resolves.toMatchObject({ side: 'buy' });
    mockKyber(26_000);
    await expect(quoteSwap(req('NVDAc', 'buy', 26_000))).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/\$25,000/) });
  });
});

describe('route checks', () => {
  it('refuses a route that names another router', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ code: 0, data: { routerAddress: '0x2222222222222222222222222222222222222222', routeSummary: {} } }))),
    );
    await expect(quoteSwap(req('NVDAc', 'buy', 100))).rejects.toThrow(/unexpected router/);
  });

  it('refuses a route for a different amount than asked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const q = new URL(url).searchParams;
        return new Response(
          JSON.stringify({
            code: 0,
            data: {
              routerAddress: KYBER_ROUTER,
              routeSummary: { tokenIn: q.get('tokenIn'), tokenOut: q.get('tokenOut'), amountIn: '1', amountOut: '1', amountInUsd: '1', route: [] },
            },
          }),
        );
      }),
    );
    await expect(quoteSwap(req('NVDAc', 'buy', 100))).rejects.toThrow(/does not match the request/);
  });
});

// All addresses below were verified on-chain against Base mainnet (eth_call for
// decimals()/token0()/token1()/tickSpacing()/fee()) and cross-checked against
// Dexscreener's Aerodrome pair listings on 2026-09-04. Do not add a symbol here
// without doing the same verification — this file is the trust boundary for
// what the UI is allowed to point a user's wallet at.

export const USDC = {
  symbol: 'USDC',
  address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const,
  decimals: 6,
};

export interface CbStock {
  /** Onchain symbol, e.g. "NVDAc" */
  symbol: string;
  /** Underlying cash-market ticker, e.g. "NVDA" */
  cashTicker: string;
  /** Company name for display */
  name: string;
  /** B20 token contract address on Base */
  tokenAddress: `0x${string}`;
  decimals: number;
  /** Aerodrome Slipstream (concentrated liquidity) pool paired with USDC */
  pool: {
    address: `0x${string}`;
    /** token0 in the pool contract (Aerodrome sorts by address) */
    token0: 'USDC' | 'stock';
    tickSpacing: number;
    /** fee in hundredths of a bip (e.g. 500 = 0.05%) */
    feePpm: number;
  };
}

// NOTE: This custom CL factory (0xf8f2eb4940cfe7d13603dddd87f123820fc061ef) is
// NOT the same factory Aerodrome's documented public Quoter/SwapRouter point to
// (that one is 0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a). The standard
// Aerodrome Quoter reverts on these pools. Because of that we never attempt to
// route or quote a guaranteed swap ourselves — we read slot0()/liquidity()
// directly for an honest *local* price/impact estimate, and hand off every
// actual trade to Aerodrome's own app, which knows how to route through
// whatever infra these pools actually use.
export const STOCKS: CbStock[] = [
  {
    symbol: 'NVDAc',
    cashTicker: 'NVDA',
    name: 'NVIDIA Corporation',
    tokenAddress: '0xb20000000000000000000078ee7ce2fE4908108C',
    decimals: 8,
    pool: {
      address: '0x853F5f1B92b16714Fe6CDA67CAad0856B83C7ab9',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'AAPLc',
    cashTicker: 'AAPL',
    name: 'Apple Inc.',
    tokenAddress: '0xb200000000000000000000C2e324d24d7eEcd1fb',
    decimals: 8,
    pool: {
      address: '0xA3b1E3f9747065e2073722Ff4c9027d3eA4994F0',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'METAc',
    cashTicker: 'META',
    name: 'Meta Platforms Inc.',
    tokenAddress: '0xb2000000000000000000008bC8786B856E61707C',
    decimals: 8,
    pool: {
      address: '0xEAF57753BC382E0324a1D43F72E7027705a2273E',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'GOOGLc',
    cashTicker: 'GOOGL',
    name: 'Alphabet Inc.',
    tokenAddress: '0xb2000000000000000000002D0BA3164cc74f58B7',
    decimals: 8,
    pool: {
      address: '0xB1987CAD1682841b4b641d50E520777eC5Ab5542',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
];

export function getStock(symbol: string): CbStock | undefined {
  return STOCKS.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase());
}

// Official Aerodrome app — every execution deep link points here. We never
// construct our own router calldata.
export const AERODROME_SWAP_BASE = 'https://aerodrome.finance/swap';

export function aerodromeSwapUrl(stock: CbStock): string {
  const params = new URLSearchParams({
    from: USDC.address,
    to: stock.tokenAddress,
  });
  return `${AERODROME_SWAP_BASE}?${params.toString()}`;
}

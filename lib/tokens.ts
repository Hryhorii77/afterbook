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

// NOTE: This custom CL factory is NOT the same factory Aerodrome's documented
// public Quoter/SwapRouter point to (that one is
// 0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a). The standard Aerodrome Quoter
// reverts on these pools. Because of that we never attempt to route or quote
// a guaranteed swap ourselves — we read slot0()/liquidity() directly for an
// honest *local* price/impact estimate, and hand off every actual trade to
// Aerodrome's own app, which knows how to route through whatever infra these
// pools actually use. Confirmed by loading Aerodrome's own "New deposit" page
// for USDC/NVDAc in a browser and reading the factory param off the URL it
// generated — it matches exactly.
export const CL_FACTORY = '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef' as const;
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
  // Added 2026-09-05 when Base expanded from 4 to 10 tokenized stocks.
  // Verified the same way as the original four: decimals()/token0()/
  // tickSpacing()/fee()/factory() on-chain, cross-checked against
  // Dexscreener's Aerodrome pair listing. All six share the exact same CL
  // factory, fee tier (500 = 0.05%), and tick spacing (10) as the original
  // four — same deployment pattern. Liquidity on these is much thinner
  // ($10k-$110k vs $1-2M on the original four) since they're freshly listed;
  // expect largeTradeCaveat to trip at far smaller sizes.
  {
    symbol: 'AMZNc',
    cashTicker: 'AMZN',
    name: 'Amazon.com, Inc.',
    tokenAddress: '0xb200000000000000000000d9192b6B456483C2E8',
    decimals: 8,
    pool: {
      address: '0xd03Bc8C7F2FAedCe2aac81bF0444AEA08Ea06E9b',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'MSFTc',
    cashTicker: 'MSFT',
    name: 'Microsoft Corporation',
    tokenAddress: '0xB200000000000000000000Ab99cFa739E253872B',
    decimals: 8,
    pool: {
      address: '0x7103eB3c9590d1281f7dc03b2A9EE27C39dF5D54',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'MSTRc',
    cashTicker: 'MSTR',
    name: 'Strategy Inc',
    tokenAddress: '0xb2000000000000000000004884b426556b92883d',
    decimals: 8,
    pool: {
      address: '0x8b27f626ab668197000BC722A1012022CAeD10E2',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'SNDKc',
    cashTicker: 'SNDK',
    name: 'Sandisk Corporation',
    tokenAddress: '0xb200000000000000000000397293Cb8cda9a10c5',
    decimals: 8,
    pool: {
      address: '0x5A8236f575471e7BfCA2C8462a200c28f737246E',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  // SpaceX (Space Exploration Technologies Corp.) — verified it actually
  // trades as SPCX on Nasdaq (multiple independent sources agree; this is
  // recent enough news to be worth double-checking, not assumed).
  {
    symbol: 'SPCXc',
    cashTicker: 'SPCX',
    name: 'Space Exploration Technologies Corp.',
    tokenAddress: '0xb2000000000000000000007b9fcbd005511aCBd5',
    decimals: 8,
    pool: {
      address: '0x0bf58fe0FAc935Ac69595c19B12Ba0d75E3F8c0E',
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'TSLAc',
    cashTicker: 'TSLA',
    name: 'Tesla, Inc.',
    tokenAddress: '0xb2000000000000000000001e800a7f5189430cD0',
    decimals: 8,
    pool: {
      address: '0x469337fDcc5E8f38e2E4B670B04F57865D13a7BB',
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
// construct our own router calldata. Both URL shapes below were verified by
// clicking through Aerodrome's own UI in a real browser and reading off the
// exact params it generates for these pools, not guessed.
const BASE_CHAIN_ID = '8453';

export function aerodromeSwapUrl(stock: CbStock): string {
  const params = new URLSearchParams({
    from: USDC.address,
    to: stock.tokenAddress,
    chain0: BASE_CHAIN_ID,
    chain1: BASE_CHAIN_ID,
  });
  return `https://aerodrome.finance/swap?${params.toString()}`;
}

export function aerodromeDepositUrl(stock: CbStock): string {
  const params = new URLSearchParams({
    token0: USDC.address,
    token1: stock.tokenAddress,
    type: String(stock.pool.tickSpacing),
    chain0: BASE_CHAIN_ID,
    chain1: BASE_CHAIN_ID,
    factory: CL_FACTORY,
  });
  return `https://aerodrome.finance/deposit?${params.toString()}`;
}

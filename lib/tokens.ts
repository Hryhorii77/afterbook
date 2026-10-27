// All addresses below were verified on-chain against Base mainnet (eth_call for
// decimals()/token0()/token1()/tickSpacing()/fee()) and cross-checked against
// Dexscreener's Aerodrome pair listings on 2026-09-04; all 38 re-verified on 2026-10-27 (each pool's
// factory(), token0/1, tickSpacing and fee, plus the factory's getPool returning it) when the
// tracked stocks moved to their Aero pools and 26 more were added. Do not add a symbol here
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
  /** The stock's deepest Slipstream (concentrated liquidity) pool paired with USDC */
  pool: {
    address: `0x${string}`;
    /** The CL factory that made it: Aero's (most stocks since Aerodrome became Aero, 2026-10-22) or
     *  the older Aerodrome one. Lot Lab's LP link, My Lots and the gauge reads depend on which. */
    factory: typeof AERO_CL_FACTORY | typeof CL_FACTORY;
    /** token0 in the pool contract (Aerodrome sorts by address) */
    token0: 'USDC' | 'stock';
    tickSpacing: number;
    /** Fee in hundredths of a bip (e.g. 500 = 0.05%). Aero pools charge a dynamic fee: readPoolState
     *  reads the live one (PoolState.feePpm) and this is only the fallback (their 0.05% ceiling). */
    feePpm: number;
  };
}

// NOTE: This custom CL factory is NOT the same factory Aerodrome's documented
// public Quoter/SwapRouter point to (that one is
// 0x5e7bb104d84c7cb9b682aac2f3d509f5f406809a). The standard Aerodrome Quoter
// reverts on these pools. Because of that we never attempt to route or quote
// a guaranteed swap ourselves — we read slot0()/liquidity() directly for an
// honest *local* price/impact estimate. Actual trades go either to
// Aerodrome's own app (the deep links below) or through KyberSwap's
// aggregator (lib/swap.ts), which routes through these pools itself. Confirmed by loading Aerodrome's own "New deposit" page
// for USDC/NVDAc in a browser and reading the factory param off the URL it
// generated — it matches exactly.
export const CL_FACTORY = '0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef' as const;
// Aero's CL factory (Aerodrome and Velodrome became Aero on 2026-10-22; address from Aero's own
// dromos-labs/metadex-slipstream-public deployment-addresses/cl-base.json). By 2026-10-27 every
// tracked stock was deeper here than on CL_FACTORY (METAc $933k vs $146k) and did most of its
// volume here, so each stock points at its deepest pool of either factory. Same pool interface
// (slot0, liquidity, ticks, fee), but a dynamic fee and no Sugar or old-AERO gauge data.
export const AERO_CL_FACTORY = '0x9CB220581b91b0C83223012FE69688b92aD07a76' as const;
// Aero's Slipstream position manager (same file): My Lots reads Aero LP positions from it.
export const AERO_POSITION_MANAGER = '0x4857DB576eE0e45F10525eC59527BfD10beeC60b' as const;
export const STOCKS: CbStock[] = [
  {
    symbol: 'NVDAc',
    cashTicker: 'NVDA',
    name: 'NVIDIA Corporation',
    tokenAddress: '0xb20000000000000000000078ee7ce2fE4908108C',
    decimals: 8,
    pool: {
      address: '0xF668e21993f0ACd7ab00BB1cFbAeD0df28A3C8EC',
      factory: AERO_CL_FACTORY,
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
      address: '0xF5FCB9CDAFcE67d50AfEf298F88E709d2B946BA6',
      factory: AERO_CL_FACTORY,
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
      address: '0xd072410fa13D242e1d53721Bcf7AF02e3455DC96',
      factory: AERO_CL_FACTORY,
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
      address: '0x16c70F04C3080a127486Cdf5a4C33c066bBF47C3',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'AMZNc',
    cashTicker: 'AMZN',
    name: 'Amazon.com, Inc.',
    tokenAddress: '0xb200000000000000000000d9192b6B456483C2E8',
    decimals: 8,
    pool: {
      address: '0x532e0F46d1e528507FC9454d5847C231f23bDDf6',
      factory: AERO_CL_FACTORY,
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
      address: '0x2740C0faAb738F6e346e545fDE02aEF9B1A01ee7',
      factory: AERO_CL_FACTORY,
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
      address: '0x66DCd42E6314B287110922AE36cB2a8bdEECc153',
      factory: AERO_CL_FACTORY,
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
      address: '0x2836e062a3fe75943a7F4A552E2365b98E414E75',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'SPCXc',
    cashTicker: 'SPCX',
    name: 'Space Exploration Technologies Corp.',
    tokenAddress: '0xb2000000000000000000007b9fcbd005511aCBd5',
    decimals: 8,
    pool: {
      address: '0x880dB7Dda4407D99508574E680d067D1164B3cFE',
      factory: AERO_CL_FACTORY,
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
      address: '0x7A33000372f3F028f074182CCb9d16cBEEfBF920',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'PLTRc',
    cashTicker: 'PLTR',
    name: 'Palantir Technologies Inc.',
    tokenAddress: '0xb2000000000000000000007d16372840dF4dAbbe',
    decimals: 8,
    pool: {
      address: '0xA0473ceD0cd1bfB857e3E04B5FA4b6aF18C5e44d',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'MUc',
    cashTicker: 'MU',
    name: 'Micron Technology Inc.',
    tokenAddress: '0xb200000000000000000000Fd2f87532B90095211',
    decimals: 8,
    pool: {
      address: '0x41e21950362B1014bC629252ecFFF8fcA5F1646C',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'NFLXc',
    cashTicker: 'NFLX',
    name: 'Netflix, Inc.',
    tokenAddress: '0xb20000000000000000000058B8c947e44011dFE6',
    decimals: 8,
    pool: {
      address: '0x67Ba8dBeDC6D7f93f0F5967Aa2420715f1edC756',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'SKHYc',
    cashTicker: 'SKHY',
    name: 'SK hynix Inc.',
    tokenAddress: '0xb200000000000000000000187f7071D6E321a7d2',
    decimals: 8,
    pool: {
      address: '0xEBC746A47ebb274de1dbDC9a465E6C5C2301C5DA',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'HIMSc',
    cashTicker: 'HIMS',
    name: 'Hims & Hers Health, Inc.',
    tokenAddress: '0xB20000000000000000000043a599976181Bcf336',
    decimals: 8,
    pool: {
      address: '0x41D7793FAa4Ca181B6f021423fF3F9015C00b2ff',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'ORCLc',
    cashTicker: 'ORCL',
    name: 'Oracle Corporation',
    tokenAddress: '0xb200000000000000000000347AFbA223D7B6b63C',
    decimals: 8,
    pool: {
      address: '0x62B5452E80E50B047dcF6dd3Fb6a1D266C678eB5',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'AMDc',
    cashTicker: 'AMD',
    name: 'Advanced Micro Devices, Inc.',
    tokenAddress: '0xB2000000000000000000000d8Ce462E99ee7A47B',
    decimals: 8,
    pool: {
      address: '0x138Cb591C4A7D854D796E1906af8228d84CB7642',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'AVGOc',
    cashTicker: 'AVGO',
    name: 'Broadcom Inc.',
    tokenAddress: '0xB200000000000000000000Fc737aeA6196aB5a4c',
    decimals: 8,
    pool: {
      address: '0x086A1447D0851F0aeA9D09D6c547fEC8E97be413',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'LLYc',
    cashTicker: 'LLY',
    name: 'Eli Lilly and Company',
    tokenAddress: '0xB200000000000000000000f1a0F91e34892E4718',
    decimals: 8,
    pool: {
      address: '0x2b7ee4623ec6AfbC1e587b2668c0ED8F3ff44949',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'MRVLc',
    cashTicker: 'MRVL',
    name: 'Marvell Technology, Inc.',
    tokenAddress: '0xB200000000000000000000eC3c4c7395Cc609813',
    decimals: 8,
    pool: {
      address: '0x611ab290422d534D9595b01e648911fefA963137',
      factory: AERO_CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 10,
      feePpm: 500,
    },
  },
  {
    symbol: 'SONYc',
    cashTicker: 'SONY',
    name: 'Sony Group Corporation',
    tokenAddress: '0xb200000000000000000000a26326a922FFA87f6C',
    decimals: 8,
    pool: {
      address: '0x26Dd2AC81eA9a212afC84848893EdC21c5A76FDC',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'BILIc',
    cashTicker: 'BILI',
    name: 'Bilibili Inc.',
    tokenAddress: '0xb200000000000000000000ca7C6D1438e7245eb6',
    decimals: 8,
    pool: {
      address: '0x32A3cE6C3a8D6c24C4A51A5cF2869410CbF4D637',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'SAPc',
    cashTicker: 'SAP',
    name: 'SAP SE',
    tokenAddress: '0xb200000000000000000000da6F64c306234127E0',
    decimals: 8,
    pool: {
      address: '0x21313A06B7f8ed38D8bC1fb8Be2fBD847634A6ec',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'SANc',
    cashTicker: 'SAN',
    name: 'Banco Santander, S.A.',
    tokenAddress: '0xB20000000000000000000017BB66E9301E913A99',
    decimals: 8,
    pool: {
      address: '0xE531069DF73530bf59c954F3718945D5fAA2e7dF',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'NOKc',
    cashTicker: 'NOK',
    name: 'Nokia Oyj',
    tokenAddress: '0xB2000000000000000000005ac674f707E357409c',
    decimals: 8,
    pool: {
      address: '0xc541eAc49f32D46C1E2f88952f22215Ef0f2Db71',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'PDDc',
    cashTicker: 'PDD',
    name: 'PDD Holdings Inc.',
    tokenAddress: '0xB200000000000000000000c8A7223510467D8563',
    decimals: 8,
    pool: {
      address: '0x84608BE6d655ee05032303FE7f0D6F3A51c2CF51',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'LIc',
    cashTicker: 'LI',
    name: 'Li Auto Inc.',
    tokenAddress: '0xb200000000000000000000D61eFD9F54A23ef9eB',
    decimals: 8,
    pool: {
      address: '0xD71b2D9cB3532477Df77AE26e780963CCe784a0c',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'BIDUc',
    cashTicker: 'BIDU',
    name: 'Baidu, Inc.',
    tokenAddress: '0xb200000000000000000000d2b7D9aeE52F6C6BEf',
    decimals: 8,
    pool: {
      address: '0xD47b8F13ffC3198148B138D3f07CC89C92042950',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'VALEc',
    cashTicker: 'VALE',
    name: 'Vale S.A.',
    tokenAddress: '0xB20000000000000000000063376b142C0764B489',
    decimals: 8,
    pool: {
      address: '0x0F48336b76ee52Fa6bb19edf5AF358529Df57574',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'BUDc',
    cashTicker: 'BUD',
    name: 'Anheuser-Busch InBev SA/NV',
    tokenAddress: '0xB200000000000000000000c36ce081Dd09e86cA2',
    decimals: 8,
    pool: {
      address: '0x5ee52963d3d33196a47Fad722ABB897E0FA395d9',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'NIOc',
    cashTicker: 'NIO',
    name: 'NIO Inc.',
    tokenAddress: '0xb2000000000000000000002D2B5dc53c61f1bA06',
    decimals: 8,
    pool: {
      address: '0x484cc2CA594ced3fE38362FE950C60cE66f53F6D',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'ARMc',
    cashTicker: 'ARM',
    name: 'Arm Holdings plc',
    tokenAddress: '0xB20000000000000000000026215D755356E5043f',
    decimals: 8,
    pool: {
      address: '0x9A0F4Fd0766Ccdb792bA58fE631aA7720097623c',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'INFYc',
    cashTicker: 'INFY',
    name: 'Infosys Limited',
    tokenAddress: '0xb200000000000000000000F6b0417af5F52341FC',
    decimals: 8,
    pool: {
      address: '0x356cC16Fe38A6ad0eB25e655759dD963F8D674BF',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'ULc',
    cashTicker: 'UL',
    name: 'Unilever PLC',
    tokenAddress: '0xB200000000000000000000349ef3Aa93a0897476',
    decimals: 8,
    pool: {
      address: '0x013FCB940735d17c81D3B91557aCC62Da723d9D5',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'WRDc',
    cashTicker: 'WRD',
    name: 'WeRide Inc.',
    tokenAddress: '0xb200000000000000000000e88EFe88D8aDE3f0dA',
    decimals: 8,
    pool: {
      address: '0xbc440AFf9A79cCed69d5B21c7B71e60BD0278EFB',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'NVOc',
    cashTicker: 'NVO',
    name: 'Novo Nordisk A/S',
    tokenAddress: '0xb2000000000000000000008D5328e9208773dC58',
    decimals: 8,
    pool: {
      address: '0xc1ba39D668F14Eee2462CA5877402e4a7c4d1f34',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'SEc',
    cashTicker: 'SE',
    name: 'Sea Limited',
    tokenAddress: '0xB2000000000000000000003088798F6d0722AaAC',
    decimals: 8,
    pool: {
      address: '0x0274e5078033cB3fE788cf76bb97150FD9bc4547',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
  {
    symbol: 'HSAIc',
    cashTicker: 'HSAI',
    name: 'Hesai Group',
    tokenAddress: '0xb200000000000000000000f3049F4aa834b23b64',
    decimals: 8,
    pool: {
      address: '0xDc8D2C31de17bf4dF00C05E4E132BCEA22F24c3b',
      factory: CL_FACTORY,
      token0: 'USDC',
      tickSpacing: 1,
      feePpm: 100,
    },
  },
];

export function getStock(symbol: string): CbStock | undefined {
  return STOCKS.find((s) => s.symbol.toLowerCase() === symbol.toLowerCase());
}

/** What a person types: the on-chain symbol ("NVDAc") or the plain ticker ("NVDA"), any case. */
export function findStock(input: string): CbStock | undefined {
  const q = input.trim().toLowerCase();
  return STOCKS.find((s) => s.symbol.toLowerCase() === q) ?? STOCKS.find((s) => s.cashTicker.toLowerCase() === q);
}

// Official Aerodrome app — every Aerodrome deep link points here (in-app swaps
// are KyberSwap's calldata, checked in lib/swap.ts). Both URL shapes below were verified by
// clicking through Aerodrome's own UI in a real browser and reading off the
// exact params it generates for these pools, not guessed.
const BASE_CHAIN_ID = '8453';

// direction 'sell' reverses from/to — for the Carry tab's inventory-unwind
// side, where the deep link needs to sell the stock token for USDC rather
// than the default buy.
export function aerodromeSwapUrl(stock: CbStock, direction: 'buy' | 'sell' = 'buy'): string {
  const params = new URLSearchParams({
    from: direction === 'buy' ? USDC.address : stock.tokenAddress,
    to: direction === 'buy' ? stock.tokenAddress : USDC.address,
    chain0: BASE_CHAIN_ID,
    chain1: BASE_CHAIN_ID,
  });
  return `https://aerodrome.finance/swap?${params.toString()}`;
}

// An Aero pool's own deposit page (the shape Aero's pool list links to, read off app.aero.xyz on
// 2026-10-27); a pool on the older factory keeps Aerodrome's "New deposit" link.
export function aerodromeDepositUrl(stock: CbStock): string {
  if (stock.pool.factory === AERO_CL_FACTORY) return `https://app.aero.xyz/deposit/${BASE_CHAIN_ID}-${stock.pool.address}`;
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

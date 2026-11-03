// In-app borrowing on Aave V4's MAG7 spoke (the Equities Hub's one USDC pool lent against Coinbase
// stock tokens). Pure and browser-safe: addresses, ABI fragments, the health maths and the calls a
// wallet is asked to sign. Real money: see the real-money-reviewer rules before changing anything.
//
// Verified 2026-11-03 against the deployed source: the spoke 0x1790…7B8D is an EIP-1967 proxy whose
// implementation 0x81a7…3b19 has a full Sourcify match (src/spoke/instances/SpokeInstance.sol, solc
// 0.8.28, aave/aave-v4). From that source:
// - supply/repay pull tokens with safeTransferFrom(msg.sender, hub, amount) inside the spoke, so the
//   approval spender is the SPOKE (never the hub);
// - borrow/withdraw pay msg.sender; every action requires onBehalfOf == msg.sender (or an approved
//   position manager, which we never set up);
// - supplying does not make a reserve collateral: setUsingAsCollateral(reserveId, true, user) does;
// - repay caps `amount` at the debt and pulls only what is owed;
// - multicall delegatecalls the spoke itself, so msg.sender stays the user;
// - health factor = Σ(collateral value × collateral factor) / debt, liquidatable below 1.0.

import { encodeFunctionData, getAddress, parseAbi } from 'viem';

export const AAVE_EQUITIES_HUB = '0xa4d5947Eb727A052bae69C593FfC84247EC9864E' as const;
export const AAVE_MAG7_SPOKE = '0x17905Db0e4A3514467539956c084180616AE7B8D' as const;

/** Largest USDC borrow per action (owner, 2026-11-03: same as a swap). */
export const MAX_BORROW_USD = 25_000;
/** "Max" stops this far short of the protocol limit (owner: borrow up to the protocol limit), only so
 *  the transaction does not revert on a price tick or a few minutes of interest before it is mined. */
export const LIMIT_MARGIN = 0.005;
/** A full repay approves the debt plus this share (about a day of interest at today's ~3.6%) plus one
 *  unit, because interest accrues between the read and the block; repay pulls only what is owed. */
export const REPAY_ALL_BUFFER_BPS = 1;

export const SPOKE_ABI = parseAbi([
  'struct Reserve { address underlying; address hub; uint16 assetId; uint8 decimals; uint24 collateralRisk; uint8 flags; uint32 dynamicConfigKey; }',
  'struct ReserveConfig { uint24 collateralRisk; bool paused; bool frozen; bool borrowable; bool receiveSharesEnabled; }',
  'struct UserAccountData { uint256 riskPremium; uint256 avgCollateralFactor; uint256 healthFactor; uint256 totalCollateralValue; uint256 totalDebtValueRay; uint256 activeCollateralCount; uint256 borrowCount; }',
  'function getReserve(uint256 reserveId) view returns (Reserve)',
  'function getReserveConfig(uint256 reserveId) view returns (ReserveConfig)',
  'function getUserReserveStatus(uint256 reserveId, address user) view returns (bool, bool)',
  'function getUserSuppliedAssets(uint256 reserveId, address user) view returns (uint256)',
  'function getUserTotalDebt(uint256 reserveId, address user) view returns (uint256)',
  'function getUserAccountData(address user) view returns (UserAccountData)',
  'function ORACLE() view returns (address)',
  'function supply(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  'function withdraw(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  'function borrow(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  'function repay(uint256 reserveId, uint256 amount, address onBehalfOf) returns (uint256, uint256)',
  'function setUsingAsCollateral(uint256 reserveId, bool usingAsCollateral, address onBehalfOf)',
  'function multicall(bytes[] data) returns (bytes[])',
]);
export const AAVE_ORACLE_ABI = parseAbi(['function getReservesPrices(uint256[] reserveIds) view returns (uint256[])']);
/** The spoke's oracle answers in 8 decimals. */
export const AAVE_PRICE_DECIMALS = 8;

/** One reserve as the panel knows it: a stock (collateral) or USDC (what is borrowed). */
export interface AaveReserve {
  reserveId: number;
  symbol: string;
  token: `0x${string}`;
  decimals: number;
  /** Collateral factor today (0..1); 0 for USDC. */
  collateralFactor: number;
}

/** What one wallet has on the spoke, from chain reads. */
export interface AavePosition {
  /** Per stock reserve: supplied tokens (raw), whether it counts as collateral, oracle USD price. */
  collateral: { reserve: AaveReserve; suppliedRaw: bigint; enabled: boolean; priceUsd: number }[];
  /** USDC owed (raw, 6 decimals), interest and premium included. */
  debtRaw: bigint;
  /** The spoke oracle's USDC price: Aave values the debt at it, not at $1 (default 1). */
  usdcPriceUsd?: number;
}

const toNum = (raw: bigint, decimals: number) => Number(raw) / 10 ** decimals;

/** Σ value × collateral factor over the reserves that count as collateral, in USD. */
export function borrowPowerUsd(pos: AavePosition): number {
  return pos.collateral.reduce((s, c) => s + (c.enabled ? toNum(c.suppliedRaw, c.reserve.decimals) * c.priceUsd * c.reserve.collateralFactor : 0), 0);
}

export function debtUsd(pos: AavePosition): number {
  return toNum(pos.debtRaw, 6) * (pos.usdcPriceUsd ?? 1);
}

/** Health factor (Infinity with no debt). Below 1.0 the position can be liquidated. */
export function healthFactor(pos: AavePosition): number {
  const debt = debtUsd(pos);
  return debt > 0 ? borrowPowerUsd(pos) / debt : Infinity;
}

/** How far every collateral price can fall together before liquidation (0..1), or null with no debt. */
export function fallToLiquidation(pos: AavePosition): number | null {
  const hf = healthFactor(pos);
  return Number.isFinite(hf) ? Math.max(0, 1 - 1 / hf) : null;
}

/** The position after adding `addRaw` of one stock as collateral and borrowing `borrowRaw` USDC. */
export function withChange(pos: AavePosition, change: { reserveId?: number; addRaw?: bigint; withdrawRaw?: bigint; borrowRaw?: bigint; repayRaw?: bigint }): AavePosition {
  const collateral = pos.collateral.map((c) => {
    if (c.reserve.reserveId !== change.reserveId) return c;
    const supplied = c.suppliedRaw + (change.addRaw ?? BigInt(0)) - (change.withdrawRaw ?? BigInt(0));
    // Adding collateral turns the reserve on as collateral (the panel always sends setUsingAsCollateral).
    return { ...c, suppliedRaw: supplied > BigInt(0) ? supplied : BigInt(0), enabled: c.enabled || (change.addRaw ?? BigInt(0)) > BigInt(0) };
  });
  const debt = pos.debtRaw + (change.borrowRaw ?? BigInt(0)) - (change.repayRaw ?? BigInt(0));
  return { collateral, debtRaw: debt > BigInt(0) ? debt : BigInt(0), usdcPriceUsd: pos.usdcPriceUsd };
}

/** Most USDC (raw) this position can borrow now: the protocol limit less LIMIT_MARGIN, at most
 *  MAX_BORROW_USD and what the pool has left. */
export function maxBorrowRaw(pos: AavePosition, poolLiquidityUsd: number): bigint {
  // Room in USD value, turned into USDC at the oracle's USDC price (Aave values new debt at it too).
  const room = (borrowPowerUsd(pos) * (1 - LIMIT_MARGIN) - debtUsd(pos)) / (pos.usdcPriceUsd ?? 1);
  const usdc = Math.min(room, MAX_BORROW_USD, poolLiquidityUsd);
  return usdc > 0 ? BigInt(Math.floor(usdc * 1e6)) : BigInt(0);
}

/** Most of one stock (raw) that can be withdrawn while the position stays within the limit. */
export function maxWithdrawRaw(pos: AavePosition, reserveId: number): bigint {
  const c = pos.collateral.find((x) => x.reserve.reserveId === reserveId);
  if (!c || c.suppliedRaw === BigInt(0)) return BigInt(0);
  const debt = debtUsd(pos);
  if (debt === 0 || !c.enabled) return c.suppliedRaw;
  const perToken = c.priceUsd * c.reserve.collateralFactor;
  if (perToken <= 0) return BigInt(0);
  const spareUsd = borrowPowerUsd(pos) * (1 - LIMIT_MARGIN) - debt;
  if (spareUsd <= 0) return BigInt(0);
  const tokens = spareUsd / (1 - LIMIT_MARGIN) / perToken;
  const raw = BigInt(Math.floor(tokens * 10 ** c.reserve.decimals));
  return raw < c.suppliedRaw ? raw : c.suppliedRaw;
}

/** USDC to approve for "repay all": the debt plus REPAY_ALL_BUFFER_BPS plus one unit. */
export function repayAllApproval(debtRaw: bigint): bigint {
  return debtRaw + (debtRaw * BigInt(REPAY_ALL_BUFFER_BPS)) / BigInt(10_000) + BigInt(1);
}

export const MAX_UINT256 = BigInt(2) ** BigInt(256) - BigInt(1);

/** The one transaction that adds collateral and/or borrows: supply, setUsingAsCollateral (when the
 *  stock is not collateral yet), borrow, batched with the spoke's own multicall. Always onBehalfOf =
 *  the account that signs. */
export function borrowCalls(account: `0x${string}`, opts: { stock?: AaveReserve; addRaw?: bigint; enableCollateral?: boolean; usdc: AaveReserve; borrowRaw?: bigint }): `0x${string}`[] {
  const who = getAddress(account);
  const calls: `0x${string}`[] = [];
  const add = opts.addRaw ?? BigInt(0);
  if (opts.stock && add > BigInt(0)) {
    calls.push(encodeFunctionData({ abi: SPOKE_ABI, functionName: 'supply', args: [BigInt(opts.stock.reserveId), add, who] }));
    if (opts.enableCollateral) calls.push(encodeFunctionData({ abi: SPOKE_ABI, functionName: 'setUsingAsCollateral', args: [BigInt(opts.stock.reserveId), true, who] }));
  }
  const borrow = opts.borrowRaw ?? BigInt(0);
  if (borrow > BigInt(0)) calls.push(encodeFunctionData({ abi: SPOKE_ABI, functionName: 'borrow', args: [BigInt(opts.usdc.reserveId), borrow, who] }));
  return calls;
}

// ---- Lending: deposit USDC into the same pool the loans borrow from (owner, 2026-11-03).
// Verified in the same deployed source: supply pulls from msg.sender into the hub and never turns the
// reserve on as collateral (USDC's collateral factor on this spoke is 0 anyway); withdraw pays
// msg.sender, takes at most what the wallet has supplied, and runs the health check only for a reserve
// used as collateral, so lending never touches a loan's health. A withdrawal can only take what the hub
// has free: when borrowers have drawn most of the pool it reverts until loans are repaid.

/** Largest USDC deposit per action (owner, 2026-11-03: same as a swap and a borrow). */
export const MAX_LEND_USD = 25_000;

export const HUB_ABI = parseAbi(['function getAssetLiquidity(uint256 assetId) view returns (uint256)']);

/** Most USDC (raw) a lender can take out now: what they supplied, at most what the pool has free. */
export function maxLendWithdrawRaw(suppliedRaw: bigint, poolLiquidityRaw: bigint): bigint {
  return suppliedRaw < poolLiquidityRaw ? suppliedRaw : poolLiquidityRaw;
}

/** Free pool USDC a MAX withdrawal must leave spare (0.1% of the deposit plus one dollar), so interest
 *  added since the read or a small draw by borrowers doesn't make it revert. */
const MAX_WITHDRAW_SPARE = (suppliedRaw: bigint) => suppliedRaw / BigInt(1000) + BigInt(1_000_000);

/** The withdraw amount to send: MAX_UINT256 ("everything, interest included up to the block") when the
 *  lender takes all they have and the pool can comfortably pay it, else the exact amount. */
export function lendWithdrawArg(amountRaw: bigint, suppliedRaw: bigint, poolLiquidityRaw: bigint): bigint {
  return amountRaw >= suppliedRaw && suppliedRaw + MAX_WITHDRAW_SPARE(suppliedRaw) <= poolLiquidityRaw ? MAX_UINT256 : amountRaw;
}

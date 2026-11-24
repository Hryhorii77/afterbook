// The USDC a Base Account wallet should keep for its network fee (2026-11-25): Base Account takes the fee in USDC
// from the same wallet after the calls run, on one-signature and two-step sends alike, so spending the whole
// balance can pass the dry run and still fail. About 1–2 cents a transaction on 2026-11-24; 5 cents leaves room.
// Pure, for the panels and the tests.

/** 0.05 USDC (raw, 6 decimals). */
export const USDC_FEE_RESERVE_RAW = BigInt(50_000);

/** What a USDC Max may spend from `balance` when the wallet pays its fee in USDC: never below zero. */
export const afterFeeReserve = (balance: bigint) => (balance > USDC_FEE_RESERVE_RAW ? balance - USDC_FEE_RESERVE_RAW : BigInt(0));

/** Whether spending `spend` of `balance` leaves less than the reserve (and isn't already over the balance, which
 *  has its own message). */
export const leavesNoFeeRoom = (spend: bigint, balance: bigint) => spend > BigInt(0) && spend <= balance && spend + USDC_FEE_RESERVE_RAW > balance;

export const FEE_RESERVE_NOTE = 'Base Account takes its network fee in USDC from this wallet: leave about $0.05 of USDC so this can go through.';

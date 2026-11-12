import { Attribution } from 'ox/erc8021';

// Afterbook's Base Builder Code (ERC-8021, registered at base.dev; public by design). Appended to the
// calldata of every transaction this app asks a wallet to send, so Base can attribute the activity to
// Afterbook. Contracts ignore the extra bytes (about 29 bytes, ~464 gas). Every call site that asks a
// wallet to send a transaction passes it (10 call sites as of 2026-11-12): the swap hook's exact approval
// (useSwapWallet.ts, also Portfolio's Revoke) and its swap (sent with sendTransaction, so the suffix
// is appended with concat; the stock, /build basket buy and sell, meme, /plan and /rules panels all
// use that hook); Aave lending's approval, supply and withdraw (AaveLendPanel.tsx); Aave borrowing's
// approval, multicall, repay and withdraw (AaveBorrowPanel.tsx); and the Baskets USDC deposit
// (BasketPanel.tsx). The Baskets signatures are messages, not transactions, and cannot carry it.
// Liquidity still happens on Aerodrome's own site.
//
// Passed per call as `dataSuffix` rather than through the wagmi config: a code set in
// createConfig is not applied to useWriteContract / useWalletClient transactions (wevm/wagmi #5248,
// open as of 2026-10). Any new transaction the app sends must pass it too.
export const BUILDER_CODE = 'bc_hebg61t4';
export const BUILDER_CODE_SUFFIX = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });

import { Attribution } from 'ox/erc8021';

// Afterbook's Base Builder Code (ERC-8021, registered at base.dev; public by design). Appended to the
// calldata of every transaction this app asks a wallet to send, so Base can attribute the activity to
// Afterbook. Contracts ignore the extra bytes (about 29 bytes, ~464 gas). The app sends three: the
// Baskets USDC deposit, and the exact approval and the swap in SwapPanel (the swap goes through
// sendTransaction, so the suffix is appended to its calldata with concat). Liquidity still happens
// on Aerodrome's own site and cannot carry it.
//
// Passed per call as `dataSuffix` rather than through the wagmi config: a code set in
// createConfig is not applied to useWriteContract / useWalletClient transactions (wevm/wagmi #5248,
// open as of 2026-10). Any new transaction the app sends must pass it too.
export const BUILDER_CODE = 'bc_hebg61t4';
export const BUILDER_CODE_SUFFIX = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });

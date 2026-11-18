// Smart accounts (Base Account / Coinbase Smart Wallet) don't send their own transactions: a bundler sends
// handleOps to an ERC-4337 EntryPoint, which runs the account's user operation. The bundler's transaction
// can succeed while the user operation inside it reverted (the owner's AMZNc sale on 2026-11-18 showed
// "sold" though nothing was sold), so a receipt's `status` alone doesn't say whether the person's call
// ran. `userOpOutcome` reads the EntryPoint's UserOperationEvent for the account from the receipt's own
// logs: no extra chain reads.
import { decodeEventLog, getAddress, type Hex } from 'viem';
import { entryPoint06Abi, entryPoint07Abi, entryPoint08Abi } from 'viem/account-abstraction';

/** ERC-4337 EntryPoints v0.6, v0.7, v0.8. */
export const ENTRY_POINTS = new Set(
  ['0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789', '0x0000000071727De22E5E9d8BAf0edAc6f37da032', '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108'].map((a) => getAddress(a)),
);
export const ENTRY_POINT_ABIS = [entryPoint06Abi, entryPoint07Abi, entryPoint08Abi] as const;

interface ReceiptLike {
  status: 'success' | 'reverted' | string;
  to?: `0x${string}` | null;
  logs?: readonly { address: `0x${string}`; data: Hex; topics: readonly Hex[] }[];
}

/**
 * What a mined transaction did for `account`:
 * - 'reverted' if the transaction reverted, or an EntryPoint reports the account's user operation failed;
 * - 'success' if it succeeded and, when it carries the account's user operation, that operation succeeded;
 * - 'unknown' if it went to an EntryPoint, or holds EntryPoint events, but none for the account (or the
 *   account isn't known), or the account has two operations in it with different results.
 */
export function userOpOutcome(receipt: ReceiptLike, account: `0x${string}` | undefined): 'success' | 'reverted' | 'unknown' {
  if (receipt.status !== 'success') return 'reverted';
  const me = account ? getAddress(account) : null;
  let ok = 0;
  let failed = 0;
  let others = 0;
  for (const log of receipt.logs ?? []) {
    if (!ENTRY_POINTS.has(getAddress(log.address))) continue;
    for (const abi of ENTRY_POINT_ABIS) {
      try {
        const e = decodeEventLog({ abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
        if (e.eventName === 'UserOperationEvent') {
          const a = e.args as { sender: string; success: boolean };
          if (me && getAddress(a.sender) === me) {
            if (a.success) ok++;
            else failed++;
          } else others++;
        }
        break;
      } catch {
        // another EntryPoint version's ABI, or another event
      }
    }
  }
  // Two operations of the same account in one bundle with different results: which was this one is
  // unknown (reading it as reverted could let a rule run buy twice).
  if (failed && ok) return 'unknown';
  if (failed) return 'reverted';
  if (ok) return 'success';
  // EntryPoint events, but none for this account (or no account), or a transaction to an EntryPoint at
  // all: whether the person's call ran can't be told from this receipt.
  const toEntryPoint = receipt.to ? ENTRY_POINTS.has(getAddress(receipt.to)) : false;
  return others > 0 || toEntryPoint ? 'unknown' : 'success';
}

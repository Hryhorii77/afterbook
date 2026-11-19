// The browser's own check of a Basis Tilt withdrawal before the wallet signs it. The EIP-712 data comes from Glider
// through our server, so a compromised server (or Glider) could otherwise hand over something else to sign: a
// withdrawal to another recipient or of other amounts, or another protocol's typed data altogether (a permit, or
// Kernel's own `Enable`). Pure; no server and no chain read.
//
// Pinned to Glider's real stage-1 answers (2026-11-19, `/v2/portfolios/{id}/withdraw/signature` for an enrolled
// test wallet; nothing signed): primaryType `Withdrawal`, domain {name "Glider Withdrawal Authorization", version
// "1" for a plain transfer or "2" with `liquidate`, chainId 8453, verifyingContract = the account being debited},
// and exactly the types below. A change on Glider's side fails closed until this file is updated from a real answer.
import { getAddress } from 'viem';

const BASE = 8453;
export const BASE_USDC_ASSET_ID = 'eip155:8453/erc20:0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const DOMAIN_NAME = 'Glider Withdrawal Authorization';
/** Glider gives 10 minutes. The window is wide on purpose: the recipient and amounts are pinned, so the expiry adds
 * little, and a device clock that is a few minutes off must not block a withdrawal. */
const MAX_VALIDITY_S = 60 * 60;
const CLOCK_SLACK_S = 5 * 60;

const ASSET_TYPE = [
  { name: 'assetId', type: 'string' },
  { name: 'amountRaw', type: 'string' },
];
const PLAIN_TYPE = [
  { name: 'portfolioId', type: 'string' },
  { name: 'recipientAccountId', type: 'string' },
  { name: 'assets', type: 'WithdrawalAsset[]' },
  { name: 'nonce', type: 'bytes32' },
  { name: 'expiresAt', type: 'uint256' },
];
const LIQUIDATE_TYPE = [...PLAIN_TYPE, { name: 'liquidate', type: 'bool' }, { name: 'settlementAssetId', type: 'string' }];

export interface WithdrawalAsk {
  /** The connected wallet: the only recipient allowed. */
  owner: string;
  /** The portfolio's Base account (`eip155:8453:0x…` from Glider's portfolio), the account debited. */
  accountId: string;
  portfolioId: string;
  assets: { assetId: string; amountRaw: string }[];
  liquidate: boolean;
  nowSec: number;
}

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const sameKeys = (o: Record<string, unknown>, keys: string[]) => {
  const k = Object.keys(o).sort();
  return k.length === keys.length && [...keys].sort().every((x, i) => x === k[i]);
};
const sameFields = (got: unknown, want: { name: string; type: string }[]) =>
  Array.isArray(got) &&
  got.length === want.length &&
  got.every((f, i) => isObj(f) && sameKeys(f, ['name', 'type']) && f.name === want[i].name && f.type === want[i].type);
const addr = (s: string) => {
  try {
    return getAddress(s);
  } catch {
    return null;
  }
};

/** Null when the typed data is exactly the withdrawal the panel asked for; otherwise why not. */
export function withdrawalProblem(typedData: unknown, ask: WithdrawalAsk): string | null {
  if (!isObj(typedData) || !sameKeys(typedData, ['primaryType', 'domain', 'types', 'message'])) return 'it is not a withdrawal in the expected format.';
  const { primaryType, domain, types, message } = typedData;
  if (primaryType !== 'Withdrawal') return 'it is not a withdrawal.';

  // Domain: Glider's withdrawal authorisation on Base, for this portfolio's own account.
  if (!isObj(domain) || !sameKeys(domain, ['name', 'version', 'chainId', 'verifyingContract'])) return 'its signing domain is not Glider’s withdrawal domain.';
  if (domain.name !== DOMAIN_NAME) return 'its signing domain is not Glider’s withdrawal domain.';
  if (domain.version !== (ask.liquidate ? '2' : '1')) return 'its signing domain has an unexpected version.';
  if (domain.chainId !== BASE) return 'it is not for Base.';
  const account = ask.accountId.startsWith(`eip155:${BASE}:`) ? addr(ask.accountId.slice(`eip155:${BASE}:`.length)) : null;
  const vc = typeof domain.verifyingContract === 'string' ? addr(domain.verifyingContract) : null;
  if (!account || vc !== account) return 'it is not for your Basis Tilt account.';

  // Types: exactly Glider's, nothing added or reordered.
  if (!isObj(types) || !sameKeys(types, ['Withdrawal', 'WithdrawalAsset'])) return 'its fields are not the expected ones.';
  if (!sameFields(types.Withdrawal, ask.liquidate ? LIQUIDATE_TYPE : PLAIN_TYPE) || !sameFields(types.WithdrawalAsset, ASSET_TYPE)) {
    return 'its fields are not the expected ones.';
  }

  // Message: this portfolio, to the connected wallet on Base, exactly the assets and amounts asked for.
  const want = ask.liquidate ? LIQUIDATE_TYPE : PLAIN_TYPE;
  if (!isObj(message) || !sameKeys(message, want.map((f) => f.name))) return 'its fields are not the expected ones.';
  if (message.portfolioId !== ask.portfolioId) return 'it is for another portfolio.';
  const owner = addr(ask.owner);
  const rec = typeof message.recipientAccountId === 'string' && message.recipientAccountId.startsWith(`eip155:${BASE}:`)
    ? addr(message.recipientAccountId.slice(`eip155:${BASE}:`.length))
    : null;
  if (!owner || rec !== owner) return 'it pays someone other than your wallet.';
  // The same assets and amounts as asked, in any order (only one-asset answers have been seen), no duplicates.
  const assets = message.assets;
  if (!Array.isArray(assets) || assets.length !== ask.assets.length) return 'its assets are not the ones you asked for.';
  const wanted = new Map<string, string>();
  for (const a of ask.assets) {
    const id = a.assetId.toLowerCase();
    if (wanted.has(id)) return 'the assets asked for repeat.';
    wanted.set(id, a.amountRaw);
  }
  const seen = new Set<string>();
  for (const a of assets) {
    if (!isObj(a) || !sameKeys(a, ['assetId', 'amountRaw']) || typeof a.assetId !== 'string') return 'its assets are not the ones you asked for.';
    const id = a.assetId.toLowerCase();
    if (seen.has(id)) return 'its assets repeat.';
    seen.add(id);
    if (!wanted.has(id) || a.amountRaw !== wanted.get(id)) return 'its assets or amounts are not the ones you asked for.';
  }
  if (typeof message.nonce !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(message.nonce)) return 'its nonce is malformed.';
  const exp = message.expiresAt;
  if (typeof exp !== 'number' || !Number.isInteger(exp)) return 'its expiry is malformed.';
  if (exp <= ask.nowSec - CLOCK_SLACK_S || exp > ask.nowSec + MAX_VALIDITY_S) {
    return 'its expiry is far from this device’s clock (it should be about 10 minutes away). Check the device’s date and time, then try again.';
  }
  if (ask.liquidate) {
    if (message.liquidate !== true) return 'it does not sell into USDC as asked.';
    if (typeof message.settlementAssetId !== 'string' || message.settlementAssetId.toLowerCase() !== BASE_USDC_ASSET_ID) return 'it does not settle in USDC on Base.';
  }
  return null;
}

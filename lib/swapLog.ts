// Server-verified log of in-app swaps, for the product metrics (traders, volume, fees, Builder Code
// transactions). A browser only reports a transaction hash; everything recorded is read back from
// the chain, and a swap counts only if its calldata is one this server built and checked
// (rememberBuiltSwap, keyed by keccak256 of the calldata, kept 2 hours), it succeeded, it was sent to
// KYBER_ROUTER by the account it was built for, and it carries Afterbook's Builder Code. The fee and
// size come from that stored build, so a hand-made router call cannot inflate the numbers. Wallets are
// stored as a short pseudonymous hash, enough to count unique traders; it is not a privacy guarantee
// (anyone can hash a known address).
import { createHash } from 'node:crypto';
import { decodeEventLog, erc20Abi, getAddress, keccak256, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from './builderCode';
import { getClient } from './quote';
import { redis } from './redis';
import { decodeSwapCall, KYBER_ROUTER, MAX_SWAP_USD, type SwapTx } from './swap';
import { USDC } from './tokens';

const KEY = (hash: string) => `swap:${hash.toLowerCase()}`;
const BUILT = (data: Hex) => `swapbuild:${keccak256(data)}`;
const BUILT_TTL_S = 2 * 60 * 60;

/** Which panel built it: one stock's Buy/Sell, or a /build basket bought in one go. */
export type SwapSource = 'stock' | 'basket';

interface BuiltSwap {
  account: string;
  symbol: string;
  side: 'buy' | 'sell';
  feeBps: number;
  amountInUsd: number;
  source?: SwapSource;
}

/** Called by /api/swap/build for every transaction it returns, so the log can tell our swaps from any
 *  other router call that happens to carry the (public) Builder Code. */
export async function rememberBuiltSwap(tx: SwapTx, account: `0x${string}`, source: SwapSource = 'stock'): Promise<void> {
  if (!redis) return;
  const built: BuiltSwap = { account, symbol: tx.quote.symbol, side: tx.quote.side, feeBps: tx.quote.feeBps, amountInUsd: tx.quote.amountInUsd, source };
  await redis.set(BUILT(tx.data), built, { ex: BUILT_TTL_S });
}
const INDEX = 'swaps';
const TTL_S = 400 * 24 * 60 * 60;

export interface SwapRecord {
  hash: string;
  at: number;
  symbol: string;
  side: 'buy' | 'sell';
  usd: number;
  feeBps: number;
  feeUsd: number;
  wallet: string;
  /** Missing on swaps logged before baskets could be bought (2026-10-14): those were all 'stock'. */
  source?: SwapSource;
}

const walletId = (addr: string) => createHash('sha256').update(addr.toLowerCase()).digest('hex').slice(0, 16);

export type LogResult = { ok: true; record: SwapRecord; duplicate: boolean } | { ok: false; reason: string };

export async function logSwap(hash: Hex): Promise<LogResult> {
  if (!redis) return { ok: false, reason: 'store unavailable' };
  const existing = await redis.get<SwapRecord>(KEY(hash));
  if (existing) return { ok: true, record: existing, duplicate: true };

  const client = getClient();
  // The browser reports the hash as soon as its own RPC has the receipt; ours can be a few seconds
  // behind (the first real swap got "could not read the transaction yet"), so wait for it here.
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 20_000 });
  const tx = await client.getTransaction({ hash });
  if (receipt.status !== 'success') return { ok: false, reason: 'transaction failed or pending' };
  if (!tx.to || getAddress(tx.to) !== KYBER_ROUTER) return { ok: false, reason: 'not a swap through the Afterbook router' };
  const suffix = BUILDER_CODE_SUFFIX.slice(2).toLowerCase();
  const input = tx.input.toLowerCase();
  if (!input.endsWith(suffix)) return { ok: false, reason: 'not sent from Afterbook' };
  const built = await redis.get<BuiltSwap>(BUILT(input.slice(0, input.length - suffix.length) as Hex));
  if (!built) return { ok: false, reason: 'not a swap Afterbook built' };
  if (getAddress(tx.from) !== getAddress(built.account)) return { ok: false, reason: 'sent by a different account' };
  const call = decodeSwapCall(tx.input);
  if (!call || call.recipient !== getAddress(built.account)) return { ok: false, reason: 'not a tracked stock swap' };

  // USD size: the USDC sold on a buy; on a sell, the USDC that reached the recipient (after any fee).
  let usd = Number(call.amountIn) / 10 ** USDC.decimals;
  if (call.side === 'sell') {
    // USDC that reached the recipient in this transaction (from the router when a fee is taken, else
    // straight from KyberSwap's executor; the calldata is one we built, so the route is KyberSwap's).

    let received = BigInt(0);
    for (const log of receipt.logs) {
      if (getAddress(log.address) !== getAddress(USDC.address)) continue;
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (ev.eventName === 'Transfer' && getAddress(ev.args.to) === call.recipient) received += ev.args.value;
      } catch {
        // not a Transfer
      }
    }
    usd = Number(received) / 10 ** USDC.decimals;
  }
  usd = Math.min(usd, MAX_SWAP_USD);
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const record: SwapRecord = {
    hash: hash.toLowerCase(),
    at: Number(block.timestamp) * 1000,
    symbol: call.stock.symbol,
    side: call.side,
    usd,
    feeBps: built.feeBps,
    feeUsd: (usd * built.feeBps) / 10_000,
    wallet: walletId(tx.from),
    source: built.source ?? 'stock',
  };
  const created = await redis.set(KEY(hash), record, { nx: true, ex: TTL_S });
  if (created) await redis.zadd(INDEX, { score: record.at, member: record.hash });
  return { ok: true, record, duplicate: !created };
}

export interface SwapStats {
  days: number;
  swaps: number;
  traders: number;
  volumeUsd: number;
  feesUsd: number;
  bySymbol: Record<string, { swaps: number; volumeUsd: number }>;
  /** Swaps from a stock's own panel vs legs of a basket bought in one go. */
  bySource: Record<SwapSource, { swaps: number; volumeUsd: number }>;
}

export async function swapStats(days: number): Promise<SwapStats | null> {
  if (!redis) return null;
  const since = Date.now() - days * 24 * 60 * 60 * 1000;
  const hashes = await redis.zrange<string[]>(INDEX, since, '+inf', { byScore: true });
  const records = hashes.length ? ((await redis.mget<(SwapRecord | null)[]>(...hashes.map(KEY))).filter(Boolean) as SwapRecord[]) : [];
  const bySymbol: SwapStats['bySymbol'] = {};
  for (const r of records) {
    const s = (bySymbol[r.symbol] ??= { swaps: 0, volumeUsd: 0 });
    s.swaps += 1;
    s.volumeUsd += r.usd;
  }
  return {
    days,
    swaps: records.length,
    traders: new Set(records.map((r) => r.wallet)).size,
    volumeUsd: records.reduce((a, r) => a + r.usd, 0),
    feesUsd: records.reduce((a, r) => a + r.feeUsd, 0),
    bySymbol,
    bySource: (['stock', 'basket'] as const).reduce(
      (acc, src) => {
        const mine = records.filter((r) => (r.source ?? 'stock') === src);
        acc[src] = { swaps: mine.length, volumeUsd: mine.reduce((a, r) => a + r.usd, 0) };
        return acc;
      },
      {} as SwapStats['bySource'],
    ),
  };
}

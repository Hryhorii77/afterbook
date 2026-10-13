// Server-verified log of in-app swaps, for the product metrics (traders, volume, fees, Builder Code
// transactions). A browser only reports a transaction hash; everything recorded is read back from
// the chain, and only a successful call to KYBER_ROUTER between USDC and a tracked stock that carries
// Afterbook's Builder Code counts. Wallets are stored as a short hash of the address: enough to count
// unique traders, never listed.
import { createHash } from 'node:crypto';
import { decodeEventLog, erc20Abi, getAddress, type Hex } from 'viem';
import { BUILDER_CODE_SUFFIX } from './builderCode';
import { getClient } from './quote';
import { redis } from './redis';
import { decodeSwapCall, KYBER_ROUTER } from './swap';
import { USDC } from './tokens';

const KEY = (hash: string) => `swap:${hash.toLowerCase()}`;
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
}

const walletId = (addr: string) => createHash('sha256').update(addr.toLowerCase()).digest('hex').slice(0, 16);

export type LogResult = { ok: true; record: SwapRecord; duplicate: boolean } | { ok: false; reason: string };

export async function logSwap(hash: Hex): Promise<LogResult> {
  if (!redis) return { ok: false, reason: 'store unavailable' };
  const existing = await redis.get<SwapRecord>(KEY(hash));
  if (existing) return { ok: true, record: existing, duplicate: true };

  const client = getClient();
  const [tx, receipt] = await Promise.all([client.getTransaction({ hash }), client.getTransactionReceipt({ hash })]);
  if (receipt.status !== 'success') return { ok: false, reason: 'transaction failed or pending' };
  if (!tx.to || getAddress(tx.to) !== KYBER_ROUTER) return { ok: false, reason: 'not a swap through the Afterbook router' };
  if (!tx.input.toLowerCase().endsWith(BUILDER_CODE_SUFFIX.slice(2).toLowerCase())) return { ok: false, reason: 'not sent from Afterbook' };
  const call = decodeSwapCall(tx.input);
  if (!call) return { ok: false, reason: 'not a tracked stock swap' };

  // USD size: the USDC sold on a buy; on a sell, the USDC that reached the recipient (after any fee).
  let usd = Number(call.amountIn) / 10 ** USDC.decimals;
  if (call.side === 'sell') {
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
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const record: SwapRecord = {
    hash: hash.toLowerCase(),
    at: Number(block.timestamp) * 1000,
    symbol: call.stock.symbol,
    side: call.side,
    usd,
    feeBps: call.feeBps,
    feeUsd: (usd * call.feeBps) / 10_000,
    wallet: walletId(tx.from),
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
  };
}

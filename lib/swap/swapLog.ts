// Server-verified log of in-app swaps, for the product metrics (traders, volume, fees, Builder Code
// transactions). A browser only reports a transaction hash; everything recorded is read back from
// the chain, and a swap counts only if its calldata is one this server built and checked
// (rememberBuiltSwap, keyed by keccak256 of the calldata, kept 2 hours), it succeeded, it was a call to
// KYBER_ROUTER by the account it was built for (sent straight from that account, or, for a smart account
// such as Base Account, inside that account's successful user operation; see routerCalls), and it
// carries Afterbook's Builder Code. The fee and
// size come from that stored build, so a hand-made router call cannot inflate the numbers. Wallets are
// stored as a short pseudonymous hash, enough to count unique traders; it is not a privacy guarantee
// (anyone can hash a known address).
import { createHash } from 'node:crypto';
import { decodeEventLog, decodeFunctionData, erc20Abi, getAddress, keccak256, parseAbi, type Hex } from 'viem';
import { ENTRY_POINT_ABIS, ENTRY_POINTS } from '../wallet/userOps';
import { BUILDER_CODE_SUFFIX } from '../wallet/builderCode';
import { getClient } from '../market/quote';
import { redis } from '../server/redis';
import { decodeSwapCall, decodeSwapDesc, KYBER_ROUTER, MAX_MEME_SWAP_USD, MAX_SWAP_USD, type SwapTx } from './swap';
import { USDC } from '../stocks/tokens';

const KEY = (id: string) => `swap:${id.toLowerCase()}`;
const BUILT = (data: Hex) => `swapbuild:${keccak256(data)}`;
const BUILT_TTL_S = 2 * 60 * 60;
// Which logged swap a build was counted for, so one build can't be counted for two swaps.
const MAX_ACCOUNTS_PER_TX = 4;
const DONE = (hash: string) => `swapdone:${hash.toLowerCase()}`;
const USED = (data: Hex) => `swapused:${keccak256(data)}`;

/** Which panel built it: one stock's Buy/Sell, a /build basket bought in one go, a meme buy on /memes,
 *  a buy reviewed from a trade plan on /plan, or a due run of a personal stock rule on /rules. The label is
 *  the browser's claim, for the metrics only: a swap still counts only if it passes every check below,
 *  whatever it is labelled. */
export type SwapSource = 'stock' | 'basket' | 'meme' | 'plan' | 'rule';
export const SWAP_SOURCES: readonly SwapSource[] = ['stock', 'basket', 'meme', 'plan', 'rule'];

interface BuiltSwap {
  account: string;
  symbol: string;
  side: 'buy' | 'sell';
  feeBps: number;
  amountInUsd: number;
  source?: SwapSource;
  /** Meme buys only: the exact tokens built, which the mined call must match. */
  tokenIn?: string;
  tokenOut?: string;
}

/** Called by /api/swap/build for every transaction it returns, so the log can tell our swaps from any
 *  other router call that happens to carry the (public) Builder Code. */
export async function rememberBuiltSwap(tx: SwapTx, account: `0x${string}`, source: SwapSource = 'stock'): Promise<void> {
  if (!redis) return;
  const built: BuiltSwap = { account, symbol: tx.quote.symbol, side: tx.quote.side, feeBps: tx.quote.feeBps, amountInUsd: tx.quote.amountInUsd, source };
  if (source === 'meme' && tx.quote.meme) {
    built.tokenIn = tx.tokenIn;
    built.tokenOut = tx.quote.meme;
  }
  try {
    await redis.set(BUILT(tx.data), built, { ex: BUILT_TTL_S });
  } catch (err) {
    // The log is bookkeeping, not part of the trade: a Redis outage must not stop the swap being built
    // (it did on 2026-10-18). The swap just goes unlogged.
    console.error('swap log: could not remember the built swap', err instanceof Error ? err.message : err);
  }
}
const INDEX = 'swaps';
const TTL_S = 400 * 24 * 60 * 60;

export interface SwapRecord {
  /** The transaction hash; "<hash>:<n>" for the n-th router call inside a smart account's transaction. */
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

export type LogResult = { ok: true; records: SwapRecord[]; duplicate: boolean } | { ok: false; reason: string };

// A smart account such as Base Account doesn't send its own transaction: a bundler sends handleOps to an
// ERC-4337 EntryPoint (ENTRY_POINTS, lib/wallet/userOps.ts), which runs the account's user operation. So
// a swap from a smart account is a router call inside a user operation, not a transaction to the router.
// Coinbase Smart Wallet (Base Account): one call, or a batch that reverts as a whole if any call fails.
// A user operation's "success" only means the account's own code didn't revert, and anyone can deploy an
// account whose code claims to run a call and runs another. So a smart account's swaps count only when it
// is a genuine Coinbase Smart Wallet (Base Account): the implementation both of Coinbase's factories
// deploy (read from the factories' implementation() on 2026-11-18: v1 0x0BA5ED0c…, v1.1 0xBA5ED110…),
// whose execute/executeBatch run exactly the calls given and revert the whole batch if one fails, behind
// the factories' ERC-1967 proxy or Coinbase's EIP-7702 proxy (base/eip-7702-proxy).
const CSW_IMPLEMENTATIONS = new Set(['0x000100abaad02f1cfC8Bbe32bD5a564817339E72', '0x00000110dCdEdC9581cb5eCB8467282f2926534d'].map((a) => getAddress(a)));
const ERC1967_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc' as const;
const CSW_PROXY_CODE = '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';
const EIP7702_DESIGNATOR = '0xef01007702cb554e6bfb442cb743a7df23154544a7176c';

// Coinbase's two smart-wallet factories (v1, v1.1). An account deployed by the user operation itself
// counts only if its initCode calls one of them.
const CSW_FACTORIES = new Set(['0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a', '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842'].map((a) => getAddress(a)));
// ERC-1967 Upgraded(address): emitted when a proxy's implementation changes (the smart wallet's UUPS
// upgrade and the EIP-7702 proxy both use it).
const UPGRADED_TOPIC = '0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b' as const;

/** Code and implementation slot of an account at the end of a block: genuine, empty (no code), or other. */
async function walletState(account: `0x${string}`, blockNumber: bigint): Promise<'genuine' | 'empty' | 'other'> {
  const client = getClient();
  const [code, slot] = await Promise.all([client.getCode({ address: account, blockNumber }), client.getStorageAt({ address: account, slot: ERC1967_SLOT, blockNumber })]);
  const c = (code ?? '0x').toLowerCase();
  if (c === '0x') return 'empty';
  if (c !== CSW_PROXY_CODE && c !== EIP7702_DESIGNATOR) return 'other';
  if (!slot || slot.length !== 66) return 'other';
  return CSW_IMPLEMENTATIONS.has(getAddress(`0x${slot.slice(26)}`)) ? 'genuine' : 'other';
}

/** Whether an account ran a block's user operation as a genuine Coinbase Smart Wallet: genuine at the end
 *  of the block, genuine before it (or empty before it and deployed by this operation through one of
 *  Coinbase's factories), and no change in the block to any other implementation. The end state alone isn't enough:
 *  the same proxy code can point at any implementation, and an operation can run other code and then
 *  write the genuine implementation back. Known gap (Low): an EIP-7702 account can change its delegation
 *  and change it back within one block without an event; that takes a custom setup and moves only the
 *  stats. */
export async function isCoinbaseSmartWallet(account: `0x${string}`, blockNumber: bigint, deployedBy: `0x${string}` | null): Promise<boolean> {
  const [after, before, upgrades] = await Promise.all([
    walletState(account, blockNumber),
    walletState(account, blockNumber - BigInt(1)),
    getClient().request({ method: 'eth_getLogs', params: [{ address: account, topics: [UPGRADED_TOPIC], fromBlock: `0x${blockNumber.toString(16)}`, toBlock: `0x${blockNumber.toString(16)}` }] }),
  ]);
  // Any implementation change in the block must be to a Coinbase implementation (a fresh proxy may log
  // one as it is deployed; a switch to other code and back would log the other code).
  const toOther = (upgrades as { topics?: string[] }[]).some((l) => !l.topics?.[1] || !CSW_IMPLEMENTATIONS.has(getAddress(`0x${l.topics[1].slice(26)}`)));
  if (after !== 'genuine' || toOther) return false;
  if (before === 'genuine') return true;
  return before === 'empty' && deployedBy !== null && CSW_FACTORIES.has(getAddress(deployedBy));
}

// The router's own record of a swap it ran. `sender` is whoever called the router: the trader's account,
// whether it sent the transaction itself or ran the call inside a user operation.
const SWAPPED_ABI = parseAbi(['event Swapped(address sender, address srcToken, address dstToken, address dstReceiver, uint256 spentAmount, uint256 returnAmount)']);
const SMART_WALLET_ABI = parseAbi([
  'function execute(address target, uint256 value, bytes data)',
  'function executeBatch((address target, uint256 value, bytes data)[] calls)',
]);

/** A router call made by a mined transaction, and the account that made it. */
export interface RouterCall {
  account: `0x${string}`;
  input: Hex;
  /** Smart accounts only: the factory the user operation's initCode called (it deployed the account), or null. */
  deployedBy?: `0x${string}` | null;
}

interface MinedTx {
  to: `0x${string}` | null;
  from: `0x${string}`;
  input: Hex;
}
interface MinedLog {
  address: `0x${string}`;
  data: Hex;
  topics: [] | [Hex, ...Hex[]];
}

/** The calls to KYBER_ROUTER that a successful transaction made: the transaction itself when it was sent
 *  straight to the router, or, for a bundler's handleOps, each router call (value 0) inside a user
 *  operation the EntryPoint reports as successful (UserOperationEvent with that sender and nonce, emitted
 *  by that EntryPoint), made by that operation's account. Anything else has none. */
export function routerCalls(tx: MinedTx, logs: readonly MinedLog[]): RouterCall[] {
  if (!tx.to) return [];
  const to = getAddress(tx.to);
  if (to === KYBER_ROUTER) return [{ account: getAddress(tx.from), input: tx.input }];
  if (!ENTRY_POINTS.has(to)) return [];
  type Op = { sender: string; nonce: bigint; callData: Hex; initCode: Hex };
  let ops: readonly Op[] | null = null;
  for (const abi of ENTRY_POINT_ABIS) {
    try {
      const d = decodeFunctionData({ abi, data: tx.input });
      if (d.functionName === 'handleOps') ops = d.args[0] as readonly Op[];
      break;
    } catch {
      // another EntryPoint version
    }
  }
  if (!ops) return [];
  const succeeded = new Set<string>();
  for (const log of logs) {
    if (getAddress(log.address) !== to) continue;
    for (const abi of ENTRY_POINT_ABIS) {
      try {
        const e = decodeEventLog({ abi, data: log.data, topics: log.topics });
        if (e.eventName === 'UserOperationEvent') {
          const a = e.args as { sender: string; nonce: bigint; success: boolean };
          if (a.success) succeeded.add(`${getAddress(a.sender)}:${a.nonce}`);
        }
        break;
      } catch {
        // not this ABI's event
      }
    }
  }
  const out: RouterCall[] = [];
  for (const op of ops) {
    const account = getAddress(op.sender);
    const deployedBy = op.initCode.length >= 42 ? getAddress(op.initCode.slice(0, 42)) : null;
    if (!succeeded.has(`${account}:${op.nonce}`)) continue;
    let calls: readonly { target: string; value: bigint; data: Hex }[] = [];
    try {
      const d = decodeFunctionData({ abi: SMART_WALLET_ABI, data: op.callData });
      calls = d.functionName === 'execute' ? [{ target: d.args[0], value: d.args[1], data: d.args[2] }] : d.args[0];
    } catch {
      continue; // an account whose calls we can't read is not counted
    }
    for (const c of calls) if (getAddress(c.target) === KYBER_ROUTER && c.value === BigInt(0)) out.push({ account, input: c.data, deployedBy });
  }
  return out;
}

/** Logs a confirmed transaction's Afterbook swaps: one for a swap sent straight to the router, one per
 *  swap for a smart account's user operation (a one-signature basket batch holds several). A swap sent
 *  straight to the router is stored under its transaction hash, as before; a swap inside a user operation
 *  under "<hash>:<n>", n counting the transaction's router calls. */
export async function logSwap(hash: Hex): Promise<LogResult> {
  if (!redis) return { ok: false, reason: 'store unavailable' };
  const h = hash.toLowerCase();
  // A straight swap is stored as "<hash>"; a smart account's transaction gets a "done" marker once every
  // call in it has been tried (not after the first, so a retry after an error still logs the rest).
  const [existing, done] = await redis.mget<[SwapRecord | null, number | null]>(KEY(h), DONE(h));
  if (existing) return { ok: true, records: [existing], duplicate: true };
  if (done !== null) return { ok: true, records: [], duplicate: true };

  const client = getClient();
  // The browser reports the hash as soon as its own RPC has the receipt; ours can be a few seconds
  // behind (the first real swap got "could not read the transaction yet"), so wait for it here.
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 20_000 });
  const tx = await client.getTransaction({ hash });
  if (receipt.status !== 'success') return { ok: false, reason: 'transaction failed or pending' };
  const direct = tx.to !== null && getAddress(tx.to) === KYBER_ROUTER;
  let calls = routerCalls(tx, receipt.logs);
  if (!direct) {
    // Cheap first: only calls carrying the Builder Code, and at most a few accounts per transaction (a
    // basket is one account), so a crafted bundle of many operations can't make one report cost
    // hundreds of chain reads.
    const suffix = BUILDER_CODE_SUFFIX.slice(2).toLowerCase();
    calls = calls.filter((c) => c.input.toLowerCase().endsWith(suffix));
    const accounts = [...new Set(calls.map((c) => c.account))].slice(0, MAX_ACCOUNTS_PER_TX);
    calls = calls.filter((c) => accounts.includes(c.account));
    const genuine = new Map<string, boolean>();
    for (const c of calls) if (!genuine.has(c.account)) genuine.set(c.account, await isCoinbaseSmartWallet(c.account, receipt.blockNumber, c.deployedBy ?? null));
    calls = calls.filter((c) => genuine.get(c.account));
  }
  if (calls.length === 0) return { ok: false, reason: 'not a swap through the Afterbook router' };
  const block = await client.getBlock({ blockNumber: receipt.blockNumber });
  const at = Number(block.timestamp) * 1000;

  const swapped = swappedLogs(receipt.logs);
  const records: SwapRecord[] = [];
  let duplicate = true;
  let reason = 'not a swap Afterbook built';
  for (const [n, call] of calls.entries()) {
    const id = direct ? h : `${h}:${n}`;
    const checked = await checkRouterCall(call, receipt.logs, swapped, id, at);
    if (!checked.ok) {
      reason = checked.reason;
      continue;
    }
    // One build counts for one swap: the first record to claim it keeps it (a retry of the same id is fine).
    const claimed = await redis.set(USED(checked.built), id, { nx: true, ex: BUILT_TTL_S });
    if (!claimed && (await redis.get<string>(USED(checked.built))) !== id) {
      reason = 'that build was already counted';
      continue;
    }
    const created = await redis.set(KEY(id), checked.record, { nx: true, ex: TTL_S });
    if (created) {
      await redis.zadd(INDEX, { score: checked.record.at, member: id });
      duplicate = false;
    }
    records.push(checked.record);
  }
  if (!direct && records.length) await redis.set(DONE(h), records.length, { ex: TTL_S });
  return records.length ? { ok: true, records, duplicate } : { ok: false, reason };
}

interface SwappedLog {
  sender: `0x${string}`;
  srcToken: `0x${string}`;
  dstToken: `0x${string}`;
  dstReceiver: `0x${string}`;
  spentAmount: bigint;
  returnAmount: bigint;
  used: boolean;
}

/** The router's Swapped events in a receipt (only those the router itself emitted). */
function swappedLogs(logs: readonly MinedLog[]): SwappedLog[] {
  const out: SwappedLog[] = [];
  for (const log of logs) {
    if (getAddress(log.address) !== KYBER_ROUTER) continue;
    try {
      const e = decodeEventLog({ abi: SWAPPED_ABI, data: log.data, topics: log.topics });
      const a = e.args;
      out.push({ sender: getAddress(a.sender), srcToken: getAddress(a.srcToken), dstToken: getAddress(a.dstToken), dstReceiver: getAddress(a.dstReceiver), spentAmount: a.spentAmount, returnAmount: a.returnAmount, used: false });
    } catch {
      // another router event
    }
  }
  return out;
}

/** One router call against the build this server remembered for it: the Builder Code, the build, the
 *  account it was built for, and what the call decodes to. */
async function checkRouterCall(
  call: RouterCall,
  logs: readonly MinedLog[],
  swapped: SwappedLog[],
  id: string,
  at: number,
): Promise<{ ok: true; record: SwapRecord; built: Hex } | { ok: false; reason: string }> {
  if (!redis) return { ok: false, reason: 'store unavailable' };
  const suffix = BUILDER_CODE_SUFFIX.slice(2).toLowerCase();
  const input = call.input.toLowerCase();
  if (!input.endsWith(suffix)) return { ok: false, reason: 'not sent from Afterbook' };
  const builtData = input.slice(0, input.length - suffix.length) as Hex;
  const built = await redis.get<BuiltSwap>(BUILT(builtData));
  if (!built) return { ok: false, reason: 'not a swap Afterbook built' };
  if (call.account !== getAddress(built.account)) return { ok: false, reason: 'sent by a different account' };
  // Proof the swap ran: the router's own Swapped event for this account, these tokens, this recipient and
  // exactly this amount, each event used for one call only. Checked with the fee at 0 (every logged
  // swap matched on 2026-11-18); before SWAP_FEE_BPS is ever turned on, re-check that a fee-on buy still
  // reports spentAmount equal to the built amount, or buys stop being logged. A user operation's success only says the
  // account's outer call didn't revert; an account of anyone's making could skip or swallow the call.
  const desc = decodeSwapDesc(call.input);
  const ran = desc && swapped.find((e) => !e.used && e.sender === call.account && e.srcToken === desc.srcToken && e.dstToken === desc.dstToken && e.dstReceiver === desc.recipient && e.spentAmount === desc.amountIn);
  if (!desc || !ran) return { ok: false, reason: 'the router did not report this swap' };
  ran.used = true;
  if (built.source === 'meme') {
    // A meme buy: the mined call must be the tokens and recipient that were built; the size is the
    // build's own USD value (paid in USDC or a stock token), capped like the panel. Its symbol is the
    // launcher's choice, so it is stored as "meme:<symbol>" and can never merge into a stock's stats.
    if (!built.tokenIn || !built.tokenOut || desc.recipient !== getAddress(built.account) || desc.srcToken !== getAddress(built.tokenIn) || desc.dstToken !== getAddress(built.tokenOut)) {
      return { ok: false, reason: 'not the meme buy Afterbook built' };
    }
    const usd = Math.min(built.amountInUsd, MAX_MEME_SWAP_USD);
    return { ok: true, built: builtData, record: { hash: id, at, symbol: `meme:${built.symbol}`, side: 'buy', usd, feeBps: 0, feeUsd: 0, wallet: walletId(call.account), source: 'meme' } };
  }
  const swap = decodeSwapCall(call.input);
  if (!swap || swap.recipient !== getAddress(built.account)) return { ok: false, reason: 'not a tracked stock swap' };

  // USD size: the USDC sold on a buy; on a sell, the USDC that reached the recipient (after any fee).
  let usd = Number(swap.amountIn) / 10 ** USDC.decimals;
  if (swap.side === 'sell') {
    // USDC that reached the recipient in this transaction (from the router when a fee is taken, else
    // straight from KyberSwap's executor; the calldata is one we built, so the route is KyberSwap's).
    // Other calls in the same transaction (a smart account's batch, another user operation) can also
    // send USDC to the recipient, so the size is capped at what the router says this swap returned.
    let received = BigInt(0);
    for (const log of logs) {
      if (getAddress(log.address) !== getAddress(USDC.address)) continue;
      try {
        const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics });
        if (ev.eventName === 'Transfer' && getAddress(ev.args.to) === swap.recipient && getAddress(ev.args.from) !== swap.recipient) received += ev.args.value;
      } catch {
        // not a Transfer
      }
    }
    usd = Number(received < ran.returnAmount ? received : ran.returnAmount) / 10 ** USDC.decimals;
  }
  usd = Math.min(usd, MAX_SWAP_USD);
  return {
    ok: true,
    built: builtData,
    record: { hash: id, at, symbol: swap.stock.symbol, side: swap.side, usd, feeBps: built.feeBps, feeUsd: (usd * built.feeBps) / 10_000, wallet: walletId(call.account), source: built.source ?? 'stock' },
  };
}

export interface SwapStats {
  days: number;
  swaps: number;
  traders: number;
  volumeUsd: number;
  feesUsd: number;
  bySymbol: Record<string, { swaps: number; volumeUsd: number }>;
  /** Swaps by the panel that built them, with distinct (hashed) wallets per panel. */
  bySource: Record<SwapSource, { swaps: number; volumeUsd: number; traders: number }>;
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
    traders: new Set(records.map((r) => r.wallet).filter(Boolean)).size,
    volumeUsd: records.reduce((a, r) => a + r.usd, 0),
    feesUsd: records.reduce((a, r) => a + r.feeUsd, 0),
    bySymbol,
    bySource: SWAP_SOURCES.reduce(
      (acc, src) => {
        const mine = records.filter((r) => (r.source ?? 'stock') === src);
        acc[src] = { swaps: mine.length, volumeUsd: mine.reduce((a, r) => a + r.usd, 0), traders: new Set(mine.map((r) => r.wallet).filter(Boolean)).size };
        return acc;
      },
      {} as SwapStats['bySource'],
    ),
  };
}

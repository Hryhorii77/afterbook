// Read-only: USDC transfers into Afterbook's x402 payout address within a time window, with the payer, amount, block
// time and the transaction's selector (0xe3ee160e = transferWithAuthorization, how x402's exact scheme settles on
// Base). Used on 2026-11-25 to find the owner's nine Bankr calls for scripts/x402/backfill-2026-11-25.mts.
//
//   npx tsx scripts/x402/find-payments.mts 2026-11-25T12:35:00Z 2026-11-25T12:50:00Z
//
// Free public RPCs cap eth_getLogs ranges (dRPC: 100 blocks; Base: 200 ms blocks, so 15 minutes is ~4,500 blocks),
// so the window is read in 100-block steps with a pause, and block times from mainnet.base.org.
// Note: the payout address is shared with another app's paid calls, so a transfer here isn't necessarily an
// Afterbook call: match each one to a route (e.g. by the Bazaar's crawl time) before counting it.
import { createPublicClient, http, parseAbiItem } from 'viem';
import { base } from 'viem/chains';
import { USDC } from '../../lib/stocks/tokens';

const PAYOUT = '0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae' as const;
const [fromArg, toArg] = process.argv.slice(2);
if (!fromArg || !toArg) throw new Error('usage: find-payments.mts <from ISO time> <to ISO time>');

const logsRpc = createPublicClient({ chain: base, transport: http('https://base.drpc.org') });
const main = createPublicClient({ chain: base, transport: http('https://mainnet.base.org') });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const head = await main.getBlock();
const prev = await main.getBlock({ blockNumber: head.number - BigInt(1000) });
const secPerBlock = Number(head.timestamp - prev.timestamp) / 1000;
const blockAt = (iso: string) => head.number - BigInt(Math.ceil((Number(head.timestamp) - Date.parse(iso) / 1000) / secPerBlock));
const start = blockAt(fromArg);
const end = blockAt(toArg);
console.log('blocks', start, '→', end, `(${secPerBlock} s/block)`);

const ev = parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)');
const logs = [];
for (let b = start; b <= end; b += BigInt(100)) {
  const e = b + BigInt(99) > end ? end : b + BigInt(99);
  for (let attempt = 0; ; attempt++) {
    try {
      logs.push(...(await logsRpc.getLogs({ address: USDC.address as `0x${string}`, event: ev, args: { to: PAYOUT }, fromBlock: b, toBlock: e })));
      break;
    } catch (err) {
      if (attempt >= 5) throw err;
      await sleep(3000 * (attempt + 1));
    }
  }
  await sleep(400);
}
console.log('found', logs.length);
for (const l of logs) {
  await sleep(800);
  const blk = await main.getBlock({ blockNumber: l.blockNumber }).catch(() => null);
  const tx = await main.getTransaction({ hash: l.transactionHash }).catch(() => null);
  console.log(blk ? new Date(Number(blk.timestamp) * 1000).toISOString() : '?', l.transactionHash, 'from', String(l.args.from), 'value', String(l.args.value), 'selector', tx ? tx.input.slice(0, 10) : '?');
}

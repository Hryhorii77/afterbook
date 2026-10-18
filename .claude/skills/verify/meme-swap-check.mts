// Meme-buy safety check (read-only: nothing is signed or broadcast). Run from the repo root:
//   SWAP_FEE_BPS=20 SWAP_FEE_RECIPIENT=0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae npx tsx .claude/skills/verify/meme-swap-check.mts
// (the fee variables are set on purpose: a meme buy must carry no fee even when the stock fee is on).
// 1. Tamper: real KyberSwap calldata for a BLUECHIP buy with one field changed at a time; checkSwapCalldata
//    must refuse each (including any fee at all).
// 2. Simulate (eth_simulateV1): approve + the server-built buy with the Builder Code appended, from a real
//    holder (the NVDAc/USDC pool), paying with USDC and with NVDAc; prints the BLUECHIP received.
// The allowlist and liquidity checks (lib/memeSwap.ts) need the app's cache: test them through the
// /api/swap routes on a local build instead (unknown meme, thin meme, wrong payWith, over $1,000).
import { concat, decodeFunctionData, decodeFunctionResult, encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem';
import { buildSwap, checkSwapCalldata, KYBER_ROUTER, type SwapRequest } from '../../../lib/swap';
import { BUILDER_CODE_SUFFIX } from '../../../lib/builderCode';
import { getStock, USDC } from '../../../lib/tokens';
import type { MemePool } from '../../../lib/memestocks';

const stock = getStock('NVDAc')!;
const HOLDER = stock.pool.address as Hex;
const EVIL = '0x2222222222222222222222222222222222222222' as const;
const OTHER_MEME = '0xca18A528Ea897040f715edC92e6e4572780c5ca1'; // KAI, also on NVDAc
const pool: MemePool = {
  id: '0x41084f2d35b54dc0d070fbf76aa52c46f5d9c7e36c163252064b6b184d9429d9',
  venue: 'uniswap-v4',
  stockSymbol: 'NVDAc',
  meme: { address: '0xB200000000000000000000cFbdF64a8706a94a01', symbol: 'BLUECHIP', name: 'BLUE CHIP', decimals: 18 },
  verification: 'price-matched',
  hooks: null,
  createdAt: null,
};
const req = (payWith: 'USDC' | 'stock', amountIn: string): SwapRequest => ({ stock, side: 'buy', amountIn: BigInt(amountIn), meme: { pool, payWith } });

async function tamper() {
  const abi = parseAbi([
    'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
    'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
    'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)',
  ]);
  const r = req('USDC', '50000000');
  const tx = await buildSwap(r, HOLDER);
  if (tx.quote.feeBps !== 0) throw new Error('a meme buy was quoted with a fee');
  const exec = decodeFunctionData({ abi, data: tx.data }).args[0];
  const remake = (patch: Record<string, unknown>) => encodeFunctionData({ abi, functionName: 'swap', args: [{ ...exec, desc: { ...exec.desc, ...patch } }] }) as Hex;
  const cases: [string, Hex, boolean][] = [
    ['untouched', tx.data, true],
    ['recipient changed', remake({ dstReceiver: EVIL }), false],
    ['minimum lowered 2%', remake({ minReturnAmount: (exec.desc.minReturnAmount * 98n) / 100n }), false],
    ['minimum zero', remake({ minReturnAmount: 0n }), false],
    ['amount doubled', remake({ amount: exec.desc.amount * 2n }), false],
    ['output: another meme', remake({ dstToken: OTHER_MEME }), false],
    ['input: NVDAc not USDC', remake({ srcToken: stock.tokenAddress }), false],
    ['any fee added', remake({ feeReceivers: [EVIL], feeAmounts: [20n] }), false],
    ['permit added', remake({ permit: '0x1234' }), false],
  ];
  let ok = true;
  for (const [name, data, shouldPass] of cases) {
    let passed = true;
    try {
      checkSwapCalldata(r, HOLDER, null, data, BigInt(tx.quote.amountOut));
    } catch {
      passed = false;
    }
    const good = passed === shouldPass;
    ok &&= good;
    console.log(`${good ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${passed ? 'accepted' : 'refused'}`);
  }
  return ok;
}

async function simulate(payWith: 'USDC' | 'stock', amountIn: string) {
  const r = req(payWith, amountIn);
  const tx = await buildSwap(r, HOLDER);
  const inToken = payWith === 'USDC' ? USDC.address : stock.tokenAddress;
  const bal = (token: Hex, who: Hex) => ({ from: HOLDER, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who] }) });
  const calls = [
    bal(pool.meme.address, HOLDER),
    { from: HOLDER, to: inToken, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER, BigInt(amountIn)] }) },
    { from: HOLDER, to: tx.to, data: concat([tx.data, BUILDER_CODE_SUFFIX]) },
    bal(pool.meme.address, HOLDER),
  ];
  const res = await fetch('https://mainnet.base.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls }], validation: false }, 'latest'] }),
  }).then((x) => x.json());
  if (res.error) throw new Error(JSON.stringify(res.error));
  const out = res.result[0].calls as { status: string; returnData: Hex }[];
  const n = (i: number) => decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: out[i].returnData }) as bigint;
  const swapOk = out[1].status === '0x1' && out[2].status === '0x1';
  const got = n(3) - n(0);
  const ok = swapOk && got >= BigInt(tx.minAmountOut);
  console.log(
    `${ok ? 'ok  ' : 'FAIL'} buy BLUECHIP with ${payWith === 'USDC' ? 'USDC' : 'NVDAc'} ${amountIn}: approve ${out[1].status}, swap ${out[2].status}, ` +
      `received ${Number(got) / 1e18} (quote ${Number(tx.quote.amountOut) / 1e18}, min ${Number(tx.minAmountOut) / 1e18}), fee ${tx.quote.feeBps} bp`,
  );
  return ok;
}

const results = [await tamper(), await simulate('USDC', '50000000'), await simulate('stock', '20000000')];
console.log(results.every(Boolean) ? '\nall meme-buy checks passed' : '\nSOME MEME-BUY CHECKS FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

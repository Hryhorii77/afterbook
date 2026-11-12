// Swap safety check (read-only: nothing is signed or broadcast). Run from the repo root:
//   SWAP_FEE_BPS=20 SWAP_FEE_RECIPIENT=0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae npx tsx --conditions=react-server .claude/skills/verify/swap-check.mts
// (--conditions=react-server: lib/swap/swapBuild.ts is 'server-only', which refuses to load without it)
// 1. Tamper: real KyberSwap calldata with one field changed at a time; checkSwapCalldata must refuse each.
// 2. Simulate (eth_simulateV1 on mainnet.base.org): approve + the server-built swap with the Builder Code
//    appended, from real holders (Morpho Blue for USDC, for NVDAc the first holder with enough: a market maker, else the NVDAc pool), for a buy and a sell; prints what the trader
//    received and what reached the fee recipient. Unset the fee variables to check that nothing does.
import { concat, decodeFunctionData, decodeFunctionResult, encodeFunctionData, erc20Abi, parseAbi, type Hex } from 'viem';
import { checkSwapCalldata, KYBER_ROUTER, parseSwapRequest, swapFee } from '../../../lib/swap/swap';
import { buildSwap, quoteSwap } from '../../../lib/swap/swapBuild';
import { getCachedPoolState, getClient, poolDepth } from '../../../lib/market/quote';
import { BUILDER_CODE_SUFFIX } from '../../../lib/wallet/builderCode';
import { getStock, STOCKS, USDC } from '../../../lib/stocks/tokens';

const stock = getStock('NVDAc')!;
/** Spends USDC for buys: Morpho Blue's contract (it holds plenty; read-only simulation). Not the NVDAc pool
 *  itself, as it was until 2026-11-04: when KyberSwap routed the buy through that pool, the pool paid
 *  itself mid-swap and the simulation reverted (`swap 0x0`) while real swaps were fine. */
const HOLDER = (process.env.USDC_HOLDER ?? '0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb') as Hex;
/** Who holds the NVDAc a sell spends. Holders drain (0xD0e2…C7f was empty by 2026-11-12, and every sell
 *  then simulated as a revert, `swap 0x0`), so the first of these with enough NVDAc is used: STOCK_HOLDER
 *  if set, a market-maker wallet (~79 NVDAc on 2026-11-03), then the NVDAc pool itself (it always holds
 *  NVDAc; fine for a sell, whose route takes NVDAc in, unlike the buy above). */
const STOCK_HOLDERS = [process.env.STOCK_HOLDER, '0xD0e2F1c6B4D604DA32AE5831E616d6553EFDCC7f', stock.pool.address].filter(Boolean) as Hex[];
async function stockHolder(amount: bigint): Promise<Hex> {
  for (const who of STOCK_HOLDERS) {
    const bal = await getClient().readContract({ address: stock.tokenAddress, abi: erc20Abi, functionName: 'balanceOf', args: [who] }).catch(() => BigInt(0));
    if (bal >= amount) return who;
  }
  throw new Error('no NVDAc holder with enough balance: set STOCK_HOLDER');
}
const EVIL = '0x2222222222222222222222222222222222222222' as const;
const fee = swapFee();
const watch = (fee?.recipient ?? EVIL) as Hex;

async function tamper() {
  const abi = parseAbi([
    'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
    'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
    'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)',
  ]);
  const req = parseSwapRequest({ symbol: 'NVDAc', side: 'buy', amountIn: '50000000' });
  if (typeof req === 'string') throw new Error(req);
  const tx = await buildSwap(req, HOLDER);
  const exec = decodeFunctionData({ abi, data: tx.data }).args[0];
  const remake = (patch: Record<string, unknown>) =>
    encodeFunctionData({ abi, functionName: 'swap', args: [{ ...exec, desc: { ...exec.desc, ...patch } }] }) as Hex;
  const cases: [string, Hex, boolean][] = [
    ['untouched', tx.data, true],
    ['recipient changed', remake({ dstReceiver: EVIL }), false],
    ['minimum lowered 2%', remake({ minReturnAmount: (exec.desc.minReturnAmount * 98n) / 100n }), false],
    ['minimum zero', remake({ minReturnAmount: 0n }), false],
    ['amount doubled', remake({ amount: exec.desc.amount * 2n }), false],
    ['output token swapped', remake({ dstToken: getStock('AAPLc')!.tokenAddress }), false],
    ['fee recipient changed', remake({ feeReceivers: fee ? [EVIL] : [EVIL], feeAmounts: [BigInt(fee?.bps ?? 20)] }), false],
    ['fee raised to 100 bp', remake({ feeReceivers: [fee?.recipient ?? EVIL], feeAmounts: [100n] }), false],
    ['permit added', remake({ permit: '0x1234' }), false],
  ];
  let ok = true;
  for (const [name, data, shouldPass] of cases) {
    let passed = true;
    try {
      checkSwapCalldata(req, HOLDER, fee, data, BigInt(tx.quote.amountOut));
    } catch {
      passed = false;
    }
    const good = passed === shouldPass;
    ok &&= good;
    console.log(`${good ? 'ok  ' : 'FAIL'} ${name.padEnd(22)} ${passed ? 'accepted' : 'refused'}`);
  }
  return ok;
}

async function simulate(side: 'buy' | 'sell', amountIn: string) {
  // NVDAc comes from stockHolder() above (a market maker first; the NVDAc pool only as a fallback).
  const holder = side === 'buy' ? HOLDER : await stockHolder(BigInt(amountIn));
  const req = parseSwapRequest({ symbol: 'NVDAc', side, amountIn });
  if (typeof req === 'string') throw new Error(req);
  const tx = await buildSwap(req, holder);
  const [inToken, outToken, outDecimals] = side === 'buy' ? [USDC.address, stock.tokenAddress, stock.decimals] : [stock.tokenAddress, USDC.address, USDC.decimals];
  const bal = (token: Hex, who: Hex) => ({ from: holder, to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'balanceOf', args: [who] }) });
  const calls = [
    bal(USDC.address, watch),
    bal(outToken as Hex, holder),
    { from: holder, to: inToken, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER, BigInt(amountIn)] }) },
    { from: holder, to: tx.to, data: concat([tx.data, BUILDER_CODE_SUFFIX]) },
    bal(USDC.address, watch),
    bal(outToken as Hex, holder),
  ];
  const res = await fetch('https://mainnet.base.org', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_simulateV1', params: [{ blockStateCalls: [{ calls }], validation: false }, 'latest'] }),
  }).then((r) => r.json());
  if (res.error) throw new Error(JSON.stringify(res.error));
  const r = res.result[0].calls as { status: string; returnData: Hex }[];
  const n = (i: number) => decodeFunctionResult({ abi: erc20Abi, functionName: 'balanceOf', data: r[i].returnData }) as bigint;
  const swapOk = r[2].status === '0x1' && r[3].status === '0x1';
  const got = Number(n(5) - n(1)) / 10 ** outDecimals;
  console.log(
    `${swapOk && got >= Number(tx.minAmountOut) / 10 ** outDecimals ? 'ok  ' : 'FAIL'} ${side} ${amountIn}: approve ${r[2].status}, swap ${r[3].status}, ` +
      `received ${got} (quote ${Number(tx.quote.amountOut) / 10 ** outDecimals}, min ${Number(tx.minAmountOut) / 10 ** outDecimals}), ` +
      `fee recipient +${Number(n(4) - n(0)) / 1e6} USDC at ${fee?.bps ?? 0} bp`,
  );
  return swapOk;
}

// The depth cap (MAX_BUY_DEPTH_SHARE): a buy over 10% of the pool's depth is refused with 400 and one under
// it is quoted. Run on a thin pool picked live (depth $20k-$150k, so $20,000 is over the cap and $500
// under it): a fixed pick broke when SONYc's ~$51k pool fell to ~$51 on 2026-11-12.
async function depthCap(): Promise<boolean> {
  let thin = '';
  for (const s of STOCKS) {
    const state = await getCachedPoolState(s).catch(() => null);
    const usd = state ? poolDepth(state, s).totalUsd : 0;
    if (usd >= 20_000 && usd <= 150_000) {
      thin = s.symbol;
      console.log(`depth cap on ${thin} (pool ~$${Math.round(usd).toLocaleString('en-US')})`);
      break;
    }
  }
  if (!thin) {
    console.log('FAIL depth cap: no tracked pool between $20k and $150k right now');
    return false;
  }
  const quote = (side: 'buy' | 'sell', amountIn: string) => {
    const req = parseSwapRequest({ symbol: thin, side, amountIn });
    if (typeof req === 'string') return Promise.resolve({ ok: false, status: 0, msg: req });
    return quoteSwap(req).then(() => ({ ok: true, status: 200, msg: '' }), (e) => ({ ok: false, status: e.status ?? 0, msg: String(e.message) }));
  };
  const cases: [string, Promise<{ ok: boolean; status: number; msg: string }>, (r: { ok: boolean; status: number; msg: string }) => boolean][] = [
    [`${thin} buy $20,000 (over 10% of depth)`, quote('buy', '20000000000'), (r) => !r.ok && r.status === 400 && /limited to/.test(r.msg)],
    [`${thin} buy $500 (under it)`, quote('buy', '500000000'), (r) => r.ok],
  ];
  let pass = true;
  for (const [name, p, want] of cases) {
    const r = await p;
    const ok = want(r);
    pass &&= ok;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(40)} ${r.ok ? 'quoted' : `refused ${r.status} ${r.msg}`}`);
  }
  return pass;
}

const results = [await tamper(), await simulate('buy', '100000000'), await simulate('sell', '10000000'), await depthCap()];
console.log(results.every(Boolean) ? '\nall swap checks passed' : '\nSOME SWAP CHECKS FAILED');
process.exit(results.every(Boolean) ? 0 : 1);

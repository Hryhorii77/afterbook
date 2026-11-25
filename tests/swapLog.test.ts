// The swap log counts a swap only after reading it back from the chain. A smart account (Base Account)
// swaps through a bundler's handleOps, so its router calls sit inside a user operation; these cases check
// that they count, once each, for the right account, and only when the user operation succeeded.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { concat, encodeAbiParameters, encodeEventTopics, encodeFunctionData, erc20Abi, getAddress, parseAbi, type Hex } from 'viem';
import { entryPoint06Abi } from 'viem/account-abstraction';

const r = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const index: string[] = [];
  return {
    store,
    index,
    redis: {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: unknown, o?: { nx?: boolean }) => {
        if (o?.nx && store.has(k)) return null;
        store.set(k, v);
        return 'OK';
      },
      zadd: async (_k: string, m: { member: string }) => void index.push(m.member),
      zrange: async () => [...index],
      mget: async (...keys: string[]) => keys.map((k) => store.get(k) ?? null),
      lrange: async (k: string, start: number) => ((store.get(k) as string[] | undefined) ?? []).slice(start),
      pipeline: () => {
        const ops: (() => void)[] = [];
        const p = {
          rpush: (k: string, v: string) => (ops.push(() => store.set(k, [...((store.get(k) as string[] | undefined) ?? []), v])), p),
          ltrim: (k: string, start: number) => (ops.push(() => store.set(k, ((store.get(k) as string[] | undefined) ?? []).slice(start))), p),
          expire: () => p,
          exec: async () => ops.forEach((o) => o()),
        };
        return p;
      },
    },
  };
});
vi.mock('../lib/server/redis', () => ({ redis: r.redis }));

const PROXY = '0x363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3';
const IMPL_V11 = '0x00000000000000000000000000000110dcdedc9581cb5ecb8467282f2926534d';
// Every account starts as a genuine Coinbase Smart Wallet v1.1; a test can change its code or slot.
const chain = vi.hoisted(() => ({
  tx: null as unknown, receipt: null as unknown,
  code: '' as string, slot: '' as string, // at the end of the swap's block (block 1)
  codeBefore: '' as string, slotBefore: '' as string, // at block 0
  upgrades: [] as unknown[],
}));
vi.mock('../lib/market/quote', () => ({
  getClient: () => ({
    waitForTransactionReceipt: async () => chain.receipt,
    getTransaction: async () => chain.tx,
    getBlock: async () => ({ timestamp: BigInt(1_800_000_000) }),
    getCode: async ({ blockNumber }: { blockNumber: bigint }) => (blockNumber === BigInt(1) ? chain.code : chain.codeBefore),
    getStorageAt: async ({ blockNumber }: { blockNumber: bigint }) => (blockNumber === BigInt(1) ? chain.slot : chain.slotBefore),
    request: async () => chain.upgrades,
  }),
}));

import { logSwap, planFills, rememberBuiltSwap, routerCalls, swapStats } from '../lib/swap/swapLog';
import { KYBER_ROUTER, type SwapTx } from '../lib/swap/swap';
import { BUILDER_CODE_SUFFIX } from '../lib/wallet/builderCode';
import { getStock, USDC } from '../lib/stocks/tokens';

const routerAbi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)',
]);
const walletAbi = parseAbi(['function executeBatch((address target, uint256 value, bytes data)[] calls)', 'function execute(address target, uint256 value, bytes data)']);

const EP = getAddress('0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789');
const ACCOUNT = getAddress('0x1111111111111111111111111111111111111111');
const OTHER = getAddress('0x3333333333333333333333333333333333333333');
const BUNDLER = getAddress('0x4444444444444444444444444444444444444444');
const EXEC = getAddress('0x2222222222222222222222222222222222222222');
const HASH = ('0x' + 'ab'.repeat(32)) as Hex;

const buyData = (symbol: string, usdc: number, to: Hex = ACCOUNT) =>
  encodeFunctionData({
    abi: routerAbi,
    functionName: 'swap',
    args: [{
      callTarget: EXEC, approveTarget: EXEC, targetData: '0x', clientData: '0x',
      desc: {
        srcToken: getAddress(USDC.address), dstToken: getAddress(getStock(symbol)!.tokenAddress), srcReceivers: [EXEC], srcAmounts: [BigInt(usdc * 1e6)],
        feeReceivers: [], feeAmounts: [], dstReceiver: to, amount: BigInt(usdc * 1e6), minReturnAmount: BigInt(1), flags: BigInt(0), permit: '0x',
      },
    }],
  });
const sellData = (symbol: string, amount: bigint) =>
  encodeFunctionData({
    abi: routerAbi,
    functionName: 'swap',
    args: [{
      callTarget: EXEC, approveTarget: EXEC, targetData: '0x', clientData: '0x',
      desc: {
        srcToken: getAddress(getStock(symbol)!.tokenAddress), dstToken: getAddress(USDC.address), srcReceivers: [EXEC], srcAmounts: [amount],
        feeReceivers: [], feeAmounts: [], dstReceiver: ACCOUNT, amount, minReturnAmount: BigInt(1), flags: BigInt(0), permit: '0x',
      },
    }],
  });
const remember = (data: Hex, symbol: string, side: 'buy' | 'sell' = 'buy', source: 'basket' | 'stock' = 'basket', account: Hex = ACCOUNT) =>
  rememberBuiltSwap({ data, quote: { symbol, side, feeBps: 0, amountInUsd: 1 } } as unknown as SwapTx, account, source);
const withCode = (d: Hex) => concat([d, BUILDER_CODE_SUFFIX]);
const approve = withCode(encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [KYBER_ROUTER, BigInt(100e6)] }));

function handleOps(callData: Hex, sender: Hex = ACCOUNT, nonce = BigInt(7), initCode: Hex = '0x'): Hex {
  const op = {
    sender, nonce, initCode, callData, callGasLimit: BigInt(1), verificationGasLimit: BigInt(1), preVerificationGas: BigInt(1),
    maxFeePerGas: BigInt(1), maxPriorityFeePerGas: BigInt(1), paymasterAndData: '0x' as Hex, signature: '0x' as Hex,
  };
  return encodeFunctionData({ abi: entryPoint06Abi, functionName: 'handleOps', args: [[op], BUNDLER] });
}
function opEvent(success: boolean, sender: Hex = ACCOUNT, nonce = BigInt(7), address: Hex = EP) {
  const topics = encodeEventTopics({ abi: entryPoint06Abi, eventName: 'UserOperationEvent', args: { userOpHash: ('0x' + '01'.repeat(32)) as Hex, sender, paymaster: '0x0000000000000000000000000000000000000000' } });
  const data = encodeAbiParameters([{ type: 'uint256' }, { type: 'bool' }, { type: 'uint256' }, { type: 'uint256' }], [nonce, success, BigInt(1), BigInt(1)]);
  return { address, topics: topics as [Hex, ...Hex[]], data };
}
const batch = (calls: { target: Hex; value?: bigint; data: Hex }[]) =>
  concat([encodeFunctionData({ abi: walletAbi, functionName: 'executeBatch', args: [calls.map((c) => ({ target: c.target, value: c.value ?? BigInt(0), data: c.data }))] }), BUILDER_CODE_SUFFIX]);
function usdcTransfer(from: Hex, to: Hex, usdc: number) {
  const topics = encodeEventTopics({ abi: erc20Abi, eventName: 'Transfer', args: { from, to } });
  return { address: getAddress(USDC.address), topics: topics as [Hex, ...Hex[]], data: encodeAbiParameters([{ type: 'uint256' }], [BigInt(usdc * 1e6)]) };
}
const swappedAbi = parseAbi(['event Swapped(address sender, address srcToken, address dstToken, address dstReceiver, uint256 spentAmount, uint256 returnAmount)']);
/** The router's own event for a swap it ran (what logSwap requires as proof). */
function swappedEvent(srcSymbol: string | 'USDC', dstSymbol: string | 'USDC', spent: bigint, returned: bigint, sender: Hex = ACCOUNT, address: Hex = KYBER_ROUTER) {
  const tok = (s: string) => getAddress(s === 'USDC' ? USDC.address : getStock(s)!.tokenAddress);
  const topics = encodeEventTopics({ abi: swappedAbi, eventName: 'Swapped' });
  const data = encodeAbiParameters(
    [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint256' }],
    [sender, tok(srcSymbol), tok(dstSymbol), ACCOUNT, spent, returned],
  );
  return { address, topics: topics as [Hex, ...Hex[]], data };
}
const bought = (symbol: string, usdc: number) => swappedEvent('USDC', symbol, BigInt(usdc * 1e6), BigInt(1));
function mine(tx: { to: Hex; from: Hex; input: Hex }, logs: ReturnType<typeof opEvent>[]) {
  chain.tx = tx;
  chain.receipt = { status: 'success', blockNumber: BigInt(1), logs };
}

/** A saved stock plan (the shape isSavedPlan accepts) buying `buys` (symbol → USD). */
function savedPlanWith(id: string, buys: Record<string, number>) {
  return {
    v: 1, id, at: 1, via: 'mcp', kind: 'plan', explanation: '', explainedBy: 'fixed',
    input: { symbols: Object.keys(buys), budgetUsd: 100, maxPremiumBp: 50, maxCostBp: 30, earningsDays: 2 },
    plan: { legs: Object.entries(buys).map(([symbol, usd]) => ({ symbol, verdict: 'buy', usd, reasons: [] })), budgetUsd: 100, plannedUsd: 10, session: {}, createdAt: 1 },
  };
}

beforeEach(() => {
  chain.code = chain.codeBefore = PROXY;
  chain.slot = chain.slotBefore = IMPL_V11;
  chain.upgrades = [];
  r.store.clear();
  r.index.length = 0;
});

describe('routerCalls', () => {
  const nvda = withCode(buyData('NVDAc', 40));
  const aapl = withCode(buyData('AAPLc', 60));
  it('reads a straight router transaction as one call by its sender', () => {
    expect(routerCalls({ to: KYBER_ROUTER, from: ACCOUNT, input: nvda }, [])).toEqual([{ account: ACCOUNT, input: nvda }]);
  });
  it("reads each router call in a successful user operation as the account's, skipping the approval", () => {
    const input = handleOps(batch([{ target: getAddress(USDC.address), data: approve }, { target: KYBER_ROUTER, data: nvda }, { target: KYBER_ROUTER, data: aapl }]));
    expect(routerCalls({ to: EP, from: BUNDLER, input }, [opEvent(true)])).toEqual([{ account: ACCOUNT, input: nvda, deployedBy: null }, { account: ACCOUNT, input: aapl, deployedBy: null }]);
  });
  it('reads a single execute call', () => {
    const callData = encodeFunctionData({ abi: walletAbi, functionName: 'execute', args: [KYBER_ROUTER, BigInt(0), nvda] });
    expect(routerCalls({ to: EP, from: BUNDLER, input: handleOps(callData) }, [opEvent(true)])).toEqual([{ account: ACCOUNT, input: nvda, deployedBy: null }]);
  });
  it('finds nothing when the user operation reverted, or its event is missing, from another contract, or for another nonce or sender', () => {
    const input = handleOps(batch([{ target: KYBER_ROUTER, data: nvda }]));
    expect(routerCalls({ to: EP, from: BUNDLER, input }, [opEvent(false)])).toEqual([]);
    expect(routerCalls({ to: EP, from: BUNDLER, input }, [])).toEqual([]);
    expect(routerCalls({ to: EP, from: BUNDLER, input }, [opEvent(true, ACCOUNT, BigInt(7), OTHER)])).toEqual([]);
    expect(routerCalls({ to: EP, from: BUNDLER, input }, [opEvent(true, ACCOUNT, BigInt(8))])).toEqual([]);
    expect(routerCalls({ to: EP, from: BUNDLER, input }, [opEvent(true, OTHER)])).toEqual([]);
  });
  it('ignores a router call that sends ETH, and transactions to anything but the router or an EntryPoint', () => {
    const input = handleOps(batch([{ target: KYBER_ROUTER, value: BigInt(1), data: nvda }]));
    expect(routerCalls({ to: EP, from: BUNDLER, input }, [opEvent(true)])).toEqual([]);
    expect(routerCalls({ to: OTHER, from: ACCOUNT, input: nvda }, [])).toEqual([]);
  });
});

describe('logSwap', () => {
  it('logs each swap of a one-signature basket batch once, for the account, with its own size', async () => {
    const legs = [buyData('NVDAc', 40), buyData('AAPLc', 60)];
    for (const [i, d] of legs.entries()) await remember(d, ['NVDAc', 'AAPLc'][i]);
    mine({ to: EP, from: BUNDLER, input: handleOps(batch([{ target: getAddress(USDC.address), data: approve }, ...legs.map((d) => ({ target: KYBER_ROUTER, data: withCode(d) }))])) }, [bought('NVDAc', 40), bought('AAPLc', 60), opEvent(true)]);
    const first = await logSwap(HASH);
    expect(first.ok && first.records.map((x) => [x.hash, x.symbol, x.usd, x.source])).toEqual([[`${HASH}:0`, 'NVDAc', 40, 'basket'], [`${HASH}:1`, 'AAPLc', 60, 'basket']]);
    expect(first.ok && first.duplicate).toBe(false);
    const again = await logSwap(HASH);
    expect(again.ok && again.duplicate).toBe(true);
    const s = await swapStats(7);
    expect([s?.swaps, s?.traders, s?.volumeUsd]).toEqual([2, 1, 100]);
  });
  it('still logs a swap sent straight to the router under its own hash', async () => {
    const d = buyData('NVDAc', 25);
    await remember(d, 'NVDAc', 'buy', 'stock');
    mine({ to: KYBER_ROUTER, from: ACCOUNT, input: withCode(d) }, [bought('NVDAc', 25)]);
    const res = await logSwap(HASH);
    expect(res.ok && res.records.map((x) => [x.hash, x.usd])).toEqual([[HASH, 25]]);
  });
  it('a plan link’s buy keeps its plan id, the stock received and the quote, and is listed under that plan (2026-11-25)', async () => {
    const d = buyData('NVDAc', 10);
    const PLAN = 'AbCdEfGhIjKlMnOp';
    r.store.set(`agentplan:${PLAN}`, savedPlanWith(PLAN, { NVDAc: 10 }));
    await rememberBuiltSwap({ data: d, minAmountOut: '6482000', quote: { symbol: 'NVDAc', side: 'buy', feeBps: 0, amountInUsd: 10, amountOut: '6514000' } } as unknown as SwapTx, ACCOUNT, 'agent', PLAN);
    mine({ to: KYBER_ROUTER, from: ACCOUNT, input: withCode(d) }, [swappedEvent('USDC', 'NVDAc', BigInt(10e6), BigInt(6543264))]);
    const res = await logSwap(HASH);
    expect(res.ok && res.records[0]).toMatchObject({ source: 'agent', planId: PLAN, amountOut: '6543264', quotedOut: '6514000', minOut: '6482000' });
    expect((await planFills(PLAN)).map((x) => x.hash)).toEqual([HASH]);
    // Reported again: still one fill.
    await logSwap(HASH);
    expect(await planFills(PLAN)).toHaveLength(1);
  });
  it('lists a fill only when the saved plan exists, listed the stock, and the buy is within its amount (review of #234)', async () => {
    const PLAN = 'AbCdEfGhIjKlMnOp';
    const run = async (plan: unknown, symbol: string, usdc: number) => {
      r.store.clear();
      if (plan) r.store.set(`agentplan:${PLAN}`, plan);
      const d = buyData(symbol, usdc);
      await rememberBuiltSwap({ data: d, minAmountOut: '1', quote: { symbol, side: 'buy', feeBps: 0, amountInUsd: usdc, amountOut: '2' } } as unknown as SwapTx, ACCOUNT, 'agent', PLAN);
      mine({ to: KYBER_ROUTER, from: ACCOUNT, input: withCode(d) }, [bought(symbol, usdc)]);
      const res = await logSwap(HASH);
      expect(res.ok).toBe(true); // still counted as a swap either way
      return (await planFills(PLAN)).length;
    };
    expect(await run(savedPlanWith(PLAN, { NVDAc: 10 }), 'NVDAc', 10)).toBe(1);
    expect(await run(null, 'NVDAc', 10)).toBe(0); // no such plan
    expect(await run(savedPlanWith(PLAN, { NVDAc: 10 }), 'AAPLc', 10)).toBe(0); // a stock the plan didn't list
    expect(await run(savedPlanWith(PLAN, { NVDAc: 10 }), 'NVDAc', 12)).toBe(0); // over the plan's amount
  });
  it('a plan id is kept only for a valid id on an agent or Telegram link’s buy', async () => {
    for (const [source, planId] of [['stock', 'AbCdEfGhIjKlMnOp'], ['agent', 'not-a-plan-id'], ['agent', undefined]] as const) {
      r.store.clear();
      const d = buyData('NVDAc', 10);
      await rememberBuiltSwap({ data: d, minAmountOut: '1', quote: { symbol: 'NVDAc', side: 'buy', feeBps: 0, amountInUsd: 10, amountOut: '2' } } as unknown as SwapTx, ACCOUNT, source, planId);
      mine({ to: KYBER_ROUTER, from: ACCOUNT, input: withCode(d) }, [bought('NVDAc', 10)]);
      const res = await logSwap(HASH);
      expect(res.ok && res.records[0].planId).toBeUndefined();
    }
  });
  it('refuses a swap built for another account, and one whose user operation reverted', async () => {
    const d = buyData('NVDAc', 40);
    await remember(d, 'NVDAc', 'buy', 'basket', OTHER);
    mine({ to: EP, from: BUNDLER, input: handleOps(batch([{ target: KYBER_ROUTER, data: withCode(d) }])) }, [bought('NVDAc', 40), opEvent(true)]);
    expect(await logSwap(HASH)).toEqual({ ok: false, reason: 'sent by a different account' });
    await remember(d, 'NVDAc');
    mine({ to: EP, from: BUNDLER, input: handleOps(batch([{ target: KYBER_ROUTER, data: withCode(d) }])) }, [opEvent(false)]);
    expect(await logSwap(HASH)).toEqual({ ok: false, reason: 'not a swap through the Afterbook router' });
  });
  it("refuses an operation that reports success but whose router never ran the swap (no matching Swapped event)", async () => {
    const d = buyData('NVDAc', 40);
    await remember(d, 'NVDAc');
    const input = handleOps(batch([{ target: KYBER_ROUTER, data: withCode(d) }]));
    const refused = { ok: false, reason: 'the router did not report this swap' };
    mine({ to: EP, from: BUNDLER, input }, [opEvent(true)]);
    expect(await logSwap(HASH)).toEqual(refused);
    mine({ to: EP, from: BUNDLER, input }, [swappedEvent('USDC', 'NVDAc', BigInt(40e6), BigInt(1), OTHER), opEvent(true)]);
    expect(await logSwap(HASH)).toEqual(refused);
    mine({ to: EP, from: BUNDLER, input }, [swappedEvent('USDC', 'NVDAc', BigInt(40e6), BigInt(1), ACCOUNT, OTHER), opEvent(true)]);
    expect(await logSwap(HASH)).toEqual(refused);
    mine({ to: EP, from: BUNDLER, input }, [bought('NVDAc', 1), opEvent(true)]);
    expect(await logSwap(HASH)).toEqual(refused);
    mine({ to: EP, from: BUNDLER, input }, [bought('AAPLc', 40), opEvent(true)]);
    expect(await logSwap(HASH)).toEqual(refused);
  });
  it('counts one build once: the same calldata twice in a batch, or again in another transaction, is one swap', async () => {
    const d = buyData('NVDAc', 40);
    await remember(d, 'NVDAc');
    mine({ to: EP, from: BUNDLER, input: handleOps(batch([{ target: KYBER_ROUTER, data: withCode(d) }, { target: KYBER_ROUTER, data: withCode(d) }])) }, [bought('NVDAc', 40), bought('NVDAc', 40), opEvent(true)]);
    const res = await logSwap(HASH);
    expect(res.ok && res.records.map((x) => x.hash)).toEqual([`${HASH}:0`]);
    const other = ('0x' + 'cd'.repeat(32)) as Hex;
    mine({ to: KYBER_ROUTER, from: ACCOUNT, input: withCode(d) }, [bought('NVDAc', 40)]);
    expect(await logSwap(other)).toEqual({ ok: false, reason: 'that build was already counted' });
    expect((await logSwap(HASH)).ok).toBe(true); // re-reporting the first is still fine
  });
  it("sizes a smart-account sell by what the router returned, not other USDC that reached the account in the same transaction", async () => {
    const d = sellData('NVDAc', BigInt(1e7));
    await remember(d, 'NVDAc', 'sell', 'stock');
    const input = handleOps(batch([{ target: KYBER_ROUTER, data: withCode(d) }, { target: OTHER, data: '0x' }]));
    mine({ to: EP, from: BUNDLER, input }, [usdcTransfer(EXEC, ACCOUNT, 18), usdcTransfer(OTHER, ACCOUNT, 25_000), usdcTransfer(ACCOUNT, ACCOUNT, 5000), swappedEvent('NVDAc', 'USDC', BigInt(1e7), BigInt(18e6)), opEvent(true)]);
    const res = await logSwap(HASH);
    expect(res.ok && res.records.map((x) => [x.side, x.usd])).toEqual([['sell', 18]]);
  });
  it('counts a user operation only from a genuine Coinbase Smart Wallet (its proxy or the 7702 proxy, pointing at a Coinbase implementation)', async () => {
    const d = buyData('NVDAc', 40);
    await remember(d, 'NVDAc');
    mine({ to: EP, from: BUNDLER, input: handleOps(batch([{ target: KYBER_ROUTER, data: withCode(d) }])) }, [bought('NVDAc', 40), opEvent(true)]);
    const refused = { ok: false, reason: 'not a swap through the Afterbook router' };
    chain.code = chain.codeBefore = '0x6080604052';
    expect(await logSwap(HASH)).toEqual(refused);
    chain.code = chain.codeBefore = PROXY;
    chain.slot = chain.slotBefore = '0x000000000000000000000000' + '55'.repeat(20);
    expect(await logSwap(HASH)).toEqual(refused);
    chain.code = chain.codeBefore = '0xef0100' + '66'.repeat(20);
    chain.slot = chain.slotBefore = IMPL_V11;
    expect(await logSwap(HASH)).toEqual(refused);
    chain.code = chain.codeBefore = '0xef01007702cb554e6bfb442cb743a7df23154544a7176c';
    const ok = await logSwap(HASH);
    expect(ok.ok && ok.records.map((x) => x.hash)).toEqual([`${HASH}:0`]);
    expect(await logSwap(HASH)).toEqual({ ok: true, records: [], duplicate: true }); // done: no chain reads again
  });
  it('refuses an account that only looks genuine at the end of the block: other code before it, an upgrade in it, or deployed by a factory that is not Coinbase\'s', async () => {
    const d = buyData('NVDAc', 40);
    await remember(d, 'NVDAc');
    const refused = { ok: false, reason: 'not a swap through the Afterbook router' };
    const op = (initCode: Hex = '0x') => mine({ to: EP, from: BUNDLER, input: handleOps(batch([{ target: KYBER_ROUTER, data: withCode(d) }]), ACCOUNT, BigInt(7), initCode) }, [bought('NVDAc', 40), opEvent(true)]);
    op();
    chain.slotBefore = '0x000000000000000000000000' + '55'.repeat(20); // ran under another implementation, then wrote the genuine one back
    expect(await logSwap(HASH)).toEqual(refused);
    chain.slotBefore = IMPL_V11;
    const upgraded = (impl: string) => ({ topics: ['0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b', '0x000000000000000000000000' + impl.slice(2)] });
    chain.upgrades = [upgraded('0x' + '55'.repeat(20)), upgraded('0x00000110dcdedc9581cb5ecb8467282f2926534d')]; // to other code and back within the block
    expect(await logSwap(HASH)).toEqual(refused);
    chain.upgrades = [upgraded('0x00000110dcdedc9581cb5ecb8467282f2926534d')]; // only ever a Coinbase implementation
    expect((await logSwap(HASH)).ok).toBe(true);
    r.store.clear();
    await remember(d, 'NVDAc');
    chain.upgrades = [];
    chain.codeBefore = '0x';
    chain.slotBefore = '0x' + '00'.repeat(32);
    op(('0x' + '77'.repeat(20) + 'abcd') as Hex); // deployed in this operation by someone else's factory
    expect(await logSwap(HASH)).toEqual(refused);
    op(('0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842' + 'abcd') as Hex); // deployed by Coinbase's v1.1 factory
    const ok = await logSwap(HASH);
    expect(ok.ok && ok.records.map((x) => x.hash)).toEqual([`${HASH}:0`]);
  });
});

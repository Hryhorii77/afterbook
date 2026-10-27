// checkSwapCalldata is the last check before a transaction reaches a wallet: every field that decides
// what the user pays and receives must match the request. Each case below tampers with one field.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeFunctionData, getAddress, parseAbi, type Hex } from 'viem';
import { checkSwapCalldata, parseSwapRequest, swapFee, SLIPPAGE_BPS, type SwapRequest } from '../lib/swap';
import { getStock, USDC } from '../lib/tokens';

const routerAbi = parseAbi([
  'struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }',
  'struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }',
  'function swap(SwapExecutionParams execution) payable returns (uint256, uint256)',
  'function swapSimpleMode(address caller, SwapDescriptionV2 desc, bytes executorData, bytes clientData) returns (uint256, uint256)',
]);

const ACCOUNT = '0x1111111111111111111111111111111111111111' as const;
const EVIL = '0x2222222222222222222222222222222222222222' as const;
const FEE_RECIPIENT = '0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae' as const;
const nvda = getStock('NVDAc')!;
const amountIn = BigInt(100_000_000); // 100 USDC
const expectedOut = BigInt(45_900_000);
const minOut = (expectedOut * BigInt(10_000 - SLIPPAGE_BPS)) / BigInt(10_000);

function buyRequest(): SwapRequest {
  const req = parseSwapRequest({ symbol: 'NVDAc', side: 'buy', amountIn: amountIn.toString() });
  if (typeof req === 'string') throw new Error(req);
  return req;
}

type Desc = {
  srcToken: Hex;
  dstToken: Hex;
  srcReceivers: Hex[];
  srcAmounts: bigint[];
  feeReceivers: Hex[];
  feeAmounts: bigint[];
  dstReceiver: Hex;
  amount: bigint;
  minReturnAmount: bigint;
  flags: bigint;
  permit: Hex;
};

function goodDesc(): Desc {
  return {
    srcToken: getAddress(USDC.address),
    dstToken: getAddress(nvda.tokenAddress),
    srcReceivers: [EVIL],
    srcAmounts: [amountIn],
    feeReceivers: [],
    feeAmounts: [],
    dstReceiver: ACCOUNT,
    amount: amountIn,
    minReturnAmount: minOut,
    flags: BigInt(0),
    permit: '0x',
  };
}

const swapData = (desc: Desc) =>
  encodeFunctionData({ abi: routerAbi, functionName: 'swap', args: [{ callTarget: EVIL, approveTarget: EVIL, targetData: '0x', desc, clientData: '0x' }] });
const simpleData = (desc: Desc) => encodeFunctionData({ abi: routerAbi, functionName: 'swapSimpleMode', args: [EVIL, desc, '0x', '0x'] });

describe('checkSwapCalldata', () => {
  it('accepts the untouched swap, in both router functions, and returns the minimum', () => {
    expect(checkSwapCalldata(buyRequest(), ACCOUNT, null, swapData(goodDesc()), expectedOut)).toBe(minOut);
    expect(checkSwapCalldata(buyRequest(), ACCOUNT, null, simpleData(goodDesc()), expectedOut)).toBe(minOut);
  });

  const tampered: [string, (d: Desc) => void, RegExp][] = [
    ['recipient changed', (d) => (d.dstReceiver = EVIL), /recipient/],
    ['output token swapped', (d) => (d.dstToken = getAddress(getStock('AAPLc')!.tokenAddress)), /output token/],
    ['input token swapped', (d) => (d.srcToken = getAddress(nvda.tokenAddress)), /input token/],
    ['amount doubled', (d) => (d.amount = amountIn * BigInt(2)), /amount/],
    ['minimum lowered 2%', (d) => (d.minReturnAmount = (expectedOut * BigInt(98)) / BigInt(100)), /minimum/],
    ['minimum zero', (d) => (d.minReturnAmount = BigInt(0)), /minimum/],
    ['minimum above the quote', (d) => (d.minReturnAmount = expectedOut + BigInt(1)), /minimum/],
    ['permit added', (d) => (d.permit = '0x1234'), /permit/],
    ['split amounts above the amount', (d) => (d.srcAmounts = [amountIn, BigInt(1)]), /split amounts/],
    ['a fee nobody asked for', (d) => ((d.feeReceivers = [EVIL]), (d.feeAmounts = [BigInt(20)])), /fee/],
  ];
  for (const [name, tamper, why] of tampered) {
    it(`refuses: ${name}`, () => {
      const desc = goodDesc();
      tamper(desc);
      expect(() => checkSwapCalldata(buyRequest(), ACCOUNT, null, swapData(desc), expectedOut)).toThrow(why);
    });
  }

  it('refuses calldata that is not a router swap', () => {
    expect(() => checkSwapCalldata(buyRequest(), ACCOUNT, null, '0xdeadbeef', expectedOut)).toThrow(/not a KyberSwap router swap/);
  });

  describe('with Afterbook fee on', () => {
    const fee = { bps: 20, recipient: FEE_RECIPIENT };
    const withFee = (recipient: Hex, bps: bigint) => ({ ...goodDesc(), feeReceivers: [recipient], feeAmounts: [bps] });
    it('accepts exactly our fee', () => {
      expect(checkSwapCalldata(buyRequest(), ACCOUNT, fee, swapData(withFee(FEE_RECIPIENT, BigInt(20))), expectedOut)).toBe(minOut);
    });
    it('refuses a changed fee recipient', () => {
      expect(() => checkSwapCalldata(buyRequest(), ACCOUNT, fee, swapData(withFee(EVIL, BigInt(20))), expectedOut)).toThrow(/fee/);
    });
    it('refuses a raised fee', () => {
      expect(() => checkSwapCalldata(buyRequest(), ACCOUNT, fee, swapData(withFee(FEE_RECIPIENT, BigInt(100))), expectedOut)).toThrow(/fee/);
    });
    it('refuses a missing fee', () => {
      expect(() => checkSwapCalldata(buyRequest(), ACCOUNT, fee, swapData(goodDesc()), expectedOut)).toThrow(/fee/);
    });
  });
});

describe('parseSwapRequest', () => {
  it('takes a tracked stock, a side and a raw amount', () => {
    const req = parseSwapRequest({ symbol: 'SONYc', side: 'sell', amountIn: '12345' });
    expect(typeof req).toBe('object');
    expect(req).toMatchObject({ side: 'sell', amountIn: BigInt(12345) });
  });
  it.each([
    [{ symbol: 'NOTASTOCK', side: 'buy', amountIn: '1' }, /unknown symbol/],
    [{ symbol: 'USDC', side: 'buy', amountIn: '1' }, /unknown symbol/],
    [{ symbol: 'NVDAc', side: 'short', amountIn: '1' }, /side/],
    [{ symbol: 'NVDAc', side: 'buy', amountIn: '1.5' }, /raw integer/],
    [{ symbol: 'NVDAc', side: 'buy', amountIn: '-1' }, /raw integer/],
    [{ symbol: 'NVDAc', side: 'buy', amountIn: 100 }, /raw integer/],
    [{ symbol: 'NVDAc', side: 'buy', amountIn: '0' }, /above zero/],
  ])('refuses %o', (input, why) => {
    expect(parseSwapRequest(input)).toMatch(why);
  });
});

describe('swapFee', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('is off when nothing is set', () => {
    vi.stubEnv('SWAP_FEE_BPS', '');
    vi.stubEnv('SWAP_FEE_RECIPIENT', '');
    expect(swapFee()).toBeNull();
  });
  it('is off when only half configured', () => {
    vi.stubEnv('SWAP_FEE_BPS', '20');
    vi.stubEnv('SWAP_FEE_RECIPIENT', '');
    expect(swapFee()).toBeNull();
  });
  it.each(['0', '101', '2.5', 'abc'])('is off for bps %s', (bps) => {
    vi.stubEnv('SWAP_FEE_BPS', bps);
    vi.stubEnv('SWAP_FEE_RECIPIENT', FEE_RECIPIENT);
    expect(swapFee()).toBeNull();
  });
  it('is on with a valid bps and recipient, trimmed and checksummed', () => {
    vi.stubEnv('SWAP_FEE_BPS', ' 20 ');
    vi.stubEnv('SWAP_FEE_RECIPIENT', ` ${FEE_RECIPIENT.toLowerCase()} `);
    expect(swapFee()).toEqual({ bps: 20, recipient: FEE_RECIPIENT });
  });
});

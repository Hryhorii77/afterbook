import { getClient } from './quote';
import { USDC } from './tokens';

/** contracts/jensen-buyback-burn — the real, $50-threshold deployment.
 *  Verified on-chain (immutable params match script/Deploy.s.sol) before
 *  X402_PAYOUT_ADDRESS was pointed at it. No owner, no pause: this app only
 *  ever reads its state, never calls into it. */
export const JENSEN_BUYBACK_BURN_ADDRESS = '0xE3c85FA7Af7b03F5dc7FE168b13fA96F6e14dC2E' as const;

const BALANCE_OF_ABI = [
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
] as const;

const CAN_EXECUTE_ABI = [
  { type: 'function', name: 'canExecute', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
] as const;

export interface JensenBurnStatus {
  ready: boolean;
  usdcBalance: bigint;
}

export async function getJensenBurnStatus(): Promise<JensenBurnStatus> {
  const client = getClient();
  const [ready, usdcBalance] = await Promise.all([
    client.readContract({
      address: JENSEN_BUYBACK_BURN_ADDRESS,
      abi: CAN_EXECUTE_ABI,
      functionName: 'canExecute',
    }),
    client.readContract({
      address: USDC.address,
      abi: BALANCE_OF_ABI,
      functionName: 'balanceOf',
      args: [JENSEN_BUYBACK_BURN_ADDRESS],
    }),
  ]);
  return { ready, usdcBalance };
}

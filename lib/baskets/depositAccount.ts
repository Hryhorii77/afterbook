// The browser's own check that a Basis Tilt deposit address belongs to the connected wallet, before showing it or
// sending USDC to it. The address comes from Glider through our server, so a compromised server (or Glider) could
// otherwise hand out an attacker's address. Pure maths: no server and no chain read.
//
// Glider's Base accounts are ZeroDev Kernel v3.1 accounts made by KernelFactory v3.1 (through ZeroDev's meta
// factory) with CREATE2. The address commits to the account's initialisation: root validator ZeroDev's
// MultiChainValidator (source verified on Sourcify) with the owner as its signer, no hook, no other modules. So an
// address that recomputes from the connected wallet was created with that wallet as its only root signer (an
// undeployed one can only ever be deployed that way). The maths can't see later changes the account made (a new
// root validator, an upgrade), so for a deployed account `deployedAccountProblem` also reads those from the chain.
// The salt is not secret and needs no trust: whatever salt is used, the owner is inside the hashed data. Glider's
// salts appear to be 0x8b0300 + the enrollment's account index (0x8b0329, 0x8b032a and 0x8b0335 on chain,
// 2026-11-19); a salt outside the scanned range fails closed.
//
// Read from a real deployment (2026-11-19, tx 0x7ecd46d0…efc8b): meta factory 0xd703…42d5 deployWithFactory(
// KernelFactory 0xaac5…E419, initialize(0x01‖0x5c97…4f5f, 0x0, owner, 0x, []), salt). Glider's agent gets its
// limited permission later, enabled by the owner's enrollment signature; that is by design and not checked here.
import { concat, encodeFunctionData, encodePacked, getAddress, getContractAddress, keccak256, pad, parseAbi, toHex, type Address, type Hex, type PublicClient } from 'viem';

export const KERNEL_FACTORY_V3_1: Address = '0xaac5D4240AF87249B3f71BC8E4A2cae074A3E419';
export const KERNEL_V3_1_IMPLEMENTATION: Address = '0xBAC849bB641841b44E965fB01A4Bf5F074f84b4D';
/** Kernel's ValidationId: 0x01 (a validator) followed by ZeroDev's MultiChainValidator. */
export const GLIDER_ROOT_VALIDATOR: Hex = '0x015c97aa67ba578e3c54ec5942a7563ea9130e4f5f';
export const GLIDER_SALT_BASE = BigInt(0x8b0300);
export const GLIDER_SALT_SCAN = 4096;

const kernelAbi = parseAbi(['function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)']);

// Solady LibClone's ERC-1967 proxy init code (what KernelFactory deploys), for this implementation.
const PROXY_INIT_CODE_HASH = keccak256(
  concat([
    '0x603d3d8160223d3973',
    KERNEL_V3_1_IMPLEMENTATION,
    '0x60095155f3363d3d373d3d363d7f360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc545af43d6000803e6038573d6000fd5b3d6000f3',
  ]),
);

const initData = (owner: Address) =>
  encodeFunctionData({
    abi: kernelAbi,
    functionName: 'initialize',
    args: [GLIDER_ROOT_VALIDATOR, '0x0000000000000000000000000000000000000000', owner, '0x', []],
  });

const addressFor = (data: Hex, salt: bigint): Address =>
  getContractAddress({
    opcode: 'CREATE2',
    from: KERNEL_FACTORY_V3_1,
    salt: keccak256(encodePacked(['bytes', 'bytes32'], [data, pad(toHex(salt), { size: 32 })])),
    bytecodeHash: PROXY_INIT_CODE_HASH,
  });

/** The address KernelFactory v3.1 gives a Glider-style account for this owner and salt. */
export function gliderKernelAddress(owner: Address, salt: bigint): Address {
  return addressFor(initData(owner), salt);
}

// owner|account → salt or null, so a refusal doesn't rescan (the panel checks on render and again on send).
const found = new Map<string, bigint | null>();

/** The salt under which `account` is this owner's Glider account, or null if none in the scanned range. */
export function findGliderSalt(owner: Address, account: Address): bigint | null {
  const want = getAddress(account);
  const key = `${getAddress(owner)}|${want}`;
  if (found.has(key)) return found.get(key)!;
  const data = initData(owner);
  let hit: bigint | null = null;
  for (let i = 0; i < GLIDER_SALT_SCAN && hit === null; i++) {
    const salt = GLIDER_SALT_BASE + BigInt(i);
    if (addressFor(data, salt) === want) hit = salt;
  }
  if (found.size > 64) found.clear();
  found.set(key, hit);
  return hit;
}

const BASE_PREFIX = 'eip155:8453:';

/**
 * Null when the Base deposit account Glider reported is the connected wallet's own Kernel account; otherwise why
 * not. `depositAccountId` (a Solana field) must be absent or the same account.
 */
export function depositAccountProblem(
  owner: string | undefined,
  account: { accountId: unknown; depositAccountId?: unknown } | undefined,
): string | null {
  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) return 'Connect a wallet first.';
  if (!account || typeof account.accountId !== 'string' || !account.accountId.startsWith(BASE_PREFIX)) {
    return 'Glider did not report a Base account for this portfolio.';
  }
  const dep = account.depositAccountId;
  if (dep != null && (typeof dep !== 'string' || dep.toLowerCase() !== account.accountId.toLowerCase())) {
    return 'Glider reported a deposit address that is not the account itself.';
  }
  const addr = account.accountId.slice(BASE_PREFIX.length);
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) return 'Glider reported a malformed account address.';
  if (findGliderSalt(getAddress(owner), getAddress(addr)) === null) {
    return 'This address could not be confirmed as an account owned by your wallet, so it is not shown and nothing can be sent to it.';
  }
  return null;
}

const IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const accountAbi = parseAbi(['function rootValidator() view returns (bytes21)']);
const validatorAbi = parseAbi(['function ecdsaValidatorStorage(address) view returns (address)']);

export type DeployedAccountStatus =
  | { state: 'ok' }
  | { state: 'mismatch'; problem: string }
  | { state: 'unread'; problem: string };

/**
 * For an account that passed `depositAccountProblem`: if it is deployed, its implementation, root validator and that
 * validator's signer must still be the ones it was created with (the maths can't see an upgrade or a new root).
 * `ok` when they are, or when it is not deployed yet (then the maths alone decides); `mismatch` when the chain shows
 * something else; `unread` when the chain couldn't be read. Deposits refuse both; a withdrawal is never blocked by it (a mismatch only warns). An empty implementation slot
 * counts as a mismatch.
 */
export async function deployedAccountStatus(
  client: Pick<PublicClient, 'getCode' | 'getStorageAt' | 'readContract'>,
  owner: Address,
  account: Address,
): Promise<DeployedAccountStatus> {
  const unread: DeployedAccountStatus = {
    state: 'unread',
    problem: 'Couldn\u2019t read your Basis Tilt account on Base to confirm it is still yours. Nothing can be sent until it can; press Refresh.',
  };
  let code: string | undefined;
  try {
    code = await client.getCode({ address: account });
  } catch {
    return unread;
  }
  if (!code || code === '0x') return { state: 'ok' };
  // Each read on its own: any value that comes back wrong is a mismatch, even if another read failed. A read that
  // fails, or an answer that can't be parsed, only counts as unread.
  const [slot, root, signer] = await Promise.allSettled([
    client.getStorageAt({ address: account, slot: IMPL_SLOT }),
    client.readContract({ address: account, abi: accountAbi, functionName: 'rootValidator' }),
    client.readContract({ address: getAddress('0x' + GLIDER_ROOT_VALIDATOR.slice(4)), abi: validatorAbi, functionName: 'ecdsaValidatorStorage', args: [account] }),
  ]);
  const checks: (boolean | null)[] = [
    slot.status === 'fulfilled' ? parsed(() => (slot.value ? getAddress('0x' + slot.value.slice(-40)) : null) === KERNEL_V3_1_IMPLEMENTATION) : null,
    root.status === 'fulfilled' ? parsed(() => String(root.value).toLowerCase() === GLIDER_ROOT_VALIDATOR) : null,
    signer.status === 'fulfilled' ? parsed(() => getAddress(signer.value) === getAddress(owner)) : null,
  ];
  if (checks.includes(false)) {
    return {
      state: 'mismatch',
      problem: 'Your Basis Tilt account on Base is no longer set up the way it was created (another implementation, root validator or signer), so it is not shown and nothing can be sent to it.',
    };
  }
  return checks.includes(null) ? unread : { state: 'ok' };
}

/** A comparison on a value read from the chain; null when the value can't be parsed (counts as unread). */
function parsed(f: () => boolean): boolean | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/** `deployedAccountStatus` for deposits: null only when ok; a mismatch or a failed read is a problem (fail closed). */
export async function deployedAccountProblem(client: Pick<PublicClient, 'getCode' | 'getStorageAt' | 'readContract'>, owner: Address, account: Address): Promise<string | null> {
  const s = await deployedAccountStatus(client, owner, account);
  return s.state === 'ok' ? null : s.problem;
}

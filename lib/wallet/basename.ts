import { encodePacked, keccak256, namehash } from 'viem';
import { getClient } from '../market/quote';
import { normalizeBasename } from './walletInput';

// Base mainnet's L2Resolver — pulled from @coinbase/onchainkit's own
// constants.js (npm pack + read the source directly; docs.base.org kept
// redirecting to a migration notice with no technical content).
const L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD' as const;

const L2_RESOLVER_ABI = [
  {
    inputs: [{ internalType: 'bytes32', name: 'node', type: 'bytes32' }],
    name: 'name',
    outputs: [{ internalType: 'string', name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ internalType: 'bytes32', name: 'node', type: 'bytes32' }],
    name: 'addr',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

// The Basenames registry on Base: which resolver a name uses (2026-11-26, wallet lookup).
const BASENAMES_REGISTRY = '0xB94704422c2a1E396835A571837Aa5AE53285a95' as const;
const REGISTRY_ABI = [
  {
    inputs: [{ internalType: 'bytes32', name: 'node', type: 'bytes32' }],
    name: 'resolver',
    outputs: [{ internalType: 'address', name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
] as const;

/** The address a Basename points to on Base, or null (no such name, no resolver, or no address set). */
export async function addressOfBasename(input: string): Promise<`0x${string}` | null> {
  const name = normalizeBasename(input);
  if (!name) return null;
  const node = namehash(name);
  try {
    const client = getClient();
    const resolver = await client.readContract({ address: BASENAMES_REGISTRY, abi: REGISTRY_ABI, functionName: 'resolver', args: [node] });
    if (!resolver || /^0x0{40}$/i.test(resolver)) return null;
    const addr = await client.readContract({ address: resolver, abi: L2_RESOLVER_ABI, functionName: 'addr', args: [node] });
    return addr && !/^0x0{40}$/i.test(addr) ? addr : null;
  } catch {
    return null;
  }
}

const BASE_CHAIN_ID = 8453;

// ENSIP-11 coin type for an L2 chain: (0x80000000 | chainId) >>> 0, hex
// uppercased. Base's is 0x2105 -> 0x80002105 -> "80002105".
function coinTypeHex(chainId: number): string {
  return ((0x80000000 | chainId) >>> 0).toString(16).toUpperCase();
}

// Reproduces @coinbase/onchainkit's convertReverseNodeToBytes exactly
// (pulled from its actual source, not the generic docs) — this is the
// ENSIP-19 reverse-node computation, but specialized to a fixed chain
// (Base) rather than the general cross-chain CCIP-Read case.
//
// Deliberately hashes the address's hex characters as a *string*, not
// its raw bytes — dropping the "0x" prefix makes viem's keccak256 treat
// the input as UTF-8 text rather than hex-decoding it. That looks like a
// bug at first glance (it isn't 0x-prefixed) but it's exactly what the
// deployed L2Resolver expects: verified end-to-end against a real
// address (jesse.base.eth) — the 0x-prefixed "fix" silently returns
// nothing, this one correctly returns "jesse.base.eth".
function reverseNode(address: `0x${string}`): `0x${string}` {
  const addressNode = keccak256(address.slice(2).toLowerCase() as `0x${string}`);
  const baseReverseNode = namehash(`${coinTypeHex(BASE_CHAIN_ID)}.reverse`);
  return keccak256(encodePacked(['bytes32', 'bytes32'], [baseReverseNode, addressNode]));
}

/**
 * Resolves a Base address to its Basename, if one is set — a plain,
 * single-chain read against Base's own L2Resolver, no mainnet RPC
 * needed. Since the wallet lookup (2026-11-26) shows other people's
 * addresses too, a reverse name counts only if it also points forward
 * to the same address: anyone can set any reverse name on their own
 * address, so without that check an address could pose as someone
 * else's name.
 */
export async function resolveBasename(address: `0x${string}`): Promise<string | null> {
  try {
    const name = await getClient().readContract({
      address: L2_RESOLVER,
      abi: L2_RESOLVER_ABI,
      functionName: 'name',
      args: [reverseNode(address)],
    });
    if (!name) return null;
    const forward = await addressOfBasename(name);
    return forward && forward.toLowerCase() === address.toLowerCase() ? name : null;
  } catch {
    return null;
  }
}

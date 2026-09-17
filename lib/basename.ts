import { encodePacked, keccak256, namehash } from 'viem';
import { getClient } from './quote';

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
] as const;

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
 * needed. Deliberately skips OnchainKit's mainnet-ENS fallback and
 * forward-resolution spoof check: both exist for OnchainKit's
 * reusable-component case (displaying *any* address, including other
 * people's). This only ever resolves the caller's own connected
 * wallet's own address for their own display, so there's no
 * other-party impersonation surface to guard against.
 */
export async function resolveBasename(address: `0x${string}`): Promise<string | null> {
  try {
    const name = await getClient().readContract({
      address: L2_RESOLVER,
      abi: L2_RESOLVER_ABI,
      functionName: 'name',
      args: [reverseNode(address)],
    });
    return name || null;
  } catch {
    return null;
  }
}

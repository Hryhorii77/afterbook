// Afterbook's own test wallets, left out of the traction numbers (2026-11-21). The swap log stores a wallet
// only as a short hash (`walletId`), never the address, so the list is hashed the same way and records are
// matched by hash. Two sources: the owner's wallet below (public: it is also the x402 payout address), and
// TRACTION_TEST_WALLETS, comma-separated addresses or 16-hex wallet ids, set in Vercel for any other test
// wallet. Server code only (node:crypto).
import { createHash } from 'node:crypto';
import { isAddress } from 'viem';

/** The hashed wallet id the swap log stores. */
export const walletId = (addr: string) => createHash('sha256').update(addr.toLowerCase()).digest('hex').slice(0, 16);

/** The owner's own Coinbase Smart Wallet (the x402 payout address): every swap from it is a test. */
const OWNER_TEST_WALLETS = ['0x9b3F205E43dc9FcC1cc2Fe6d9dCD0357769A6Bae'];

/** Every test wallet as a hashed id. `extra` is the env value (a parameter, for tests). */
export function testWalletIds(extra = process.env.TRACTION_TEST_WALLETS ?? ''): Set<string> {
  const ids = new Set(OWNER_TEST_WALLETS.map(walletId));
  for (const raw of extra.split(',')) {
    const v = raw.trim();
    if (isAddress(v, { strict: false })) ids.add(walletId(v));
    else if (/^[0-9a-f]{16}$/i.test(v)) ids.add(v.toLowerCase());
  }
  return ids;
}

// The swap's fixed addresses and caps (2026-11-27), apart from swap.ts so /AGENTS.md (lib/agent/agentsMd.ts, built by
// plain Node) can state them; swap.ts re-exports them, so every caller and check reads the same values. Pure: no imports.

/** KyberSwap MetaAggregationRouterV2 on Base (verified source on Sourcify). The only contract a swap
 *  transaction may target and the only spender a swap approval may name. */
export const KYBER_ROUTER = '0x6131B5fae19EA4f9D964eAc0408E4408b66337b5' as const;
/** Largest single swap the panel builds, in USD. A UX guard, not a security control. */
export const MAX_SWAP_USD = 25_000;
/** A stock buy is also capped at this share of the stock's live pool depth (owner, 2026-10-27): the
 *  18 stocks added that day sit in pools of about $51k, where a $25k buy would move the price a long
 *  way. Pools over $250k are unaffected (the $25k cap is lower). A UX guard like MAX_SWAP_USD. */
export const MAX_BUY_DEPTH_SHARE = 0.1;

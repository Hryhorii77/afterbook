// The x402 prices, apart from x402.ts so the agent directory, /llms.txt and /AGENTS.md (and their generator,
// scripts/generate-agents-md.mts, which runs in plain Node) can read them without loading the x402 packages.
export const X402_PRICE = '$0.02';

// Historical/derived endpoints (30-day basis history + tick distribution,
// LP-range recommendation) cost more to compute per call than a live
// tape/quote read — priced higher accordingly.
export const X402_PRICE_PREMIUM = '$0.05';

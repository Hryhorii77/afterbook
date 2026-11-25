import { x402ResourceServer } from '@x402/next';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { createFacilitatorConfig } from '@coinbase/x402';
import { bazaarResourceServerExtension } from '@x402/extensions/bazaar';
import { recordPaidCall, routeOf } from './x402Ledger';

// Machine-payable tier for agents: x402 settles via the facilitator (CDP's
// hosted service, confirmed to default to the real mainnet endpoint
// api.cdp.coinbase.com, not the testnet-only x402.org/facilitator shown in
// generic quick-starts), never by this app signing anything. CDP_API_KEY_ID/
// SECRET authenticate this server to Coinbase's facilitator API — platform
// credentials, not a blockchain key. The only on-chain fact this app
// supplies is where payment should land.
const CDP_API_KEY_ID = process.env.CDP_API_KEY_ID;
const CDP_API_KEY_SECRET = process.env.CDP_API_KEY_SECRET;
export const X402_PAYOUT_ADDRESS = process.env.X402_PAYOUT_ADDRESS as `0x${string}` | undefined;

const BASE_MAINNET_CAIP2 = 'eip155:8453';

export const x402Configured = Boolean(CDP_API_KEY_ID && CDP_API_KEY_SECRET && X402_PAYOUT_ADDRESS);

let server: x402ResourceServer | null = null;

/** Only call when x402Configured is true — callers gate on that at module
 *  load so an unconfigured deploy serves a clean 503 instead of this
 *  throwing or silently running unpriced. */
export function getX402Server(): x402ResourceServer {
  if (!server) {
    const facilitatorConfig = createFacilitatorConfig(CDP_API_KEY_ID, CDP_API_KEY_SECRET);
    const facilitatorClient = new HTTPFacilitatorClient(facilitatorConfig);
    // Bazaar discovery (2026-11-25): routes declare their inputs and an example output (lib/server/x402Discovery.ts) so
    // the facilitator can list them where agents search for paid services.
    server = new x402ResourceServer(facilitatorClient)
      .register(BASE_MAINNET_CAIP2, new ExactEvmScheme())
      .registerExtension(bazaarResourceServerExtension)
      // Every settled payment, once, for /traction's paid-call count (lib/server/x402Ledger.ts). Never throws:
      // an error here must not fail a call that was already paid.
      .onAfterSettle(async (ctx) => {
        try {
          if (!ctx.result.success || !ctx.result.transaction) return;
          await recordPaidCall({
            tx: ctx.result.transaction,
            route: routeOf(ctx.paymentPayload.resource?.url),
            amount: ctx.result.amount ?? ctx.requirements.amount,
            payer: ctx.result.payer ?? null,
            at: Date.now(),
          });
        } catch (err) {
          console.error('[x402] after-settle record failed', err instanceof Error ? err.message : err);
        }
      });
  }
  return server;
}

export const X402_NETWORK = BASE_MAINNET_CAIP2;
export const X402_PRICE = '$0.02';

// Historical/derived endpoints (30-day basis history + tick distribution,
// LP-range recommendation) cost more to compute per call than a live
// tape/quote read — priced higher accordingly.
export const X402_PRICE_PREMIUM = '$0.05';

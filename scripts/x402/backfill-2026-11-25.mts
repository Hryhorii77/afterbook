// Backfill (owner, 2026-11-25): the nine x402 calls paid from the owner's Bankr wallet before the ledger existed,
// found onchain (USDC transferWithAuthorization to the payout address), each matched to its route by the
// facilitator's crawl time (scripts/x402/find-payments.mts found them). Writes to production Redis through the same
// recordPaidCall (HSETNX keyed by transaction: running it again changes nothing). Run once on 2026-11-25, with the
// Redis variables from the local env file sourced (never printed).
import { recordPaidCall, paidCalls, summarizePaidCalls, type PaidCall } from '../../lib/server/x402Ledger';
const PAYER = '0x5338acAc2c7F5dbdfAfe0Ef4829B5c419d8c3F38';
const rows: [string, PaidCall['route'], string, string][] = [
  ['0x94ccaa1a784de047b268c5146a6a0c76ebf919e23c2f989808653d1d5c7425b5', 'plan', '50000', '2026-11-25T12:45:51Z'],
  ['0xff059495c097ec5bac69734a64629d5e1b1cc9e78c21694649845fad4f2e037d', 'basket', '50000', '2026-11-25T12:45:55Z'],
  ['0x38b5d208ab0a123a2ec3c819fb7df50bc236c7f1c50e0195548f9f8ec0efe628', 'history', '50000', '2026-11-25T12:45:57Z'],
  ['0x6a5e3a83b3f0520b6b4f79640d8db978b14fa033d9e9befe4574d3ed6df8185f', 'lp-range', '50000', '2026-11-25T12:45:59Z'],
  ['0x8fdfe17896d78cafa28c975d2a8014605a06ba13ff881b30253ae3c8d2f71b84', 'liquidation-capacity', '50000', '2026-11-25T12:46:02Z'],
  ['0xa5665d1b1d57bb2c5935920e2133a7c08b513abd07b7758f47b657419bdadb8a', 'tape', '20000', '2026-11-25T12:46:05Z'],
  ['0x4245a3422eed661b398f42f5bb1e15731fe422d2ec12506c195e843c98329c00', 'quote', '20000', '2026-11-25T12:46:06Z'],
  ['0x2a34cd0f351fcdf148334e6fa3dad7e137eee0bafffaeb943a95f5dbc6435461', 'execute-link', '20000', '2026-11-25T12:46:08Z'],
  ['0x4e398edc3d93bd040c5527d20408bfa8aaf00a915e4a8f8759118eac461c7fd2', 'loan-health', '20000', '2026-11-25T12:46:11Z'],
];
for (const [tx, route, amount, at] of rows) await recordPaidCall({ tx, route, amount, payer: PAYER, at: Date.parse(at) });
const calls = await paidCalls();
const s = summarizePaidCalls(calls ?? []);
console.log('ledger now:', s.calls, 'calls,', s.usdc.toFixed(2), 'USDC;', Object.keys(s.byRoute).length, 'routes');

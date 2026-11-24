// The verdict of a swap's dry run on Base just before the wallet sees it (useSwapWallet's simulateSwapCalls,
// 2026-11-24): 'reverts' only when the node ran the calls and one failed (or raised a revert); a node that
// can't simulate is 'unknown', which never blocks a swap. Pure, for the tests.
export type DryRun = 'ok' | 'reverts' | 'unknown';

export function dryRunVerdict(outcome: { results: { status: string }[] } | { error: unknown }): DryRun {
  if ('results' in outcome) return outcome.results.length > 0 && outcome.results.every((r) => r.status === 'success') ? 'ok' : outcome.results.length === 0 ? 'unknown' : 'reverts';
  const e = outcome.error as { shortMessage?: string; details?: string } | null;
  return /revert/i.test(`${e?.shortMessage ?? ''} ${e?.details ?? ''}`) ? 'reverts' : 'unknown';
}

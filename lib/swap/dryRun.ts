// The verdict of a swap's dry run on Base just before the wallet sees it (useSwapWallet's simulateSwapCalls,
// 2026-11-24): 'reverts' only when the node ran the calls and one failed (or raised a revert); a node that
// can't simulate is 'unknown', which never blocks a swap. Pure, for the tests.
export type DryRun = 'ok' | 'reverts' | 'unknown';

export function dryRunVerdict(outcome: { results: { status: string }[] } | { error: unknown }): DryRun {
  if ('results' in outcome) return outcome.results.length > 0 && outcome.results.every((r) => r.status === 'success') ? 'ok' : outcome.results.length === 0 ? 'unknown' : 'reverts';
  const e = outcome.error as { shortMessage?: string; details?: string } | null;
  return /revert/i.test(`${e?.shortMessage ?? ''} ${e?.details ?? ''}`) ? 'reverts' : 'unknown';
}

/** Right after an approval: whether the node has reached `target` (the approval's block), reading its head up to
 *  `tries` more times, `pauseMs` apart. False means it is still behind, and its dry run shouldn't be trusted to block
 *  a swap (2026-11-25: a lagging backup node could report a revert for a swap whose approval it hadn't seen). */
export async function reachesBlock(head: () => Promise<bigint>, target: bigint, tries = 4, pauseMs = 1000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))): Promise<boolean> {
  let now = await head();
  for (let i = 0; i < tries && now < target; i++) {
    await sleep(pauseMs);
    now = await head();
  }
  return now >= target;
}

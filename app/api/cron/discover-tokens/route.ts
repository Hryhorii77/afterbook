import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/server/redis';
import { sendTelegramMessage, sendTelegramMessageOk } from '@/lib/alerts/telegram';
import { fetchPublishedStockList, diffAgainstTracked, verifyCandidate, lowestRecentDepthUsd, recentWindowStart, type CandidateResult } from '@/lib/stocks/discovery';
import { usdCompact } from '@/lib/format';
import { cronAuthorized } from '@/lib/server/sharedSecret';
import { saveDirectoryPools } from '@/lib/stocks/stockDirectory';
import { fetchCoinbaseStockList } from '@/lib/stocks/coinbaseStockList';
import { checkCoinbaseList, recordGuardAlerts } from '@/lib/stocks/coinbaseListGuard';
import { computeLiquidBar } from '@/lib/market/liquidityBar';
import { refreshOpenLeaderboard } from '@/lib/market/openLeaderboard';

export const revalidate = 0;
// 120 s: after Denim (2026-11-05) each pool over $50k needs ~27 log reads for its three-hour low.
export const maxDuration = 120;

// Two Redis sets, so a token is reported when it first has an Aerodrome pool and
// again when that pool first becomes liquid, but never repeatedly.
const POOL_NOTIFIED_KEY = 'discover:notified';
const LIQUID_NOTIFIED_KEY = 'discover:liquid';
/** Listed tokens the site skips (splitListedTokens), by address and symbol, so each is reported once. */
const SKIPPED_NOTIFIED_KEY = 'discover:skipped';
/** Consecutive daily runs whose Coinbase list fetch failed. */
const FETCH_FAIL_KEY = 'cblist:fetchfail';
const MAX_SKIPPED_LINES = 10;
/** Depth at which a candidate is worth a ready-to-paste snippet. Half the tape's
 *  own "liquid" line, since the rows it would join start as thin books anyway. */
const SNIPPET_MIN_DEPTH_USD = 250_000;
const MAX_SNIPPETS_PER_RUN = 4;
const CONCURRENCY = 8;
/** A pool that reads over this on one read is judged by its lowest depth over STEADY_HOURS instead.
 *  Well under the snippet line on purpose: on 2026-10-20 LLYc read $229k (under $250k, so it was not
 *  re-checked) and /stocks showed that, while its three-hour low was $29k. */
const STEADY_CHECK_FROM_USD = 50_000;
const STEADY_HOURS = 3;
const STEADY_CONCURRENCY = 3;

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// Daily: compares Coinbase's published tokenized-stock list against lib/stocks/tokens.ts
// and tells the maintainer (one digest message, not one per token) about names
// that now have a USDC pool (Aero or the older Aerodrome factory), with real depth, and once about any listed
// token the site skips (splitListedTokens: an unexpected symbol, no address, a duplicate). Never edits tokens.ts.
// ?dry=1 returns the digest without sending anything or writing to Redis.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const dry = request.nextUrl.searchParams.get('dry') === '1';
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!dry && (!redis || !adminChatId)) {
    return NextResponse.json({ ok: false, reason: 'discovery not configured' });
  }

  // The daily "Liquid" label (lib/market/liquidityBar.ts): each tracked stock's 72-hour depth low, saved for
  // /stocks and /memes. Display only; best effort, it never stops discovery, and it runs before the
  // Coinbase fetch so a failed fetch doesn't skip it. `?dry=1&bar=1` returns it unsaved.
  // And /today's open leaderboard (lib/market/openLeaderboard.ts), once a day before the open, so no visitor computes
  // it cold after a deploy. Best effort too; run alongside the bar.
  const [bar] = await Promise.all([
    computeLiquidBar({ save: !dry }).catch(() => null),
    refreshOpenLeaderboard({ save: !dry }).catch((err) => console.error('[discover-tokens] open leaderboard', err instanceof Error ? err.message : err)),
  ]);
  if (dry && request.nextUrl.searchParams.get('bar') === '1') return NextResponse.json({ ok: true, dry: true, bar });

  const raw = await fetchCoinbaseStockList({ cache: 'no-store' }).catch(() => null);
  if (!raw) {
    // Alert on the second failed day in a row (one failure is often a blip); the counter lives 3 days.
    if (!dry && redis) {
      const fails = await redis.incr(FETCH_FAIL_KEY).catch(() => 0);
      await redis.expire(FETCH_FAIL_KEY, 3 * 24 * 3600).catch(() => {});
      if (fails === 2) await sendTelegramMessage(adminChatId!, `Coinbase's tokenized-stock list could not be fetched on ${fails} daily runs in a row. /stocks, the icons and the meme job may be failing too.`).catch(() => {});
    }
    return NextResponse.json({ ok: false, reason: 'stock list fetch failed' });
  }
  if (!dry && redis) await redis.del(FETCH_FAIL_KEY).catch(() => {});
  // The list guard (lib/stocks/coinbaseListGuard.ts): saves the last good list, or alerts when the list shrank too
  // far or a tracked stock is missing from it. Runs before anything else so an alert is never skipped.
  const guard = await checkCoinbaseList(raw, { dry }).catch((err) => ({ saved: false, alerts: [`Coinbase list guard failed: ${(err as Error).message}`], error: true, useList: raw }));
  if (!dry) {
    if ('error' in guard) {
      for (const a of guard.alerts) await sendTelegramMessage(adminChatId!, a).catch(() => {});
    } else {
      // Send first, then record only what Telegram accepted, so a failed send is retried on the next run.
      const sent = new Set<string>();
      for (const c of guard.toSend) if (await sendTelegramMessageOk(adminChatId!, c.text)) sent.add(c.key);
      const staleSent = guard.staleReport ? await sendTelegramMessageOk(adminChatId!, guard.staleReport) : false;
      await recordGuardAlerts(guard, sent, staleSent).catch(() => {});
    }
  }
  if (dry && request.nextUrl.searchParams.get('guard') === '1') {
    const { useList, ...summary } = guard;
    return NextResponse.json({ ok: true, dry: true, guard: { ...summary, usingLastGood: useList !== raw } });
  }
  // Discovery and the /stocks pool data use the guarded list, so a shrunk list doesn't turn rows into "not checked".
  const listing = await fetchPublishedStockList(guard.useList).catch(() => null);
  if (!listing) return NextResponse.json({ ok: false, reason: 'stock list fetch failed' });
  const published = listing.stocks;

  const [poolSeen, liquidSeen, skippedSeen] = dry || !redis
    ? [new Set<string>(), new Set<string>(), new Set<string>()]
    : await Promise.all([redis.smembers(POOL_NOTIFIED_KEY), redis.smembers(LIQUID_NOTIFIED_KEY), redis.smembers(SKIPPED_NOTIFIED_KEY)]).then(
        ([a, b, c]) => [new Set(a), new Set(b), new Set(c)],
      );
  // Tokens Coinbase lists that /stocks and this check leave out (odd symbol, no address, a duplicate).
  const skipKey = (s: { symbol: string; address: string }) => `${s.address.toLowerCase()}|${s.symbol}`;
  const newSkipped = listing.skipped.filter((s) => !skippedSeen.has(skipKey(s)));

  const untracked = diffAgainstTracked(published);
  if (untracked.length === 0 && newSkipped.length === 0) return NextResponse.json({ ok: true, untracked: 0 });

  const checked = await inChunks(untracked, CONCURRENCY, async (t) => ({
    t,
    r: await verifyCandidate(t.symbol, t.tokenAddress, t.name).catch((): CandidateResult | null => null),
  }));

  // A pool over STEADY_CHECK_FROM_USD on one read is judged by the lowest it has been in the last few hours
  // (lowestRecentDepthUsd), so liquidity that comes and goes can't make it look liquid. Few pools
  // are over the line, so this is a few dozen log reads a pool, once a day. If the history can't be read the
  // pool keeps its one read but gets no snippet.
  const unsteady = new Set<string>();
  const toCheck = checked.filter((c) => c.r?.stock && (c.r.depthUsd ?? 0) >= STEADY_CHECK_FROM_USD);
  // One block search for the run, then up to STEADY_CONCURRENCY pools at a time: since Denim each
  // pool's three hours is ~27 log reads (4-6 s measured on 2026-11-05), and bot-filled pools come in groups.
  const fromBlock = toCheck.length > 0 ? await recentWindowStart(STEADY_HOURS).catch(() => null) : null;
  // The digest names the window it measured and the price it valued it at: a later check covers a later window at
  // another price (ANTc read $299k at the 13:00 run and $244k an hour later, 2026-11-20).
  const steadyEnd = new Date();
  const hhmm = (d: Date) => d.toISOString().slice(11, 16);
  const steadyWindow = `${hhmm(new Date(steadyEnd.getTime() - STEADY_HOURS * 3_600_000))}–${hhmm(steadyEnd)} UTC ${steadyEnd.toISOString().slice(0, 10)}`;
  await inChunks(toCheck, STEADY_CONCURRENCY, async (c) => {
    try {
      if (fromBlock == null) throw new Error('block window unreadable');
      c.r!.depthUsd = Math.min(c.r!.depthUsd ?? Infinity, await lowestRecentDepthUsd(c.r!.stock!, STEADY_HOURS, undefined, fromBlock));
    } catch (err) {
      console.error(`[discover-tokens] ${c.t.symbol}: liquidity history unreadable`, err);
      unsteady.add(c.t.symbol);
    }
  });

  // The /stocks page's pool column: every untracked token's pool and depth from this run (one write a day).
  // A failed check is left out, so the page shows it as not checked rather than as having no pool. Skipped when the
  // list guard itself failed: the list it ran on may be the collapsed one, and yesterday's pools stay up instead.
  if (!dry && !('error' in guard)) {
    await saveDirectoryPools({
      checkedAt: Date.now(),
      pools: Object.fromEntries(checked.filter((c) => c.r).map((c) => [c.t.symbol, { pool: c.r!.poolAddress, depthUsd: c.r!.depthUsd }])),
    });
  }

  const withPool = checked.filter((c) => c.r?.snippet);
  const noPool = checked.length - withPool.length;
  const liquid = (c: (typeof checked)[number]) => (c.r?.depthUsd ?? 0) >= SNIPPET_MIN_DEPTH_USD && !unsteady.has(c.t.symbol);

  // New this run: first time with a pool, or first time that pool is liquid.
  const newPool = withPool.filter((c) => !poolSeen.has(c.t.symbol));
  const newLiquid = withPool.filter((c) => liquid(c) && !liquidSeen.has(c.t.symbol));
  const reportable = [...new Set([...newPool, ...newLiquid])];

  if (reportable.length === 0 && newSkipped.length === 0) {
    return NextResponse.json({ ok: true, untracked: untracked.length, withPool: withPool.length, noPool, reported: 0 });
  }

  const lines = reportable
    .sort((a, b) => (b.r?.depthUsd ?? -1) - (a.r?.depthUsd ?? -1))
    .map((c) => `${c.t.symbol} — ${c.t.name || 'unnamed'} — ${c.r?.depthUsd != null ? `${usdCompact(c.r.depthUsd)} depth` : 'depth unreadable'}${unsteady.has(c.t.symbol) ? ' (one read; its history could not be checked)' : ''}`);
  const poolPart =
    reportable.length === 0
      ? ''
      : `Coinbase lists ${published.length + listing.skipped.length} tokenized stocks; ${untracked.length} aren't tracked here. ` +
        `New Aero or Aerodrome USDC pools since last check (${reportable.length}), deepest first:\n\n${lines.join('\n')}\n\n` +
        `${noPool} others have no pool yet (checked again daily). Depth over ${usdCompact(STEADY_CHECK_FROM_USD)} is the lowest it has been over ${steadyWindow}, valued at the ${hhmm(steadyEnd)} price; a later check covers a later window. Liquid ones get a snippet below; follow the add-tokenized-stock steps before adding.`;
  const skippedLines = newSkipped.slice(0, MAX_SKIPPED_LINES).map((s) => `${s.symbol} — ${s.address} — ${s.reason}`);
  if (newSkipped.length > MAX_SKIPPED_LINES) skippedLines.push(`…and ${newSkipped.length - MAX_SKIPPED_LINES} more`);
  const skippedPart =
    newSkipped.length === 0
      ? ''
      : `Skipped: Coinbase lists ${newSkipped.length} token${newSkipped.length === 1 ? '' : 's'} that /stocks and this check leave out:\n\n${skippedLines.join('\n')}\n\n` +
        `If one is a real stock, widen splitListedTokens in lib/stocks/coinbaseStockList.ts. Each is reported once.`;
  const digest = [poolPart, skippedPart].filter(Boolean).join('\n\n');

  const snippets = reportable.filter(liquid).slice(0, MAX_SNIPPETS_PER_RUN);

  if (dry) {
    return NextResponse.json({ ok: true, dry: true, digest, snippetFor: snippets.map((c) => c.t.symbol), skipped: newSkipped });
  }

  await sendTelegramMessage(adminChatId!, digest);
  for (const c of snippets) {
    await sendTelegramMessage(adminChatId!, `Ready-to-paste STOCKS entry for ${c.t.symbol} (${usdCompact(c.r!.depthUsd)} depth, the lowest over ${steadyWindow}, at the ${hhmm(steadyEnd)} price):\n\n${c.r!.snippet}`);
  }
  if (redis) {
    const store = redis;
    const remember = async (key: string, rows: typeof checked) => {
      const [first, ...rest] = rows.map((c) => c.t.symbol);
      if (first) await store.sadd(key, first, ...rest);
    };
    await remember(POOL_NOTIFIED_KEY, newPool);
    await remember(LIQUID_NOTIFIED_KEY, newLiquid);
    const [firstSkip, ...restSkip] = newSkipped.map(skipKey);
    if (firstSkip) await store.sadd(SKIPPED_NOTIFIED_KEY, firstSkip, ...restSkip);
  }

  return NextResponse.json({ ok: true, untracked: untracked.length, withPool: withPool.length, noPool, reported: reportable.length, snippets: snippets.length, skipped: newSkipped.length });
}

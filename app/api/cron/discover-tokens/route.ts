import { NextRequest, NextResponse } from 'next/server';
import { redis } from '@/lib/redis';
import { sendTelegramMessage } from '@/lib/telegram';
import { fetchPublishedStockList, diffAgainstTracked, verifyCandidate, lowestRecentDepthUsd, type CandidateResult } from '@/lib/discovery';
import { usdCompact } from '@/lib/format';
import { cronAuthorized } from '@/lib/sharedSecret';
import { saveDirectoryPools } from '@/lib/stockDirectory';

export const revalidate = 0;
export const maxDuration = 60;

// Two Redis sets, so a token is reported when it first has an Aerodrome pool and
// again when that pool first becomes liquid, but never repeatedly.
const POOL_NOTIFIED_KEY = 'discover:notified';
const LIQUID_NOTIFIED_KEY = 'discover:liquid';
/** Depth at which a candidate is worth a ready-to-paste snippet. Half the tape's
 *  own "liquid" line, since the rows it would join start as thin books anyway. */
const SNIPPET_MIN_DEPTH_USD = 250_000;
const MAX_SNIPPETS_PER_RUN = 4;
const CONCURRENCY = 8;
/** A pool over the line is judged by its lowest depth over this many hours, not by one read. */
const STEADY_HOURS = 3;

async function inChunks<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

// Daily: compares Coinbase's published tokenized-stock list against lib/tokens.ts
// and tells the maintainer (one digest message, not one per token) about names
// that now have an Aerodrome USDC pool, with real depth. Never edits tokens.ts.
// ?dry=1 returns the digest without sending anything or touching Redis.
export async function GET(request: NextRequest) {
  if (!cronAuthorized(request)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  const dry = request.nextUrl.searchParams.get('dry') === '1';
  const adminChatId = process.env.TELEGRAM_ADMIN_CHAT_ID;
  if (!dry && (!redis || !adminChatId)) {
    return NextResponse.json({ ok: false, reason: 'discovery not configured' });
  }

  const published = await fetchPublishedStockList().catch(() => null);
  if (!published) return NextResponse.json({ ok: false, reason: 'stock list fetch failed' });

  const untracked = diffAgainstTracked(published);
  if (untracked.length === 0) return NextResponse.json({ ok: true, untracked: 0 });

  const [poolSeen, liquidSeen] = dry || !redis
    ? [new Set<string>(), new Set<string>()]
    : await Promise.all([redis.smembers(POOL_NOTIFIED_KEY), redis.smembers(LIQUID_NOTIFIED_KEY)]).then(([a, b]) => [new Set(a), new Set(b)]);

  const checked = await inChunks(untracked, CONCURRENCY, async (t) => ({
    t,
    r: await verifyCandidate(t.symbol, t.tokenAddress, t.name).catch((): CandidateResult | null => null),
  }));

  // A pool over the line on one read is judged by the lowest it has been in the last few hours
  // (lowestRecentDepthUsd), so liquidity that comes and goes can't make it look liquid. Few pools
  // are over the line, so this is a handful of log reads a day. If the history can't be read the
  // pool keeps its one read but gets no snippet.
  const unsteady = new Set<string>();
  for (const c of checked) {
    if (!c.r?.stock || (c.r.depthUsd ?? 0) < SNIPPET_MIN_DEPTH_USD) continue;
    try {
      c.r.depthUsd = Math.min(c.r.depthUsd ?? Infinity, await lowestRecentDepthUsd(c.r.stock, STEADY_HOURS));
    } catch (err) {
      console.error(`[discover-tokens] ${c.t.symbol}: liquidity history unreadable`, err);
      unsteady.add(c.t.symbol);
    }
  }

  // The /stocks page's pool column: every untracked token's pool and depth from this run (one write a day).
  // A failed check is left out, so the page shows it as not checked rather than as having no pool.
  if (!dry) {
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

  if (reportable.length === 0) {
    return NextResponse.json({ ok: true, untracked: untracked.length, withPool: withPool.length, noPool, reported: 0 });
  }

  const lines = reportable
    .sort((a, b) => (b.r?.depthUsd ?? -1) - (a.r?.depthUsd ?? -1))
    .map((c) => `${c.t.symbol} — ${c.t.name || 'unnamed'} — ${c.r?.depthUsd != null ? `${usdCompact(c.r.depthUsd)} depth` : 'depth unreadable'}${unsteady.has(c.t.symbol) ? ' (one read; its history could not be checked)' : ''}`);
  const digest =
    `Coinbase lists ${published.length} tokenized stocks; ${untracked.length} aren't tracked here. ` +
    `New Aerodrome USDC pools since last check (${reportable.length}), deepest first:\n\n${lines.join('\n')}\n\n` +
    `${noPool} others have no pool yet (checked again daily). Depth over ${usdCompact(SNIPPET_MIN_DEPTH_USD)} is the lowest it has been in the last ${STEADY_HOURS} hours. Liquid ones get a snippet below; follow the add-tokenized-stock steps before adding.`;

  const snippets = reportable.filter(liquid).slice(0, MAX_SNIPPETS_PER_RUN);

  if (dry) {
    return NextResponse.json({ ok: true, dry: true, digest, snippetFor: snippets.map((c) => c.t.symbol) });
  }

  await sendTelegramMessage(adminChatId!, digest);
  for (const c of snippets) {
    await sendTelegramMessage(adminChatId!, `Ready-to-paste STOCKS entry for ${c.t.symbol} (${usdCompact(c.r!.depthUsd)} depth, the lowest in ${STEADY_HOURS} hours):\n\n${c.r!.snippet}`);
  }
  if (redis) {
    const store = redis;
    const remember = async (key: string, rows: typeof checked) => {
      const [first, ...rest] = rows.map((c) => c.t.symbol);
      if (first) await store.sadd(key, first, ...rest);
    };
    await remember(POOL_NOTIFIED_KEY, newPool);
    await remember(LIQUID_NOTIFIED_KEY, newLiquid);
  }

  return NextResponse.json({ ok: true, untracked: untracked.length, withPool: withPool.length, noPool, reported: reportable.length, snippets: snippets.length });
}

import { BRAND_BLUE, MARK_BARS, MARK_CRESCENT } from '@/lib/brand';
import { ImageResponse } from 'next/og';
import { unstable_cache } from 'next/cache';
import { getOpenSnapStats, MIN_DAYS_FOR_OPEN_SNAP, STATS_LOOKBACK_MS } from './history';
import { getTokenIcons } from './coinbaseIcons';
import { tileHue } from './symbolStyle';
import { getTape } from './tape';
import { splitByLiquidity } from './liquidity';
import { buildTodaySnapshot, closeBasisBp } from './todaySnapshot';
import { getStock } from './tokens';
import { parseSpec, basketGapBp, basketReferenceLabel } from './customBasket';
import { getBasketCost } from './basketCost';
import type { CardTheme } from './cardUrl';
import type { TapeResult } from './tape';
import { heroGapBp } from './shareText';
import { getBorrowSummary } from './liquidationRisk';
import { aeroExit, venueName, type BorrowSummary } from './borrowSummary';
import { usdCompact } from './format';
import { getMemeRow, venueLabel, type MemeRow } from './memestocks';
import { memePrice, pctMove } from './memeFormat';

/** A share's frozen numbers (lib/shareSnapshot.ts). Without one a card reads the live tape. */
export interface FrozenCard {
  tape: Pick<TapeResult, 'rows' | 'session'>;
  takenAt: number;
  basketCostBp?: number | null;
}

/** "Cash market open · 09:58 ET": the session plus the moment the numbers are from. */
function stampLabel(sessionLabel: string, atMs: number): string {
  if (!sessionLabel) return '';
  const t = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(atMs));
  return `${sessionLabel} · ${t} ET`;
}

// Card colours per theme: dark is the site's dark look, light uses the light tokens in
// app/globals.css. The person sharing picks it (whatever theme they had on), not the viewer.
const PALETTES = {
  dark: {
    bg: '#121214',
    bgImage: 'linear-gradient(180deg, #171719 0%, #121214 60%)',
    text: '#e6e9ef',
    dim: '#8b93a1',
    dimmer: '#6b7280',
    pos: '#3ddc97',
    neg: '#ff6b6b',
    tile: '#171719',
    tileBorder: '#232830',
    footer: '#9cd6ff',
  },
  light: {
    bg: '#fafaf9',
    bgImage: 'linear-gradient(180deg, #ffffff 0%, #fafaf9 60%)',
    text: '#111318',
    dim: '#4d5361',
    dimmer: '#646b79',
    pos: '#15803d',
    neg: '#dc2626',
    tile: '#ffffff',
    tileBorder: '#e4e4e1',
    footer: '#1f4fe0',
  },
} as const;
type Palette = (typeof PALETTES)[CardTheme];

function frame(c: Palette) {
  return {
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    backgroundColor: c.bg,
    backgroundImage: c.bgImage,
    padding: '64px 72px',
    fontFamily: 'sans-serif',
  } as const;
}

const gapColor = (c: Palette, n: number | null) => (n == null ? c.dim : n >= 0 ? c.pos : c.neg);

function Mark({ px }: { px: number }) {
  return (
    <svg width={px} height={px} viewBox="0 0 64 64" style={{ marginRight: px * 0.3 }}>
      <rect width="64" height="64" rx="16" fill={BRAND_BLUE} />
      <path d={MARK_CRESCENT} fill="#fff" />
      {MARK_BARS.map((b) => (
        <rect key={b.y} x={b.x} y={b.y} width={b.w} height={b.h} rx={b.h / 2} fill="#fff" opacity={b.opacity} />
      ))}
    </svg>
  );
}

export const OG_ALT = 'Afterbook: how far tokenized stocks on Base trade from the cash market';
export const OG_SIZE = { width: 1200, height: 630 };

const usd = (n: number | null) => (n == null ? '—' : `$${n.toFixed(2)}`);
const bp = (n: number | null) => (n == null ? '—' : `${n >= 0 ? '+' : ''}${n.toFixed(1)}bp`);

// Drawn by app/card/route.tsx, the one route behind every link preview and "Download card".
/**
 * Without `symbol`: the movers grid (up to 6 names), used for the root
 * share card. With `symbol`: a focused single-stock card for that name's
 * own page (/NVDAc etc.) — same visual language, one
 * subject instead of six, so a tweet linking a specific name shows that
 * name's actual numbers instead of a generic grid it isn't part of.
 */
export async function buildOgImage(symbol?: string, theme: CardTheme = 'dark', frozen?: FrozenCard) {
  const c = PALETTES[theme];
  let rows: Awaited<ReturnType<typeof getTape>>['rows'] = [];
  let sessionLabel = '';
  let focusRow: Awaited<ReturnType<typeof getTape>>['rows'][number] | null = null;
  let focusBp: number | null = null;
  let focusCashUsd: number | null = null;
  try {
    const tape = frozen?.tape ?? (await getTape());
    sessionLabel = stampLabel(tape.session.label, frozen?.takenAt ?? Date.now());

    if (symbol) {
      focusRow = tape.rows.find((r) => r.symbol.toLowerCase() === symbol.toLowerCase()) ?? null;
      // The page's own headline number and the cash price it is measured against (lib/shareText.ts).
      focusBp = heroGapBp(focusRow, tape.session);
      focusCashUsd = tape.session.state.startsWith('closed') ? focusRow?.closeUsd ?? null : focusRow?.cashLastUsd ?? null;
    } else {
      // Cards render in a single row — fine for 4 stocks, illegible for 10.
      // A thin pool's basis swings hundreds of bp on noise alone, so sorting
      // by |basis| across everything would flood the card with the least
      // meaningful numbers — show the real, liquid names first (still sorted
      // by |basis| among themselves), and only pad with thin ones if there's
      // room left.
      const byAbsBasis = (a: (typeof tape.rows)[number], b: (typeof tape.rows)[number]) =>
        Math.abs(b.basisBp ?? 0) - Math.abs(a.basisBp ?? 0);
      const { liquid, thin } = splitByLiquidity(tape.rows);
      rows = [...liquid.sort(byAbsBasis), ...thin.sort(byAbsBasis)].slice(0, 6);
    }
  } catch {
    // fall through to a branding-only card below
  }

  let fade: string | null = null;
  let icon: string | null = null;
  if (symbol && focusRow) [fade, icon] = await Promise.all([openFadeLine(focusRow.symbol), iconDataUri(focusRow.cashTicker)]);

  if (symbol && focusRow) {
    return new ImageResponse(
      (
        <div
          style={frame(c)}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Mark px={44} />
            <span style={{ fontSize: 40, fontWeight: 700, color: c.dim, letterSpacing: '-0.02em' }}>Afterbook</span>
            {sessionLabel && <span style={{ fontSize: 22, color: c.dimmer }}>{sessionLabel}</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', marginTop: 20 }}>
            <StockIcon icon={icon} cashTicker={focusRow.cashTicker} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 64, fontWeight: 700, color: c.text, letterSpacing: '-0.02em' }}>{focusRow.symbol}</span>
              <span style={{ fontSize: 24, color: c.dim }}>{focusRow.name}</span>
            </div>
          </div>

          <span
            style={{
              fontSize: 88,
              fontWeight: 700,
              marginTop: 8,
              color: gapColor(c, focusBp),
            }}
          >
            {bp(focusBp)}
          </span>

          <div style={{ display: 'flex', gap: 32, marginTop: 12, fontSize: 28, color: c.dim }}>
            <span>cash {usd(focusCashUsd)}</span>
            <span>aero {usd(focusRow.onchainMidUsd)}</span>
          </div>

          {fade && (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 22 }}>
              <span style={{ fontSize: 28, color: c.text }}>{fade}</span>
              <span style={{ fontSize: 20, color: c.dimmer, marginTop: 6 }}>Past sessions, not a forecast.</span>
            </div>
          )}

          <CardFooter c={c} />
        </div>
      ),
      { ...OG_SIZE },
    );
  }

  return new ImageResponse(
    (
      <div
        style={frame(c)}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Mark px={68} />
            <span style={{ fontSize: 64, fontWeight: 700, color: c.text, letterSpacing: '-0.02em' }}>
              Afterbook
            </span>
            {sessionLabel && <span style={{ fontSize: 24, color: c.dim }}>{sessionLabel}</span>}
          </div>
          <span style={{ fontSize: 26, color: c.dim, marginTop: 8 }}>
            How far tokenized stocks trade from the cash market.
          </span>
        </div>

        {rows.length > 0 && (
          <div style={{ display: 'flex', gap: 14, marginTop: 56 }}>
            {rows.map((row) => (
              <div
                key={row.symbol}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  flex: 1,
                  backgroundColor: c.tile,
                  border: `1px solid ${c.tileBorder}`,
                  borderRadius: 16,
                  padding: '20px 16px',
                }}
              >
                <span style={{ fontSize: 22, fontWeight: 700, color: c.text }}>{row.symbol}</span>
                <span
                  style={{
                    fontSize: 27,
                    fontWeight: 700,
                    marginTop: 12,
                    color: gapColor(c, row.basisBp),
                  }}
                >
                  {bp(row.basisBp)}
                </span>
                <span style={{ fontSize: 14, color: c.dim, marginTop: 8 }}>cash {usd(row.cashLastUsd)}</span>
                <span style={{ fontSize: 14, color: c.dim }}>aero {usd(row.onchainMidUsd)}</span>
              </div>
            ))}
          </div>
        )}

        <CardFooter c={c} />
      </div>
    ),
    { ...OG_SIZE },
  );
}

// The same "did the gap shrink after the 9:30 ET open" stat /today shows. Cached for 10 minutes
// (it barely moves, and link-preview crawlers hit this card in bursts) and given 3 seconds
// at most, so a slow Redis read leaves the line out instead of failing the card.
const getOpenFade = unstable_cache(
  async (symbol: string) => getOpenSnapStats(symbol, Date.now() - STATS_LOOKBACK_MS),
  ['og-open-fade-v1'],
  { revalidate: 600 },
);

async function openFadeLine(symbol: string): Promise<string | null> {
  try {
    const stats = await Promise.race([getOpenFade(symbol), new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))]);
    if (!stats || stats.days30 < MIN_DAYS_FOR_OPEN_SNAP) return null;
    return `${symbol}'s gap shrank within 30 min of the 9:30 ET open in ${stats.reverted30} of the last ${stats.days30} sessions.`;
  } catch {
    return null;
  }
}

/** The token's Coinbase icon as a data URI, or null. Coinbase serves these PNGs as
 *  "binary/octet-stream", so the bytes are checked for the PNG signature here (and a size
 *  cap) instead of trusting a remote <img>; any failure or a 3 second wait means the card
 *  draws a letter tile instead, never a broken image. The bytes ride Next's fetch cache. */
async function iconDataUri(cashTicker: string): Promise<string | null> {
  const work = (async () => {
    const url = (await getTokenIcons())[cashTicker];
    if (!url) return null;
    const res = await fetch(url, { next: { revalidate: 6 * 60 * 60 }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    return isPng && bytes.length <= 300_000 ? `data:image/png;base64,${bytes.toString('base64')}` : null;
  })();
  try {
    return await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))]);
  } catch {
    return null;
  }
}

/** Same tinted-tile look as the site's SymbolTile fallback, for when there is no icon. */
function tileColors(cashTicker: string): { background: string; color: string } {
  const hex = tileHue(cashTicker).replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return { background: `rgba(${r}, ${g}, ${b}, 0.22)`, color: `rgb(${r}, ${g}, ${b})` };
}

/** The line at the bottom of every card. It sits at the bottom RIGHT on purpose: X draws the image's
 *  alt text as a label in the bottom-left corner of a card, which used to cover this line. */
function CardFooter({ c }: { c: Palette }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 'auto', fontSize: 20, color: c.footer }}>
      Afterbook never holds your funds.
    </div>
  );
}

/** The stock's icon, or the tinted ticker tile when there is none (72px, shared by the cards). */
function StockIcon({ icon, cashTicker }: { icon: string | null; cashTicker: string }) {
  if (icon) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={icon} width={72} height={72} style={{ borderRadius: 18, marginRight: 22 }} />;
  }
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 72,
        height: 72,
        borderRadius: 18,
        marginRight: 22,
        fontSize: cashTicker.length > 4 ? 20 : 24,
        fontWeight: 700,
        ...tileColors(cashTicker),
      }}
    >
      {cashTicker}
    </div>
  );
}

/** app/today's own card — one number, not a grid. Distinct from buildOgImage
 *  above: that one either shows a specific requested symbol or a 6-wide
 *  movers grid, this shows the single row with the largest |basis|
 *  (lib/todaySnapshot.ts), same "one screenshot stat" this page is built
 *  around. A shared link pins `symbol` to the stock the page showed when it
 *  was shared: two names a few tenths of a bp apart swap the lead minute to
 *  minute, and the card used to show a different stock from the post. */
export async function buildTodayOgImage(symbol?: string, theme: CardTheme = 'dark', frozen?: FrozenCard) {
  const c = PALETTES[theme];
  let sessionLabel = '';
  let headline: Awaited<ReturnType<typeof getTape>>['rows'][number] | null = null;
  let headlineBp: number | null = null;
  let marketOpen = false;
  let fade: string | null = null;
  let icon: string | null = null;
  try {
    const tape = frozen?.tape ?? (await getTape());
    sessionLabel = stampLabel(tape.session.label, frozen?.takenAt ?? Date.now());
    marketOpen = tape.session.state === 'open';
    const snapshot = buildTodaySnapshot(tape);
    const pinned = symbol ? tape.rows.find((r) => r.symbol.toLowerCase() === symbol.toLowerCase()) : undefined;
    headline = pinned ?? snapshot.headline;
    headlineBp = headline ? (marketOpen ? headline.basisBp : closeBasisBp(headline)) : null;
    if (headline) [fade, icon] = await Promise.all([openFadeLine(headline.symbol), iconDataUri(headline.cashTicker)]);
  } catch {
    // fall through to a branding-only card below
  }

  return new ImageResponse(
    (
      <div
        style={frame(c)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Mark px={44} />
          <span style={{ fontSize: 40, fontWeight: 700, color: c.dim, letterSpacing: '-0.02em' }}>
            Afterbook · Today's gap
          </span>
          {sessionLabel && <span style={{ fontSize: 22, color: c.dimmer }}>{sessionLabel}</span>}
        </div>

        {headline ? (
          // A bare Fragment here (as opposed to buildOgImage's focus-card
          // above, which has no conditional wrapper at all) does not
          // flatten into ordinary flex siblings under satori/next-og —
          // confirmed live: it silently reorders and collapses these three
          // blocks instead of stacking them. A real flex-column div avoids
          // it and stacks correctly.
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 28 }}>
              <StockIcon icon={icon} cashTicker={headline.cashTicker} />
              <span style={{ fontSize: 64, fontWeight: 700, color: c.text, letterSpacing: '-0.02em' }}>{headline.symbol}</span>
            </div>

            <span
              style={{
                fontSize: 88,
                fontWeight: 700,
                marginTop: 8,
                color: gapColor(c, headlineBp),
              }}
            >
              {bp(headlineBp)}
            </span>

            <div style={{ display: 'flex', gap: 32, marginTop: 12, fontSize: 28, color: c.dim }}>
              <span>cash {usd(marketOpen ? headline.cashLastUsd : headline.closeUsd)}</span>
              <span>aero {usd(headline.onchainMidUsd)}</span>
            </div>

            {fade && (
              <div style={{ display: 'flex', flexDirection: 'column', marginTop: 22 }}>
                <span style={{ fontSize: 28, color: c.text }}>{fade}</span>
                <span style={{ fontSize: 20, color: c.dimmer, marginTop: 6 }}>Past sessions, not a forecast.</span>
              </div>
            )}
          </div>
        ) : (
          <span style={{ fontSize: 32, color: c.dim, marginTop: 48 }}>No basis reading yet.</span>
        )}

        <CardFooter c={c} />
      </div>
    ),
    { ...OG_SIZE },
  );
}

/** A custom basket's card (app/build/[spec]): its 2–4 legs with weights, the
 *  weighted gap the page leads with, and the cost to buy $10k of it. Same
 *  numbers and wording as the page (lib/customBasket.ts, lib/basketCost.ts). */
export async function buildBasketOgImage(spec: string, theme: CardTheme = 'dark', frozen?: FrozenCard) {
  const c = PALETTES[theme];
  const legs = parseSpec(spec);
  let sessionLabel = '';
  let gap: number | null = null;
  let reference = '';
  let costBp: number | null = null;
  let icons: (string | null)[] = [];
  if (legs) {
    try {
      const [tape, cost] = frozen
        ? [frozen.tape, null]
        : await Promise.all([getTape(), getBasketCost(legs).catch(() => null)]);
      sessionLabel = stampLabel(tape.session.label, frozen?.takenAt ?? Date.now());
      gap = basketGapBp(legs, tape.rows, tape.session.state);
      reference = basketReferenceLabel(legs, tape.rows, tape.session.state);
      costBp = frozen ? frozen.basketCostBp ?? null : cost?.points.find((p) => p.usd === 10_000)?.costBp ?? null;
      icons = await Promise.all(legs.map((l) => iconDataUri(getStock(l.symbol)!.cashTicker)));
    } catch {
      // fall through to legs-only card
    }
  }

  return new ImageResponse(
    (
      <div
        style={frame(c)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Mark px={44} />
          <span style={{ fontSize: 40, fontWeight: 700, color: c.dim, letterSpacing: '-0.02em' }}>Afterbook · Custom basket</span>
          {sessionLabel && <span style={{ fontSize: 22, color: c.dimmer }}>{sessionLabel}</span>}
        </div>

        {legs ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', gap: 28, marginTop: 32 }}>
              {legs.map((l, i) => (
                <div key={l.symbol} style={{ display: 'flex', alignItems: 'center' }}>
                  <StockIcon icon={icons[i] ?? null} cashTicker={getStock(l.symbol)!.cashTicker} />
                  <div style={{ display: 'flex', flexDirection: 'column' }}>
                    <span style={{ fontSize: 32, fontWeight: 700, color: c.text }}>{l.symbol}</span>
                    <span style={{ fontSize: 26, color: c.dim }}>{l.weightPct}%</span>
                  </div>
                </div>
              ))}
            </div>

            <span
              style={{
                fontSize: 88,
                fontWeight: 700,
                marginTop: 18,
                color: gapColor(c, gap),
              }}
            >
              {bp(gap)}
            </span>
            <span style={{ fontSize: 28, color: c.dim, marginTop: 4 }}>
              {gap == null ? 'No reading yet' : `Onchain vs ${reference.replace(/^the /, '')}`}
              {costBp != null ? ` · ${costBp.toFixed(1)} bp to buy $10k` : ''}
            </span>
          </div>
        ) : (
          <span style={{ fontSize: 32, color: c.dim, marginTop: 48 }}>Build a basket of Base tokenized stocks.</span>
        )}

        <CardFooter c={c} />
      </div>
    ),
    { ...OG_SIZE },
  );
}

/** /borrow: how much stock backs USDC loans, and per market its Aero exit (the page's word, in
 *  neutral colours: it is a worst case, not an alarm). Frozen numbers come from a share snapshot; otherwise read live. */
export async function buildBorrowOgImage(theme: CardTheme = 'dark', frozen?: { takenAt: number; borrow: BorrowSummary }) {
  const c = PALETTES[theme];
  let summary: BorrowSummary | null = frozen?.borrow ?? null;
  if (!summary) summary = await getBorrowSummary().catch(() => null);
  const takenAt = frozen?.takenAt ?? Date.now();
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(takenAt));
  const rows = summary?.rows.slice(0, 4) ?? [];
  const rowIcons = await Promise.all(rows.map((r) => iconDataUri(getStock(r.symbol)?.cashTicker ?? r.symbol)));

  return new ImageResponse(
    (
      <div style={frame(c)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Mark px={44} />
          <span style={{ fontSize: 40, fontWeight: 700, color: c.dim, letterSpacing: '-0.02em' }}>Afterbook · Stock loans</span>
          <span style={{ fontSize: 22, color: c.dimmer }}>{time} ET</span>
        </div>

        {summary && rows.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 52, fontWeight: 700, color: c.text, marginTop: 26, letterSpacing: '-0.02em' }}>
              {usdCompact(summary.collateralUsd)} of stock backs USDC loans
            </span>
            <span style={{ fontSize: 26, color: c.dim, marginTop: 6 }}>
              Aave and Morpho on Base · {usdCompact(summary.borrowUsd)} borrowed · can Aerodrome absorb a liquidation?
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 22, gap: 12 }}>
              {rows.map((r, i) => {
                const cashTicker = getStock(r.symbol)?.cashTicker ?? r.symbol;
                const icon = rowIcons[i];
                return (
                  <div key={`${r.venue}-${r.symbol}`} style={{ display: 'flex', alignItems: 'center', fontSize: 28 }}>
                    {icon ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={icon} width={44} height={44} style={{ borderRadius: 12, marginRight: 16 }} />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 44, height: 44, borderRadius: 12, marginRight: 16, fontSize: 13, fontWeight: 700, ...tileColors(cashTicker) }}>
                        {cashTicker}
                      </div>
                    )}
                    <span style={{ width: 150, fontWeight: 700, color: c.text }}>{r.symbol}</span>
                    <span style={{ width: 120, color: c.dim }}>{venueName[r.venue]}</span>
                    <span style={{ width: 300, color: c.text }}>{usdCompact(r.collateralUsd)} pledged</span>
                    <span style={{ color: c.dim }}>Aero exit</span>
                    <span style={{ fontWeight: 700, color: c.text, marginLeft: 12 }}>{aeroExit(r.collateralUsd, r.capacityUsd)}</span>
                    <span style={{ color: c.dim, marginLeft: 10 }}>
                      · {r.capacityIsLowerBound ? '≈' : ''}
                      {usdCompact(r.capacityUsd)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        ) : (
          <span style={{ fontSize: 32, color: c.dim, marginTop: 48 }}>Lending data unavailable right now.</span>
        )}

        <CardFooter c={c} />
      </div>
    ),
    { ...OG_SIZE },
  );
}

/** /memes/<address>: the meme's 24h move next to its stock's, which is what that page is for. Never
 *  says "buy"; carries the same warning line as the page. */
/** A meme's logo from Dexscreener's CDN (the only host MemeRow.imageUrl allows) as a data URI, or
 *  null for the letter tile. PNG or JPEG only (what the card renderer draws), small, and quick. */
async function memeIconDataUri(url: string | null): Promise<string | null> {
  if (!url || !url.startsWith('https://cdn.dexscreener.com/')) return null;
  const work = (async () => {
    const res = await fetch(url.replace('format=auto', 'format=png'), { next: { revalidate: 6 * 60 * 60 }, signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    const bytes = Buffer.from(await res.arrayBuffer());
    const isPng = bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
    const isJpeg = bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!(isPng || isJpeg) || bytes.length > 300_000) return null;
    return `data:image/${isPng ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
  })();
  try {
    return await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000))]);
  } catch {
    return null;
  }
}

/** `frozen` is the row stored with a share (lib/shareSnapshot.ts), so the card says what the post says. */
export async function buildMemeOgImage(address: string, theme: CardTheme = 'dark', frozen?: MemeRow) {
  const c = PALETTES[theme];
  const row = frozen ?? (await getMemeRow(address).catch(() => null));
  if (!row) return null;
  const { meme, stockSymbol } = row.pool;
  const stockTicker = getStock(stockSymbol)?.cashTicker ?? stockSymbol;
  const [stockIcon, memeIcon] = await Promise.all([iconDataUri(stockTicker), memeIconDataUri(row.imageUrl)]);
  const moveColor = (n: number | null) => (n == null ? c.dim : n >= 0 ? c.pos : c.neg);

  return new ImageResponse(
    (
      <div style={frame(c)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Mark px={44} />
          <span style={{ fontSize: 40, fontWeight: 700, color: c.dim, letterSpacing: '-0.02em' }}>Afterbook · Memestocks</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', marginTop: 40 }}>
          {memeIcon ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={memeIcon} width={72} height={72} style={{ borderRadius: 18, marginRight: 22 }} />
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', width: 72, height: 72, borderRadius: 18, marginRight: 22, fontSize: 20, fontWeight: 700, ...tileColors(meme.symbol) }}>
              {meme.symbol.slice(0, 5)}
            </div>
          )}
          <span style={{ fontSize: 64, fontWeight: 700, color: c.text, letterSpacing: '-0.02em' }}>{meme.symbol}</span>
          <span style={{ fontSize: 34, color: c.dim, marginLeft: 18 }}>priced in {stockSymbol}</span>
        </div>

        {/* Both labels on one line, both numbers centred in one band of the same height. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', marginTop: 34, gap: 72 }}>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 26, color: c.dim }}>{meme.symbol}, 24h</span>
            <div style={{ display: 'flex', alignItems: 'center', height: 104 }}>
              <span style={{ fontSize: 88, fontWeight: 700, color: moveColor(row.move.h24), letterSpacing: '-0.03em' }}>{pctMove(row.move.h24)}</span>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <span style={{ fontSize: 26, color: c.dim }}>{stockSymbol}, 24h</span>
            <div style={{ display: 'flex', alignItems: 'center', height: 104 }}>
              {stockIcon && (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={stockIcon} width={56} height={56} style={{ borderRadius: 14, marginRight: 16 }} />
              )}
              <span style={{ fontSize: 64, fontWeight: 700, color: moveColor(row.stockMove.h24) }}>{pctMove(row.stockMove.h24)}</span>
            </div>
          </div>
        </div>

        <span style={{ fontSize: 26, color: c.dim, marginTop: 26 }}>
          {memePrice(row.priceUsd)} · {usdCompact(row.volume24Usd)} traded in 24h · {usdCompact(row.liquidityUsd)} liquidity on {venueLabel(row.pool.venue)}
        </span>
        <span style={{ fontSize: 22, color: c.dimmer, marginTop: 10 }}>Any memecoin can go to zero. The stock in the pool does not make the meme safer.</span>

        <CardFooter c={c} />
      </div>
    ),
    { ...OG_SIZE },
  );
}

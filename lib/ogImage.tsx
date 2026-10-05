import { BRAND_BLUE, MARK_BARS, MARK_CRESCENT } from '@/lib/brand';
import { ImageResponse } from 'next/og';
import { unstable_cache } from 'next/cache';
import { getOpenSnapStats, MIN_DAYS_FOR_OPEN_SNAP, STATS_LOOKBACK_MS } from './history';
import { getTokenIcons } from './coinbaseIcons';
import { tileHue } from './symbolStyle';
import { getTape } from './tape';
import { splitByLiquidity } from './liquidity';
import { buildTodaySnapshot } from './todaySnapshot';

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

// Shared by app/opengraph-image.tsx and app/twitter-image.tsx. Each of those
// files must locally re-declare `alt`/`size`/`contentType`/`dynamic` itself —
// Next's build-time static analysis for these special files doesn't follow
// re-exports (confirmed: it warned and silently fell back to defaults when
// twitter-image.tsx re-exported `runtime` from this module) — only the
// image-building logic itself is safe to share.
/**
 * Without `symbol`: the movers grid (up to 6 names), used for the root
 * share card. With `symbol`: a focused single-stock card for that name's
 * own page (app/[symbol]/opengraph-image.tsx) — same visual language, one
 * subject instead of six, so a tweet linking a specific name shows that
 * name's actual numbers instead of a generic grid it isn't part of.
 */
export async function buildOgImage(symbol?: string) {
  let rows: Awaited<ReturnType<typeof getTape>>['rows'] = [];
  let sessionLabel = '';
  let focusRow: Awaited<ReturnType<typeof getTape>>['rows'][number] | null = null;
  try {
    const tape = await getTape();
    sessionLabel = tape.session.label;

    if (symbol) {
      focusRow = tape.rows.find((r) => r.symbol.toLowerCase() === symbol.toLowerCase()) ?? null;
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
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            backgroundColor: '#121214',
            backgroundImage: 'linear-gradient(180deg, #171719 0%, #121214 60%)',
            padding: '64px 72px',
            fontFamily: 'sans-serif',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Mark px={44} />
            <span style={{ fontSize: 40, fontWeight: 700, color: '#8b93a1', letterSpacing: '-0.02em' }}>Afterbook</span>
            {sessionLabel && <span style={{ fontSize: 22, color: '#6b7280' }}>{sessionLabel}</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', marginTop: 20 }}>
            <StockIcon icon={icon} cashTicker={focusRow.cashTicker} />
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              <span style={{ fontSize: 64, fontWeight: 700, color: '#e6e9ef', letterSpacing: '-0.02em' }}>{focusRow.symbol}</span>
              <span style={{ fontSize: 24, color: '#8b93a1' }}>{focusRow.name}</span>
            </div>
          </div>

          <span
            style={{
              fontSize: 88,
              fontWeight: 700,
              marginTop: 8,
              color: focusRow.basisBp == null ? '#8b93a1' : focusRow.basisBp >= 0 ? '#3ddc97' : '#ff6b6b',
            }}
          >
            {bp(focusRow.basisBp)}
          </span>

          <div style={{ display: 'flex', gap: 32, marginTop: 12, fontSize: 28, color: '#8b93a1' }}>
            <span>cash {usd(focusRow.cashLastUsd)}</span>
            <span>aero {usd(focusRow.onchainMidUsd)}</span>
          </div>

          {fade && (
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 22 }}>
              <span style={{ fontSize: 28, color: '#e6e9ef' }}>{fade}</span>
              <span style={{ fontSize: 20, color: '#6b7280', marginTop: 6 }}>Past sessions, not a forecast.</span>
            </div>
          )}

          <div style={{ display: 'flex', marginTop: 'auto', fontSize: 20, color: '#9cd6ff' }}>
            No wallet connect. Execution stays on Aerodrome.
          </div>
        </div>
      ),
      { ...OG_SIZE },
    );
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#121214',
          backgroundImage: 'linear-gradient(180deg, #171719 0%, #121214 60%)',
          padding: '64px 72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <Mark px={68} />
            <span style={{ fontSize: 64, fontWeight: 700, color: '#e6e9ef', letterSpacing: '-0.02em' }}>
              Afterbook
            </span>
            {sessionLabel && <span style={{ fontSize: 24, color: '#8b93a1' }}>{sessionLabel}</span>}
          </div>
          <span style={{ fontSize: 26, color: '#8b93a1', marginTop: 8 }}>
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
                  backgroundColor: '#171719',
                  border: '1px solid #232830',
                  borderRadius: 16,
                  padding: '20px 16px',
                }}
              >
                <span style={{ fontSize: 22, fontWeight: 700, color: '#e6e9ef' }}>{row.symbol}</span>
                <span
                  style={{
                    fontSize: 27,
                    fontWeight: 700,
                    marginTop: 12,
                    color: row.basisBp == null ? '#8b93a1' : row.basisBp >= 0 ? '#3ddc97' : '#ff6b6b',
                  }}
                >
                  {bp(row.basisBp)}
                </span>
                <span style={{ fontSize: 14, color: '#8b93a1', marginTop: 8 }}>cash {usd(row.cashLastUsd)}</span>
                <span style={{ fontSize: 14, color: '#8b93a1' }}>aero {usd(row.onchainMidUsd)}</span>
              </div>
            ))}
          </div>
        )}

        <div style={{ display: 'flex', marginTop: 'auto', fontSize: 20, color: '#9cd6ff' }}>
          No wallet connect. Execution stays on Aerodrome.
        </div>
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
 *  movers grid, this always shows whichever single row currently has the
 *  largest |basis| (lib/todaySnapshot.ts), same "one screenshot stat" this
 *  page is built around. */
export async function buildTodayOgImage() {
  let sessionLabel = '';
  let headline: Awaited<ReturnType<typeof getTape>>['rows'][number] | null = null;
  let headlineBp: number | null = null;
  let marketOpen = false;
  let fade: string | null = null;
  let icon: string | null = null;
  try {
    const tape = await getTape();
    sessionLabel = tape.session.label;
    marketOpen = tape.session.state === 'open';
    const snapshot = buildTodaySnapshot(tape);
    headline = snapshot.headline;
    headlineBp = marketOpen ? headline?.basisBp ?? null : snapshot.headlineCloseBasisBp;
    if (headline) [fade, icon] = await Promise.all([openFadeLine(headline.symbol), iconDataUri(headline.cashTicker)]);
  } catch {
    // fall through to a branding-only card below
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          backgroundColor: '#121214',
          backgroundImage: 'linear-gradient(180deg, #171719 0%, #121214 60%)',
          padding: '64px 72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Mark px={44} />
          <span style={{ fontSize: 40, fontWeight: 700, color: '#8b93a1', letterSpacing: '-0.02em' }}>
            Afterbook · Biggest gap
          </span>
          {sessionLabel && <span style={{ fontSize: 22, color: '#6b7280' }}>{sessionLabel}</span>}
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
              <span style={{ fontSize: 64, fontWeight: 700, color: '#e6e9ef', letterSpacing: '-0.02em' }}>{headline.symbol}</span>
            </div>

            <span
              style={{
                fontSize: 88,
                fontWeight: 700,
                marginTop: 8,
                color: headlineBp == null ? '#8b93a1' : headlineBp >= 0 ? '#3ddc97' : '#ff6b6b',
              }}
            >
              {bp(headlineBp)}
            </span>

            <div style={{ display: 'flex', gap: 32, marginTop: 12, fontSize: 28, color: '#8b93a1' }}>
              <span>cash {usd(marketOpen ? headline.cashLastUsd : headline.closeUsd)}</span>
              <span>aero {usd(headline.onchainMidUsd)}</span>
            </div>

            {fade && (
              <div style={{ display: 'flex', flexDirection: 'column', marginTop: 22 }}>
                <span style={{ fontSize: 28, color: '#e6e9ef' }}>{fade}</span>
                <span style={{ fontSize: 20, color: '#6b7280', marginTop: 6 }}>Past sessions, not a forecast.</span>
              </div>
            )}
          </div>
        ) : (
          <span style={{ fontSize: 32, color: '#8b93a1', marginTop: 48 }}>No basis reading yet.</span>
        )}

        <div style={{ display: 'flex', marginTop: 'auto', fontSize: 20, color: '#9cd6ff' }}>
          No wallet connect. Execution stays on Aerodrome.
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}

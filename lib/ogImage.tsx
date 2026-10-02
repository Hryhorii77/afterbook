import { BRAND_BLUE, MARK_BARS, MARK_CRESCENT } from '@/lib/brand';
import { ImageResponse } from 'next/og';
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

export const OG_ALT = 'Afterbook — cash close vs the Aero book, in shares';
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

          <div style={{ display: 'flex', flexDirection: 'column', marginTop: 48 }}>
            <span style={{ fontSize: 88, fontWeight: 700, color: '#e6e9ef', letterSpacing: '-0.02em' }}>
              {focusRow.symbol}
            </span>
            <span style={{ fontSize: 24, color: '#8b93a1', marginTop: 4 }}>{focusRow.name}</span>
          </div>

          <span
            style={{
              fontSize: 100,
              fontWeight: 700,
              marginTop: 32,
              color: focusRow.basisBp == null ? '#8b93a1' : focusRow.basisBp >= 0 ? '#3ddc97' : '#ff6b6b',
            }}
          >
            {bp(focusRow.basisBp)}
          </span>

          <div style={{ display: 'flex', gap: 32, marginTop: 24, fontSize: 28, color: '#8b93a1' }}>
            <span>cash {usd(focusRow.cashLastUsd)}</span>
            <span>aero {usd(focusRow.onchainMidUsd)}</span>
          </div>

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
            Cash close vs the Aero book, in shares.
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
  try {
    const tape = await getTape();
    sessionLabel = tape.session.label;
    marketOpen = tape.session.state === 'open';
    const snapshot = buildTodaySnapshot(tape);
    headline = snapshot.headline;
    headlineBp = marketOpen ? headline?.basisBp ?? null : snapshot.headlineCloseBasisBp;
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
            <div style={{ display: 'flex', flexDirection: 'column', marginTop: 48 }}>
              <span style={{ fontSize: 24, color: '#8b93a1' }}>Biggest gap</span>
              <span style={{ fontSize: 72, fontWeight: 700, color: '#e6e9ef', letterSpacing: '-0.02em', marginTop: 4 }}>
                {headline.symbol}
              </span>
            </div>

            <span
              style={{
                fontSize: 100,
                fontWeight: 700,
                marginTop: 32,
                color: headlineBp == null ? '#8b93a1' : headlineBp >= 0 ? '#3ddc97' : '#ff6b6b',
              }}
            >
              {bp(headlineBp)}
            </span>

            <div style={{ display: 'flex', gap: 32, marginTop: 24, fontSize: 28, color: '#8b93a1' }}>
              <span>cash {usd(marketOpen ? headline.cashLastUsd : headline.closeUsd)}</span>
              <span>aero {usd(headline.onchainMidUsd)}</span>
            </div>
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

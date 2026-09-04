import { ImageResponse } from 'next/og';
import { getTape } from './tape';

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
export async function buildOgImage() {
  let rows: Awaited<ReturnType<typeof getTape>>['rows'] = [];
  let sessionLabel = '';
  try {
    const tape = await getTape();
    // Cards render in a single row — fine for 4 stocks, illegible for 10.
    // Show the biggest movers, not every symbol; that's also just a better
    // social card than an exhaustive list.
    rows = [...tape.rows].sort((a, b) => Math.abs(b.basisBp ?? 0) - Math.abs(a.basisBp ?? 0)).slice(0, 6);
    sessionLabel = tape.session.label;
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
          backgroundColor: '#0b0d10',
          backgroundImage: 'linear-gradient(180deg, #12151a 0%, #0b0d10 60%)',
          padding: '64px 72px',
          fontFamily: 'sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
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
                  backgroundColor: '#12151a',
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

        <div style={{ display: 'flex', marginTop: 'auto', fontSize: 20, color: '#5b8cff' }}>
          No wallet connect. Execution stays on Aerodrome.
        </div>
      </div>
    ),
    { ...OG_SIZE },
  );
}

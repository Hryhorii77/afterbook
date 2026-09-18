interface LiquidityBucket {
  tickLower: number;
  tickUpper: number;
  priceLowerUsd: number;
  priceUpperUsd: number;
  liquidity: string;
}

interface DepthChartProps {
  buckets: LiquidityBucket[];
  currentPriceUsd: number;
}

const WIDTH = 600;
const HEIGHT = 160;
const PAD_LEFT = 12;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

const usdShort = (n: number) => (n >= 1_000 ? `$${(n / 1_000).toFixed(1)}k` : `$${n.toFixed(0)}`);

/**
 * Bar histogram of active on-chain liquidity across the price window
 * lib/depth.ts scanned around the current tick — where LP support/
 * resistance walls actually sit, not just today's single-tick depth. Same
 * plain-SVG, no-chart-library approach as ImpactCurve.tsx.
 */
export function DepthChart({ buckets, currentPriceUsd }: DepthChartProps) {
  if (buckets.length === 0) return null;

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  // Named by screen position, not magnitude: buckets are tick-ascending, and
  // USD price falls as tick rises (lib/depth.ts's convention, token0=USDC),
  // so leftPriceUsd is the *larger* number. xPos below is still a plain
  // affine map between the two, sign included, so this reads correctly
  // either way — the naming just avoids implying leftPriceUsd < rightPriceUsd.
  const leftPriceUsd = buckets[0].priceUpperUsd;
  const rightPriceUsd = buckets[buckets.length - 1].priceLowerUsd;
  const maxLiquidity = Math.max(...buckets.map((b) => Number(b.liquidity))) || 1;

  const xPos = (priceUsd: number) => PAD_LEFT + ((priceUsd - leftPriceUsd) / (rightPriceUsd - leftPriceUsd || 1)) * plotW;
  const barHeight = (liquidity: string) => (Number(liquidity) / maxLiquidity) * plotH;

  const curX = xPos(currentPriceUsd);
  const priceTicks = [leftPriceUsd, (leftPriceUsd + rightPriceUsd) / 2, rightPriceUsd];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="depth-chart" role="img" aria-label="Liquidity depth by price">
      {buckets.map((b) => {
        const x0 = xPos(b.priceLowerUsd);
        const x1 = xPos(b.priceUpperUsd);
        const h = barHeight(b.liquidity);
        const isActive = currentPriceUsd >= b.priceLowerUsd && currentPriceUsd <= b.priceUpperUsd;
        return (
          <rect
            key={b.tickLower}
            x={Math.min(x0, x1)}
            y={PAD_TOP + plotH - h}
            width={Math.max(Math.abs(x1 - x0), 0.5)}
            height={h}
            className={isActive ? 'depth-bar depth-bar-active' : 'depth-bar'}
          />
        );
      })}

      <line x1={curX} y1={PAD_TOP} x2={curX} y2={PAD_TOP + plotH} className="curve-current-line" />

      {priceTicks.map((v, i) => (
        <text
          key={i}
          x={xPos(v)}
          y={HEIGHT - 6}
          className="curve-tick"
          textAnchor={i === 0 ? 'start' : i === priceTicks.length - 1 ? 'end' : 'middle'}
        >
          {usdShort(v)}
        </text>
      ))}
    </svg>
  );
}

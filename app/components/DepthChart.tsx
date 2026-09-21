'use client';

import { useRef, useState } from 'react';

interface LiquidityBucket {
  tickLower: number;
  tickUpper: number;
  priceLowerUsd: number;
  priceUpperUsd: number;
  liquidity: string;
}

interface SelectedRange {
  lowUsd: number;
  highUsd: number;
}

interface DepthChartProps {
  buckets: LiquidityBucket[];
  currentPriceUsd: number;
  /** Presence of both makes the chart interactive — drag handles to pick an
   *  LP range. Omit either to render the plain (non-interactive) chart. */
  selectedRange?: SelectedRange;
  onRangeChange?: (range: SelectedRange) => void;
  /** Gates whether the handles actually attach drag listeners, independent
   *  of selectedRange/onRangeChange being present — lets a caller keep the
   *  range visible while requiring an explicit opt-in before touch input on
   *  the chart gets captured as a drag instead of a page scroll. Defaults
   *  to true so existing callers (desktop, where this conflict doesn't
   *  exist) are unaffected. */
  dragEnabled?: boolean;
}

const WIDTH = 600;
const HEIGHT = 160;
const PAD_LEFT = 12;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;
// Minimum gap between handles, in price-ratio terms, so a drag can't
// collapse the range to zero width (capitalEfficiencyMultiplier would blow
// up / divide by ~0 right at that point anyway).
const MIN_RANGE_RATIO = 1.001;

const usdShort = (n: number) => (n >= 1_000 ? `$${(n / 1_000).toFixed(1)}k` : `$${n.toFixed(0)}`);

/**
 * Bar histogram of active on-chain liquidity across the price window
 * lib/depth.ts scanned around the current tick — where LP support/
 * resistance walls actually sit, not just today's single-tick depth. Same
 * plain-SVG, no-chart-library approach as ImpactCurve.tsx.
 *
 * Optionally interactive: pass selectedRange + onRangeChange to overlay two
 * draggable bound handles, for picking an LP range directly on the curve.
 */
export function DepthChart({ buckets, currentPriceUsd, selectedRange, onRangeChange, dragEnabled = true }: DepthChartProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<'low' | 'high' | null>(null);

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
  const priceFromX = (svgX: number) => leftPriceUsd + ((svgX - PAD_LEFT) / plotW) * (rightPriceUsd - leftPriceUsd);
  const barHeight = (liquidity: string) => (Number(liquidity) / maxLiquidity) * plotH;

  const curX = xPos(currentPriceUsd);
  const priceTicks = [leftPriceUsd, (leftPriceUsd + rightPriceUsd) / 2, rightPriceUsd];

  // hasRange: whether there's a selection to render at all. interactive:
  // whether that selection's handles currently accept drag input. Kept
  // separate so a selected range stays visible (fill + handle lines) while
  // dragEnabled is off — only the actual drag capture is gated, not the
  // display of what's already selected.
  const hasRange = selectedRange != null && onRangeChange != null;
  const interactive = hasRange && dragEnabled;

  const clientXToSvgX = (clientX: number): number | null => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return null;
    return ((clientX - rect.left) / rect.width) * WIDTH;
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!dragging || !selectedRange || !onRangeChange) return;
    const svgX = clientXToSvgX(e.clientX);
    if (svgX == null) return;
    // Clamp to the chart's own visible price window — dragging off-screen
    // shouldn't pick a range outside what the histogram even shows.
    const clampedX = Math.max(PAD_LEFT, Math.min(WIDTH - PAD_RIGHT, svgX));
    const price = priceFromX(clampedX);

    if (dragging === 'low') {
      // Also clamp to currentPriceUsd, not just the other handle — otherwise
      // both handles can end up on the same side of current price, a range
      // capitalEfficiencyMultiplier/computeInRangeProbabilityPct correctly
      // refuse to score (this formula assumes price is bracketed) but that
      // just silently blanks the metrics rather than stopping the drag.
      const maxLow = Math.min(selectedRange.highUsd / MIN_RANGE_RATIO, currentPriceUsd);
      onRangeChange({ lowUsd: Math.min(price, maxLow), highUsd: selectedRange.highUsd });
    } else {
      const minHigh = Math.max(selectedRange.lowUsd * MIN_RANGE_RATIO, currentPriceUsd);
      onRangeChange({ lowUsd: selectedRange.lowUsd, highUsd: Math.max(price, minHigh) });
    }
  };

  const startDrag = (handle: 'low' | 'high') => (e: React.PointerEvent<SVGGElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(handle);
  };
  const endDrag = () => setDragging(null);

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      className="depth-chart"
      role="img"
      aria-label={interactive ? 'Liquidity depth by price, with a draggable LP range selector' : 'Liquidity depth by price'}
      onPointerMove={interactive ? handlePointerMove : undefined}
      onPointerUp={interactive ? endDrag : undefined}
      onPointerCancel={interactive ? endDrag : undefined}
      // Only suppress the browser's own touch gestures (scroll, pinch-zoom)
      // while a drag is actually possible — otherwise a finger landing on
      // the chart to scroll the page gets captured as a range edit instead.
      style={{ touchAction: interactive ? 'none' : 'auto' }}
    >
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

      {hasRange && selectedRange && (
        <rect
          x={Math.min(xPos(selectedRange.lowUsd), xPos(selectedRange.highUsd))}
          y={PAD_TOP}
          width={Math.abs(xPos(selectedRange.highUsd) - xPos(selectedRange.lowUsd))}
          height={plotH}
          className="range-select-fill"
        />
      )}

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

      {hasRange && selectedRange && (
        <>
          {(['low', 'high'] as const).map((handle) => {
            const x = xPos(handle === 'low' ? selectedRange.lowUsd : selectedRange.highUsd);
            return (
              <g
                key={handle}
                // Not attached at all when non-interactive — leaving this
                // handler in place but a no-op would still call
                // setPointerCapture() on touchstart below and hijack the
                // page-scroll gesture even though nothing would then move.
                onPointerDown={interactive ? startDrag(handle) : undefined}
                className={
                  !interactive ? 'range-handle range-handle-static' : dragging === handle ? 'range-handle range-handle-active' : 'range-handle'
                }
              >
                {/* Wide invisible hit area — the visible line alone is too thin to grab reliably, especially on touch. */}
                <rect x={x - 10} y={PAD_TOP} width={20} height={plotH} fill="transparent" />
                <line x1={x} y1={PAD_TOP} x2={x} y2={PAD_TOP + plotH} className="range-handle-line" />
                <rect x={x - 5} y={PAD_TOP - 8} width={10} height={8} rx={2} className="range-handle-grip" />
              </g>
            );
          })}
        </>
      )}
    </svg>
  );
}

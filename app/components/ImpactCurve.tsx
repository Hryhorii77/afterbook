interface CurvePoint {
  usdcIn: number;
  impactBp: number;
  sharesOut: number;
  largeTradeCaveat: boolean;
}

interface ImpactCurveProps {
  points: CurvePoint[];
  currentUsdcIn: number;
  currentImpactBp: number;
}

const WIDTH = 600;
const HEIGHT = 180;
const PAD_LEFT = 42;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 24;

const usdShort = (n: number) => (n >= 1_000_000 ? `$${n / 1_000_000}M` : n >= 1_000 ? `$${n / 1_000}k` : `$${n}`);

export function ImpactCurve({ points, currentUsdcIn, currentImpactBp }: ImpactCurveProps) {
  if (points.length < 2) return null;

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const minX = Math.min(points[0].usdcIn, currentUsdcIn);
  const maxX = Math.max(points[points.length - 1].usdcIn, currentUsdcIn);
  const logMin = Math.log10(minX);
  const logMax = Math.log10(maxX);
  const maxY = Math.max(...points.map((p) => p.impactBp), currentImpactBp) * 1.15 || 1;

  const xPos = (usdcIn: number) => PAD_LEFT + ((Math.log10(usdcIn) - logMin) / (logMax - logMin || 1)) * plotW;
  const yPos = (impactBp: number) => PAD_TOP + plotH - (Math.max(impactBp, 0) / maxY) * plotH;

  const pathD = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xPos(p.usdcIn).toFixed(1)} ${yPos(p.impactBp).toFixed(1)}`).join(' ');

  const firstCaveatIdx = points.findIndex((p) => p.largeTradeCaveat);
  const caveatX = firstCaveatIdx >= 0 ? xPos(points[firstCaveatIdx].usdcIn) : null;

  const xTicks = [1_000, 10_000, 100_000, 1_000_000].filter((v) => v >= minX * 0.9 && v <= maxX * 1.1);

  const curX = xPos(currentUsdcIn);
  const curY = yPos(currentImpactBp);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="impact-curve" role="img" aria-label="Price impact by trade size">
      {/* y=0 baseline */}
      <line x1={PAD_LEFT} y1={yPos(0)} x2={WIDTH - PAD_RIGHT} y2={yPos(0)} className="curve-axis" />

      {caveatX != null && (
        <rect x={caveatX} y={PAD_TOP} width={WIDTH - PAD_RIGHT - caveatX} height={plotH} className="curve-caveat-zone" />
      )}

      <path d={pathD} className="curve-line" fill="none" />

      {points.map((p) => (
        <circle key={p.usdcIn} cx={xPos(p.usdcIn)} cy={yPos(p.impactBp)} r={3} className={p.largeTradeCaveat ? 'curve-dot curve-dot-caveat' : 'curve-dot'} />
      ))}

      {/* current amount marker */}
      <line x1={curX} y1={PAD_TOP} x2={curX} y2={PAD_TOP + plotH} className="curve-current-line" />
      <circle cx={curX} cy={curY} r={5} className="curve-current-dot" />

      {xTicks.map((v) => (
        <text key={v} x={xPos(v)} y={HEIGHT - 6} className="curve-tick" textAnchor="middle">
          {usdShort(v)}
        </text>
      ))}
      <text x={PAD_LEFT - 6} y={PAD_TOP + 4} className="curve-tick" textAnchor="end">
        {maxY.toFixed(0)}bp
      </text>
      <text x={PAD_LEFT - 6} y={yPos(0)} className="curve-tick" textAnchor="end">
        0bp
      </text>
    </svg>
  );
}

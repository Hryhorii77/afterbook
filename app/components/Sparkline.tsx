interface HistorySample {
  ts: number;
  basisBp: number;
}

interface SparklineProps {
  samples: HistorySample[];
}

const WIDTH = 600;
const HEIGHT = 120;
const PAD_LEFT = 44;
const PAD_RIGHT = 12;
const PAD_TOP = 12;
const PAD_BOTTOM = 20;

// Weekday is required, not decorative: a weekend-spanning window (the whole
// point of this chart) crosses midnight, so hour:minute alone can label two
// points on different days with the same or a lower-looking minute value —
// reading as if time ran backward even though the data is correctly ordered.
const timeLabel = (ts: number) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(
    new Date(ts),
  ) + ' ET';

export function Sparkline({ samples }: SparklineProps) {
  if (samples.length < 2) return null;

  const plotW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const plotH = HEIGHT - PAD_TOP - PAD_BOTTOM;

  const minTs = samples[0].ts;
  const maxTs = samples[samples.length - 1].ts;
  const values = samples.map((s) => s.basisBp);
  const maxAbs = Math.max(Math.max(...values.map(Math.abs)), 1) * 1.15;

  const xPos = (ts: number) => PAD_LEFT + ((ts - minTs) / (maxTs - minTs || 1)) * plotW;
  const yPos = (basisBp: number) => PAD_TOP + plotH / 2 - (basisBp / maxAbs) * (plotH / 2);

  const pathD = samples.map((s, i) => `${i === 0 ? 'M' : 'L'} ${xPos(s.ts).toFixed(1)} ${yPos(s.basisBp).toFixed(1)}`).join(' ');
  const last = samples[samples.length - 1];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} className="sparkline" role="img" aria-label="Basis vs cash close over time">
      <line x1={PAD_LEFT} y1={yPos(0)} x2={WIDTH - PAD_RIGHT} y2={yPos(0)} className="curve-axis" />

      <path d={pathD} className="curve-line" fill="none" />

      <circle cx={xPos(last.ts)} cy={yPos(last.basisBp)} r={4} className="curve-current-dot" />

      <text x={PAD_LEFT} y={HEIGHT - 4} className="curve-tick" textAnchor="start">
        {timeLabel(minTs)}
      </text>
      <text x={WIDTH - PAD_RIGHT} y={HEIGHT - 4} className="curve-tick" textAnchor="end">
        {timeLabel(maxTs)}
      </text>
      <text x={PAD_LEFT - 6} y={yPos(0)} className="curve-tick" textAnchor="end">
        0bp
      </text>
    </svg>
  );
}

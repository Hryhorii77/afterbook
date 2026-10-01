import { useId } from 'react';

// Price trend for a table row: no axes, a soft area fill under the line,
// coloured by whether the last point is above the first, with a dot on the
// latest value.
export function MiniSpark({ values, label = 'Price trend' }: { values: number[] | undefined; label?: string }) {
  const gid = useId();
  if (!values || values.length < 2) return <span className="mini-spark-empty">—</span>;
  const W = 120;
  const H = 36;
  const PAD = 4;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const up = values[values.length - 1] >= values[0];
  const line = values.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(values.length - 1).toFixed(1)} ${H} L ${x(0).toFixed(1)} ${H} Z`;
  return (
    <svg className={`mini-spark ${up ? 'mini-spark-up' : 'mini-spark-down'}`} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${label}: ${up ? 'up' : 'down'}`}>
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} stroke="none" />
      <path d={line} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(values.length - 1)} cy={y(values[values.length - 1])} r="2.8" fill="currentColor" />
    </svg>
  );
}

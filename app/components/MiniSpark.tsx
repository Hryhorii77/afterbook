import { useId } from 'react';

// Price trend for a table row: no axes, a soft area fill under the line,
// coloured by whether the last point is above the first, with a dot on the
// latest value.
export function MiniSpark({ values, label = 'Price trend' }: { values: (number | null)[] | undefined; label?: string }) {
  const gid = useId();
  // Slots before a token's first sample are null: they stay blank, so a short history
  // sits at the right of the shared time axis instead of being stretched across it.
  const present = (values ?? []).flatMap((v, i) => (v == null ? [] : [{ v, i }]));
  if (!values || present.length < 2) return <span className="mini-spark-empty">—</span>;
  const W = 120;
  const H = 36;
  const PAD = 4;
  const nums = present.map((p) => p.v);
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  const span = max - min || 1;
  const x = (i: number) => PAD + (i / (values.length - 1)) * (W - PAD * 2);
  const y = (v: number) => H - PAD - ((v - min) / span) * (H - PAD * 2);
  const up = nums[nums.length - 1] >= nums[0];
  const line = present.map((p, k) => `${k === 0 ? 'M' : 'L'} ${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
  const first = present[0];
  const last = present[present.length - 1];
  const area = `${line} L ${x(last.i).toFixed(1)} ${H} L ${x(first.i).toFixed(1)} ${H} Z`;
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
      <circle cx={x(last.i)} cy={y(last.v)} r="2.8" fill="currentColor" />
    </svg>
  );
}
